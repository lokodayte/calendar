// Admin-only endpoints. The router checks user.isAdmin before any of these run.

import { fail, json, readJson } from "./lib/http.js";
import * as v from "./lib/validate.js";
import { LIMITS, adminEmails, getSettings, devMode } from "./settings.js";
import { detectSource, downloadIcs, dropCache, summarizeIcs } from "./feeds.js";
import { sendEmail, welcomeEmail } from "./email.js";
import { normalizeCoverage } from "../../public/js/coverage.js";

const logStmt = (env, actor, action, detail) =>
  env.DB.prepare("INSERT INTO admin_log (at, actor, action, detail) VALUES (?, ?, ?, ?)").bind(Date.now(), actor, action, String(detail).slice(0, 1000));

const list = (xs, max = 5) => (xs.length > max ? `${xs.slice(0, max).join(", ")} and ${xs.length - max} more` : xs.join(", "));

/* ---------- staff ---------- */

export async function listStaff(req, env) {
  const now = Date.now();
  const [staff, devices] = await env.DB.batch([
    env.DB.prepare("SELECT email, added_at, added_by, last_sign_in FROM staff ORDER BY email"),
    env.DB.prepare("SELECT email, COUNT(*) AS n FROM sessions WHERE expires_at > ? GROUP BY email").bind(now),
  ]);
  const counts = new Map(devices.results.map((r) => [r.email, r.n]));
  const admins = adminEmails(env);
  const rows = staff.results.map((r) => ({
    email: r.email, addedAt: r.added_at, addedBy: r.added_by, lastSignIn: r.last_sign_in,
    devices: counts.get(r.email) || 0, isAdmin: admins.includes(r.email),
  }));
  for (const a of admins) if (!rows.some((r) => r.email === a)) rows.push({ email: a, addedAt: null, lastSignIn: null, devices: counts.get(a) || 0, isAdmin: true });
  return json({ staff: rows.sort((a, b) => a.email.localeCompare(b.email)) });
}

/** POST {emails: "pasted text", welcome: bool} */
export async function addStaff(req, env, ctx, user) {
  const body = await readJson(req, 64 * 1024);
  const emails = v.emailsFromText(body.emails).filter(v.isEmail);
  if (!emails.length) fail(400, "No email addresses found. Paste one or more addresses.");
  if (emails.length > LIMITS.MAX_STAFF_PER_PASTE) fail(400, `Add up to ${LIMITS.MAX_STAFF_PER_PASTE} people at a time.`);
  const welcome = v.bool(body.welcome);
  if (welcome && emails.length > LIMITS.MAX_WELCOME_EMAILS) fail(400, `Welcome emails can go to up to ${LIMITS.MAX_WELCOME_EMAILS} people at a time. Add fewer people, or untick “Send welcome email”.`);
  const now = Date.now();
  const results = await env.DB.batch(emails.map((e) =>
    env.DB.prepare("INSERT OR IGNORE INTO staff (email, added_at, added_by) VALUES (?, ?, ?)").bind(e, now, user.email)));
  const added = emails.filter((_, i) => results[i].meta.changes > 0);
  const already = emails.filter((_, i) => !results[i].meta.changes);
  if (added.length) await logStmt(env, user.email, "staff.add", `Added ${added.length} staff: ${list(added)}`).run();

  let welcomed = 0, welcomeFailed = 0;
  if (welcome && added.length) {
    const s = await getSettings(env);
    const mail = welcomeEmail(s.site_title, env.SITE_URL);
    for (const to of added) (await sendEmail(env, s.sender_name, { to, ...mail })) ? welcomed++ : welcomeFailed++;
  }
  return json({ added, already, welcomed, welcomeFailed });
}

export async function removeStaff(req, env, ctx, user, params) {
  const email = v.normEmail(decodeURIComponent(params.email));
  if (adminEmails(env).includes(email)) fail(400, "This person is an admin (set in ADMIN_EMAILS in wrangler.toml). Remove them there first.");
  const [del, sess] = await env.DB.batch([
    env.DB.prepare("DELETE FROM staff WHERE email = ?").bind(email),
    env.DB.prepare("DELETE FROM sessions WHERE email = ?").bind(email),
    env.DB.prepare("DELETE FROM login_codes WHERE email = ?").bind(email),
  ]);
  if (!del.meta.changes) fail(404, "That person isn't on the staff list.");
  await logStmt(env, user.email, "staff.remove", `Removed ${email} (signed out of ${sess.meta.changes} device${sess.meta.changes === 1 ? "" : "s"})`).run();
  return json({ ok: true, devicesSignedOut: sess.meta.changes });
}

