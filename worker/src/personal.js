// Everything a signed-in person sees or owns: the calendar list, their toggles,
// their private events and their private calendar links. Every query is scoped by user.email.

import { fail, json, readJson } from "./lib/http.js";
import * as v from "./lib/validate.js";
import { LIMITS, getSettings, devMode, ROLE_LABEL } from "./settings.js";
import { detectSource, downloadIcs, dropCache, feedResponse, getFeed } from "./feeds.js";

const addDaysIso = (date, n) => new Date(Date.parse(date + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);

function hostOf(url) {
  if (url.startsWith("sample:")) return "sample calendar";
  try { return new URL(url).hostname; } catch { return ""; }
}

const sharedPublic = (c) => ({
  id: c.id, name: c.name, color: c.color, source: c.source, owner: c.owner,
  defaultOn: !!c.default_on, audience: c.audience,
});
const feedPublic = (f) => ({ id: f.id, name: f.name, color: f.color, source: f.source, host: hostOf(f.url) });

/** GET /api/bootstrap — everything the app needs on load. Shared calendar links are never included. */
export async function bootstrap(req, env, ctx, user) {
  const [cals, feeds, prefs] = await env.DB.batch([
    env.DB.prepare("SELECT id, name, color, source, owner, default_on, audience FROM calendars ORDER BY sort_order, id"),
    env.DB.prepare("SELECT id, name, color, url, source FROM personal_feeds WHERE email = ? ORDER BY id").bind(user.email),
    env.DB.prepare("SELECT visible FROM user_prefs WHERE email = ?").bind(user.email),
  ]);
  const settings = await getSettings(env);
  let visible = {};
  try { visible = JSON.parse(prefs.results[0]?.visible || "{}"); } catch { /* start fresh */ }
  return json({
    me: { email: user.email, name: user.name, role: user.role, roleLabel: ROLE_LABEL[user.role], isAdmin: user.isAdmin, isSuper: user.isSuper },
    site: { title: settings.site_title, devMode: devMode(env) },
    calendars: cals.results.map(sharedPublic),
    myFeeds: feeds.results.map(feedPublic),
    visible,
  });
}

/** PUT /api/prefs {visible: {"shared:3": false, "mine": true, "feed:2": true}} */
export async function savePrefs(req, env, ctx, user) {
  const body = await readJson(req, 16 * 1024);
  const src = body.visible;
  if (!src || typeof src !== "object" || Array.isArray(src)) fail(400, "Invalid choices.");
  const visible = {};
  for (const [k, val] of Object.entries(src).slice(0, 200)) {
    if (/^(shared:\d{1,9}|feed:\d{1,9}|mine)$/.test(k)) visible[k] = !!val;
  }
  await env.DB.prepare(
    `INSERT INTO user_prefs (email, visible, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET visible = excluded.visible, updated_at = excluded.updated_at`,
  ).bind(user.email, JSON.stringify(visible), Date.now()).run();
  return json({ ok: true, visible });
}

/* ---------- feeds ---------- */

/** GET /api/feeds/shared/:id — any signed-in person. */
export async function sharedFeed(req, env, ctx, user, params) {
  const cal = await env.DB.prepare("SELECT id, name, url, audience FROM calendars WHERE id = ?").bind(v.id(params.id)).first();
  if (!cal) fail(404, "That calendar was removed.");
  try { return feedResponse(await getFeed(env, ctx, `shared:${cal.id}`, cal.url)); }
  catch (err) { fail(502, `Couldn't load ${cal.name} right now: ${err.message}.`); }
}

/* ---------- the public front page (no sign-in) ---------- */

// Browsers may keep public answers for 5 minutes, so a busy day costs few Worker requests.
const PUBLIC_CACHE = { "cache-control": "public, max-age=300" };

/** GET /api/public — site title and the calendars marked "Public". */
export async function publicInfo(req, env) {
  const { results } = await env.DB.prepare(
    "SELECT id, name, color, source, owner FROM calendars WHERE audience = 'public' ORDER BY sort_order, id",
  ).all();
  const s = await getSettings(env);
  return json({
    site: { title: s.site_title, tagline: s.public_tagline || "" },
    calendars: results.map((c) => ({ id: c.id, name: c.name, color: c.color, source: c.source, owner: c.owner })),
  }, 200, PUBLIC_CACHE);
}

/** GET /api/public/feeds/:id — events of a public calendar. */
export async function publicFeed(req, env, ctx, user, params) {
  const cal = await env.DB.prepare("SELECT id, name, url FROM calendars WHERE id = ? AND audience = 'public'").bind(v.id(params.id)).first();
  if (!cal) fail(404, "That calendar isn't public.");
  try {
    const res = feedResponse(await getFeed(env, ctx, `shared:${cal.id}`, cal.url));
    res.headers.set("cache-control", PUBLIC_CACHE["cache-control"]);
    return res;
  } catch (err) { fail(502, `Couldn't load ${cal.name} right now.`); }
}

/** GET /api/feeds/mine/:id — only the owner. */
export async function myFeed(req, env, ctx, user, params) {
  const f = await env.DB.prepare("SELECT id, name, url FROM personal_feeds WHERE id = ? AND email = ?").bind(v.id(params.id), user.email).first();
  if (!f) fail(404, "Not found.");
  try { return feedResponse(await getFeed(env, ctx, `mine:${f.id}`, f.url)); }
  catch (err) { fail(502, `Couldn't load ${f.name} right now: ${err.message}.`); }
}

/* ---------- personal events ---------- */

const EVENT_COLS = "id, title, date, all_day, start_time, end_time, location, notes, repeat_weekly, repeat_until, color, updated_at";

function eventOut(r) {
  return {
    id: r.id, title: r.title, date: r.date, allDay: !!r.all_day, startTime: r.start_time, endTime: r.end_time,
    location: r.location, notes: r.notes, repeatWeekly: !!r.repeat_weekly, repeatUntil: r.repeat_until, color: r.color,
  };
}

function eventIn(body) {
  const e = {
    title: v.text(body.title, "Title", 200, { required: true }),
    date: v.date(body.date, "Date"),
    allDay: v.bool(body.allDay),
    startTime: null, endTime: null,
    location: v.text(body.location, "Location", 200),
    notes: v.text(body.notes, "Notes", 2000, { multiline: true }),
    repeatWeekly: v.bool(body.repeatWeekly),
    repeatUntil: null,
    color: v.color(body.color || "#0E7C86"),
  };
  if (!e.allDay) {
    e.startTime = v.time(body.startTime, "Start time");
    e.endTime = v.time(body.endTime, "End time");
    if (e.endTime <= e.startTime) fail(400, "The end time must be after the start time.");
  }
  if (e.repeatWeekly) {
    e.repeatUntil = v.date(body.repeatUntil, "Repeat until");
    if (e.repeatUntil < e.date) fail(400, "“Repeat until” must be on or after the event date.");
    if (e.repeatUntil > addDaysIso(e.date, 731)) fail(400, "Weekly repeats can last up to 2 years.");
  }
  return e;
}

const eventBinds = (e) => [e.title, e.date, e.allDay ? 1 : 0, e.startTime, e.endTime, e.location, e.notes, e.repeatWeekly ? 1 : 0, e.repeatUntil, e.color];

export async function listEvents(req, env, ctx, user) {
  const { results } = await env.DB.prepare(`SELECT ${EVENT_COLS} FROM personal_events WHERE email = ? ORDER BY date LIMIT 2000`).bind(user.email).all();
  return json({ events: results.map(eventOut) });
}

export async function createEvent(req, env, ctx, user) {
  const e = eventIn(await readJson(req));
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM personal_events WHERE email = ?").bind(user.email).first("n");
  if (count >= LIMITS.MAX_EVENTS_PER_USER) fail(400, `You can have up to ${LIMITS.MAX_EVENTS_PER_USER} events. Delete some old ones first.`);
  const now = Date.now();
  const row = await env.DB.prepare(
    `INSERT INTO personal_events (email, title, date, all_day, start_time, end_time, location, notes, repeat_weekly, repeat_until, color, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${EVENT_COLS}`,
  ).bind(user.email, ...eventBinds(e), now, now).first();
  return json({ event: eventOut(row) }, 201);
}

export async function updateEvent(req, env, ctx, user, params) {
  const id = v.id(params.id);
  const e = eventIn(await readJson(req));
  const row = await env.DB.prepare(
    `UPDATE personal_events SET title = ?, date = ?, all_day = ?, start_time = ?, end_time = ?, location = ?, notes = ?,
       repeat_weekly = ?, repeat_until = ?, color = ?, updated_at = ?
     WHERE id = ? AND email = ? RETURNING ${EVENT_COLS}`,
  ).bind(...eventBinds(e), Date.now(), id, user.email).first();
  if (!row) fail(404, "Not found.");
  return json({ event: eventOut(row) });
}

export async function deleteEvent(req, env, ctx, user, params) {
  const r = await env.DB.prepare("DELETE FROM personal_events WHERE id = ? AND email = ?").bind(v.id(params.id), user.email).run();
  if (!r.meta.changes) fail(404, "Not found.");
  return json({ ok: true });
}

/* ---------- personal calendar links ---------- */

export async function listMyFeeds(req, env, ctx, user) {
  const { results } = await env.DB.prepare("SELECT id, name, color, url, source FROM personal_feeds WHERE email = ? ORDER BY id").bind(user.email).all();
  return json({ feeds: results.map(feedPublic) });
}

export async function createMyFeed(req, env, ctx, user) {
  const body = await readJson(req);
  const url = v.feedUrl(body.url, { allowSamples: devMode(env) });
  const name = v.text(body.name, "Name", 80, { required: true });
  const color = v.color(body.color || "#6B7280");
  const src = v.source(body.source) || detectSource(url);
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM personal_feeds WHERE email = ?").bind(user.email).first("n");
  if (count >= LIMITS.MAX_FEEDS_PER_USER) fail(400, `You can add up to ${LIMITS.MAX_FEEDS_PER_USER} calendar links.`);
  const warning = await checkLink(env, url);
  const row = await env.DB.prepare(
    "INSERT INTO personal_feeds (email, name, color, url, source, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id, name, color, url, source",
  ).bind(user.email, name, color, url, src, Date.now()).first();
  return json({ feed: feedPublic(row), warning }, 201);
}

/** Refuse links that are clearly wrong; accept (with a warning) ones whose server is only busy right now. */
async function checkLink(env, url) {
  try { await downloadIcs(env, url); return null; }
  catch (err) {
    if (err.temporary) return `Saved, but ${err.message}. It will show up once the calendar answers; we'll keep trying.`;
    fail(400, `That link didn't work: ${err.message}.`);
  }
}

export async function updateMyFeed(req, env, ctx, user, params) {
  const id = v.id(params.id);
  const body = await readJson(req);
  const cur = await env.DB.prepare("SELECT id, url FROM personal_feeds WHERE id = ? AND email = ?").bind(id, user.email).first();
  if (!cur) fail(404, "Not found.");
  let url = cur.url, warning = null;
  if (body.url) {
    url = v.feedUrl(body.url, { allowSamples: devMode(env) });
    if (url !== cur.url) warning = await checkLink(env, url);
  }
  const row = await env.DB.prepare(
    "UPDATE personal_feeds SET name = ?, color = ?, url = ?, source = ? WHERE id = ? AND email = ? RETURNING id, name, color, url, source",
  ).bind(v.text(body.name, "Name", 80, { required: true }), v.color(body.color), url, v.source(body.source) || detectSource(url), id, user.email).first();
  if (url !== cur.url) await dropCache(env, `mine:${id}`).run();
  return json({ feed: feedPublic(row), warning });
}

export async function deleteMyFeed(req, env, ctx, user, params) {
  const id = v.id(params.id);
  const r = await env.DB.prepare("DELETE FROM personal_feeds WHERE id = ? AND email = ?").bind(id, user.email).run();
  if (!r.meta.changes) fail(404, "Not found.");
  await dropCache(env, `mine:${id}`).run();
  return json({ ok: true });
}