export async function listSessions(req, env, ctx, user, params) {
  const email = v.normEmail(decodeURIComponent(params.email));
  const { results } = await env.DB.prepare(
    "SELECT id, device, created_at, last_seen, expires_at FROM sessions WHERE email = ? AND expires_at > ? ORDER BY last_seen DESC",
  ).bind(email, Date.now()).all();
  return json({ sessions: results.map((r) => ({ id: r.id, device: r.device || "Unknown device", createdAt: r.created_at, lastSeen: r.last_seen, expiresAt: r.expires_at })) });
}

export async function revokeAllSessions(req, env, ctx, user, params) {
  const email = v.normEmail(decodeURIComponent(params.email));
  const r = await env.DB.prepare("DELETE FROM sessions WHERE email = ?").bind(email).run();
  await logStmt(env, user.email, "sessions.revoke", `Signed ${email} out of all devices (${r.meta.changes})`).run();
  return json({ ok: true, devicesSignedOut: r.meta.changes });
}

export async function revokeSession(req, env, ctx, user, params) {
  const id = String(params.id);
  const row = await env.DB.prepare("SELECT email, device FROM sessions WHERE id = ?").bind(id).first();
  if (!row) fail(404, "That device is already signed out.");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(id),
    logStmt(env, user.email, "sessions.revoke", `Signed ${row.email} out of one device (${row.device || "unknown"})`),
  ]);
  return json({ ok: true });
}

/* ---------- shared calendars ---------- */

const calOut = (c) => ({
  id: c.id, name: c.name, color: c.color, url: c.url, source: c.source, owner: c.owner,
  defaultOn: !!c.default_on, isShift: !!c.is_shift, sortOrder: c.sort_order,
});

function calIn(env, body) {
  const url = v.feedUrl(body.url, { allowSamples: devMode(env) });
  return {
    name: v.text(body.name, "Name", 80, { required: true }),
    color: v.color(body.color),
    url,
    source: v.source(body.source) || detectSource(url),
    owner: v.text(body.owner, "Owner or contact", 120),
    defaultOn: body.defaultOn === undefined ? true : v.bool(body.defaultOn),
    isShift: v.bool(body.isShift),
  };
}

export async function listCalendarsAdmin(req, env) {
  const { results } = await env.DB.prepare("SELECT * FROM calendars ORDER BY sort_order, id").all();
  return json({ calendars: results.map(calOut) });
}

export async function createCalendar(req, env, ctx, user) {
  const c = calIn(env, await readJson(req));
  const n = await env.DB.prepare("SELECT COUNT(*) AS n, COALESCE(MAX(sort_order), 0) AS maxo FROM calendars").first();
  if (n.n >= LIMITS.MAX_CALENDARS) fail(400, `Up to ${LIMITS.MAX_CALENDARS} shared calendars.`);
  const now = Date.now();
  const row = await env.DB.prepare(
    `INSERT INTO calendars (name, color, url, source, owner, default_on, is_shift, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  ).bind(c.name, c.color, c.url, c.source, c.owner, c.defaultOn ? 1 : 0, c.isShift ? 1 : 0, n.maxo + 1, now, now).first();
  await logStmt(env, user.email, "calendar.add", `Added calendar “${c.name}”${c.isShift ? " (shift calendar)" : ""}`).run();
  return json({ calendar: calOut(row) }, 201);
}

export async function updateCalendar(req, env, ctx, user, params) {
  const id = v.id(params.id);
  const body = await readJson(req);
  const cur = await env.DB.prepare("SELECT * FROM calendars WHERE id = ?").bind(id).first();
  if (!cur) fail(404, "That calendar was removed.");
  const c = calIn(env, { ...calOut(cur), ...body, url: body.url || cur.url });
  const changed = [];
  if (c.name !== cur.name) changed.push(`name → “${c.name}”`);
  if (c.color !== cur.color) changed.push("color");
  if (c.url !== cur.url) changed.push("link");
  if (c.source !== cur.source) changed.push(`source → ${c.source}`);
  if (c.owner !== cur.owner) changed.push("owner");
  if (c.defaultOn !== !!cur.default_on) changed.push(c.defaultOn ? "on by default" : "off by default");
  if (c.isShift !== !!cur.is_shift) changed.push(c.isShift ? "marked as shift calendar" : "no longer a shift calendar");
  const stmts = [env.DB.prepare(
    `UPDATE calendars SET name = ?, color = ?, url = ?, source = ?, owner = ?, default_on = ?, is_shift = ?, updated_at = ?
     WHERE id = ? RETURNING *`,
  ).bind(c.name, c.color, c.url, c.source, c.owner, c.defaultOn ? 1 : 0, c.isShift ? 1 : 0, Date.now(), id)];
  if (c.url !== cur.url) stmts.push(dropCache(env, `shared:${id}`));
  if (changed.length) stmts.push(logStmt(env, user.email, "calendar.edit", `Edited “${cur.name}”: ${changed.join(", ")}`));
  const [res] = await env.DB.batch(stmts);
  return json({ calendar: calOut(res.results[0]) });
}

export async function deleteCalendar(req, env, ctx, user, params) {
  const id = v.id(params.id);
  const cur = await env.DB.prepare("SELECT name FROM calendars WHERE id = ?").bind(id).first();
  if (!cur) fail(404, "That calendar was already removed.");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM calendars WHERE id = ?").bind(id),
    dropCache(env, `shared:${id}`),
    logStmt(env, user.email, "calendar.delete", `Deleted calendar “${cur.name}”`),
  ]);
  return json({ ok: true });
}

/** POST {ids: [3, 1, 2]} — new display order. */
export async function reorderCalendars(req, env, ctx, user) {
  const body = await readJson(req);
  if (!Array.isArray(body.ids) || body.ids.length > LIMITS.MAX_CALENDARS) fail(400, "Invalid order.");
  const ids = body.ids.map(v.id);
  await env.DB.batch([
    ...ids.map((id, i) => env.DB.prepare("UPDATE calendars SET sort_order = ? WHERE id = ?").bind(i + 1, id)),
    logStmt(env, user.email, "calendar.reorder", "Changed the order of shared calendars"),
  ]);
  return json({ ok: true });
}

/** POST {url} or {id} — fetch now and report what's in it. */
export async function testFeed(req, env) {
  const body = await readJson(req);
  let url;
  if (body.id) {
    const cur = await env.DB.prepare("SELECT url FROM calendars WHERE id = ?").bind(v.id(body.id)).first();
    if (!cur) fail(404, "That calendar was removed.");
    url = cur.url;
  } else {
    url = v.feedUrl(body.url, { allowSamples: devMode(env) });
  }
  try {
    const text = await downloadIcs(env, url);
    const s = summarizeIcs(text);
    return json({ ok: true, events: s.events, titles: s.titles, source: detectSource(url) });
  } catch (err) {
    return json({ ok: false, error: `Couldn't read that link: ${err.message}.` });
  }
}

/* ---------- settings and log ---------- */

export async function getAdminSettings(req, env) {
  const s = await getSettings(env);
  return json({ siteTitle: s.site_title, senderName: s.sender_name, coverage: s.coverage, senderEmail: env.SENDER_EMAIL || "", siteUrl: env.SITE_URL || "" });
}

export async function saveAdminSettings(req, env, ctx, user) {
  const body = await readJson(req);
  const before = await getSettings(env);
  const stmts = [];
  const changed = [];
  const put = (key, value) => stmts.push(env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key, JSON.stringify(value)));
  if (body.siteTitle !== undefined) {
    const t = v.text(body.siteTitle, "Site title", 60, { required: true });
    if (t !== before.site_title) { put("site_title", t); changed.push(`site title → “${t}”`); }
  }
  if (body.senderName !== undefined) {
    const t = v.text(body.senderName, "Sender name", 60, { required: true });
    if (t !== before.sender_name) { put("sender_name", t); changed.push(`sender name → “${t}”`); }
  }
  if (body.coverage !== undefined) {
    if (!body.coverage || typeof body.coverage !== "object") fail(400, "Invalid coverage settings.");
    for (const c of body.coverage.closed || []) {
      if (!v.isDate(c.from) || (c.to && !v.isDate(c.to))) fail(400, "Closed dates must be real dates.");
    }
    if ((body.coverage.closed || []).length > 200) fail(400, "Too many closed dates.");
    const cov = normalizeCoverage(body.coverage);
    if (JSON.stringify(cov) !== JSON.stringify(before.coverage)) { put("coverage", cov); changed.push("desk coverage settings"); }
  }
  if (stmts.length) {
    stmts.push(logStmt(env, user.email, "settings.edit", `Changed ${changed.join(", ")}`));
    await env.DB.batch(stmts);
  }
  return getAdminSettings(req, env);
}

export async function getLog(req, env) {
  const { results } = await env.DB.prepare("SELECT at, actor, action, detail FROM admin_log ORDER BY at DESC, id DESC LIMIT 100").all();
  return json({ log: results });
}
