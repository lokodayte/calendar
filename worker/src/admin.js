// Admin-only endpoints. The router checks user.isAdmin before any of these run.

import { fail, json, readJson } from "./lib/http.js";
import * as v from "./lib/validate.js";
import { LIMITS, getSettings, devMode, isSuperAdmin, superAdmins, personFromRow, ROLES, ROLE_LABEL, AUDIENCES } from "./settings.js";
import { detectSource, downloadIcs, dropCache, summarizeIcs } from "./feeds.js";
import { sendEmail, welcomeEmail, emailProvider, pauseBetweenEmails } from "./email.js";
import { normalizeCoverage } from "../../public/js/coverage.js";

const logStmt = (env, actor, action, detail) =>
  env.DB.prepare("INSERT INTO admin_log (at, actor, action, detail) VALUES (?, ?, ?, ?)").bind(Date.now(), actor, action, String(detail).slice(0, 1000));

const list = (xs, max = 5) => (xs.length > max ? `${xs.slice(0, max).join(", ")} and ${xs.length - max} more` : xs.join(", "));

/* ---------- people (staff, student assistants, admins) ---------- */

const protectSuper = (env, email) => {
  if (isSuperAdmin(env, email)) fail(403, "Super admins can't be changed from the website. They're set in wrangler.toml.");
};
const roleIn = (v0) => {
  const r = String(v0 || "staff");
  if (!ROLES.includes(r)) fail(400, "Role must be Admin, Staff or Student assistant.");
  return r;
};
const untilIn = (v0) => (v0 ? v.date(v0, "Access until") : null);

export async function listStaff(req, env) {
  const now = Date.now();
  const [staff, devices] = await env.DB.batch([
    env.DB.prepare("SELECT email, name, role, access_until, added_at, added_by, last_sign_in FROM staff ORDER BY email"),
    env.DB.prepare("SELECT email, COUNT(*) AS n FROM sessions WHERE expires_at > ? GROUP BY email").bind(now),
  ]);
  const counts = new Map(devices.results.map((r) => [r.email, r.n]));
  const rows = staff.results.map((r) => {
    const p = personFromRow(r);
    const role = isSuperAdmin(env, r.email) ? "superadmin" : p.role;
    return {
      email: r.email, name: p.name, role, roleLabel: ROLE_LABEL[role], accessUntil: p.accessUntil, expired: role !== "superadmin" && p.expired,
      addedAt: r.added_at, addedBy: r.added_by, lastSignIn: r.last_sign_in, devices: counts.get(r.email) || 0,
    };
  });
  for (const a of superAdmins(env)) {
    if (!rows.some((r) => r.email === a)) rows.push({ email: a, name: "", role: "superadmin", roleLabel: ROLE_LABEL.superadmin, accessUntil: null, expired: false, addedAt: null, lastSignIn: null, devices: counts.get(a) || 0 });
  }
  return json({ staff: rows.sort((a, b) => a.email.localeCompare(b.email)) });
}

/** POST {emails: "pasted text", role, accessUntil, welcome} — "Name <email>" lines keep the name. */
export async function addStaff(req, env, ctx, user) {
  const body = await readJson(req, 64 * 1024);
  const people = v.peopleFromText(body.emails);
  if (!people.length) fail(400, "No email addresses found. Paste one or more addresses.");
  if (people.length > LIMITS.MAX_STAFF_PER_PASTE) fail(400, `Add up to ${LIMITS.MAX_STAFF_PER_PASTE} people at a time.`);
  const role = roleIn(body.role);
  const accessUntil = untilIn(body.accessUntil);
  const welcome = v.bool(body.welcome);
  if (welcome && people.length > LIMITS.MAX_WELCOME_EMAILS) fail(400, `Welcome emails can go to up to ${LIMITS.MAX_WELCOME_EMAILS} people at a time. Add fewer people, or untick “Send welcome email”.`);
  const now = Date.now();
  const toAdd = people.filter((p) => !isSuperAdmin(env, p.email));
  const results = toAdd.length ? await env.DB.batch(toAdd.map((p) =>
    env.DB.prepare("INSERT OR IGNORE INTO staff (email, name, role, access_until, added_at, added_by) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(p.email, p.name, role, accessUntil, now, user.email))) : [];
  const added = toAdd.filter((_, i) => results[i].meta.changes > 0).map((p) => p.email);
  const already = people.map((p) => p.email).filter((e) => !added.includes(e));
  if (added.length) await logStmt(env, user.email, "people.add", `Added ${added.length} ${ROLE_LABEL[role].toLowerCase()}${added.length === 1 ? "" : "s"}${accessUntil ? ` (until ${accessUntil})` : ""}: ${list(added)}`).run();

  let welcomed = 0, welcomeFailed = 0;
  if (welcome && added.length) {
    const s = await getSettings(env);
    const mail = welcomeEmail(s.site_title, env.SITE_URL);
    for (const [i, to] of added.entries()) {
      if (i) await pauseBetweenEmails(env);
      (await sendEmail(env, s.sender_name, { to, ...mail })) ? welcomed++ : welcomeFailed++;
    }
  }
  return json({ added, already, welcomed, welcomeFailed });
}

/** PUT {role?, name?, accessUntil?} — change one person. Super admins can't be changed. */
export async function updatePerson(req, env, ctx, user, params) {
  const email = v.normEmail(decodeURIComponent(params.email));
  protectSuper(env, email);
  const body = await readJson(req);
  const cur = await env.DB.prepare("SELECT name, role, access_until FROM staff WHERE email = ?").bind(email).first();
  if (!cur) fail(404, "That person isn't on the list.");
  const next = {
    role: body.role === undefined ? cur.role : roleIn(body.role),
    name: body.name === undefined ? cur.name : v.text(body.name, "Name", 80),
    accessUntil: body.accessUntil === undefined ? cur.access_until : untilIn(body.accessUntil),
  };
  const changed = [];
  if (next.role !== cur.role) changed.push(`role → ${ROLE_LABEL[next.role]}`);
  if (next.name !== cur.name) changed.push(`name → “${next.name}”`);
  if ((next.accessUntil || null) !== (cur.access_until || null)) changed.push(next.accessUntil ? `access until ${next.accessUntil}` : "no end date");
  if (changed.length) {
    await env.DB.batch([
      env.DB.prepare("UPDATE staff SET role = ?, name = ?, access_until = ? WHERE email = ?").bind(next.role, next.name, next.accessUntil, email),
      logStmt(env, user.email, "people.edit", `Changed ${email}: ${changed.join(", ")}`),
    ]);
  }
  return json({ ok: true, email, ...next, roleLabel: ROLE_LABEL[next.role] });
}

export async function removeStaff(req, env, ctx, user, params) {
  const email = v.normEmail(decodeURIComponent(params.email));
  protectSuper(env, email);
  const [del, sess] = await env.DB.batch([
    env.DB.prepare("DELETE FROM staff WHERE email = ?").bind(email),
    env.DB.prepare("DELETE FROM sessions WHERE email = ?").bind(email),
    env.DB.prepare("DELETE FROM login_codes WHERE email = ?").bind(email),
  ]);
  if (!del.meta.changes) fail(404, "That person isn't on the list.");
  await logStmt(env, user.email, "people.remove", `Removed ${email} (signed out of ${sess.meta.changes} device${sess.meta.changes === 1 ? "" : "s"})`).run();
  return json({ ok: true, devicesSignedOut: sess.meta.changes });
}

export async function listSessions(req, env, ctx, user, params) {
  const email = v.normEmail(decodeURIComponent(params.email));
  const { results } = await env.DB.prepare(
    "SELECT id, device, created_at, last_seen, expires_at FROM sessions WHERE email = ? AND expires_at > ? ORDER BY last_seen DESC",
  ).bind(email, Date.now()).all();
  return json({ sessions: results.map((r) => ({ id: r.id, device: r.device || "Unknown device", createdAt: r.created_at, lastSeen: r.last_seen, expiresAt: r.expires_at })) });
}

/** Only a super admin may sign a super admin out of their devices. */
const protectSuperSessions = (env, user, email) => {
  if (isSuperAdmin(env, email) && !user.isSuper) fail(403, "Only a super admin can sign a super admin out.");
};

export async function revokeAllSessions(req, env, ctx, user, params) {
  const email = v.normEmail(decodeURIComponent(params.email));
  protectSuperSessions(env, user, email);
  const r = await env.DB.prepare("DELETE FROM sessions WHERE email = ?").bind(email).run();
  await logStmt(env, user.email, "sessions.revoke", `Signed ${email} out of all devices (${r.meta.changes})`).run();
  return json({ ok: true, devicesSignedOut: r.meta.changes });
}

export async function revokeSession(req, env, ctx, user, params) {
  const id = String(params.id);
  const row = await env.DB.prepare("SELECT email, device FROM sessions WHERE id = ?").bind(id).first();
  if (!row) fail(404, "That device is already signed out.");
  protectSuperSessions(env, user, row.email);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(id),
    logStmt(env, user.email, "sessions.revoke", `Signed ${row.email} out of one device (${row.device || "unknown"})`),
  ]);
  return json({ ok: true });
}

/* ---------- shared calendars ---------- */

const AUD_LABEL = { public: "public", everyone: "everyone signed in", staff: "staff only" };

const calOut = (c) => ({
  id: c.id, name: c.name, color: c.color, url: c.url, source: c.source, owner: c.owner,
  defaultOn: !!c.default_on, isShift: !!c.is_shift, sortOrder: c.sort_order, audience: c.audience,
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
    audience: AUDIENCES.includes(body.audience) ? body.audience : "everyone",
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
    `INSERT INTO calendars (name, color, url, source, owner, default_on, is_shift, audience, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  ).bind(c.name, c.color, c.url, c.source, c.owner, c.defaultOn ? 1 : 0, c.isShift ? 1 : 0, c.audience, n.maxo + 1, now, now).first();
  await logStmt(env, user.email, "calendar.add", `Added calendar “${c.name}” (${AUD_LABEL[c.audience]}${c.isShift ? ", shift calendar" : ""})`).run();
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
  if (c.audience !== cur.audience) changed.push(`who can see it → ${AUD_LABEL[c.audience]}`);
  const stmts = [env.DB.prepare(
    `UPDATE calendars SET name = ?, color = ?, url = ?, source = ?, owner = ?, default_on = ?, is_shift = ?, audience = ?, updated_at = ?
     WHERE id = ? RETURNING *`,
  ).bind(c.name, c.color, c.url, c.source, c.owner, c.defaultOn ? 1 : 0, c.isShift ? 1 : 0, c.audience, Date.now(), id)];
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
  return json({
    siteTitle: s.site_title, senderName: s.sender_name, publicTagline: s.public_tagline, coverage: s.coverage, siteUrl: env.SITE_URL || "",
    emailProvider: emailProvider(env) || (devMode(env) ? "dev" : null),
    emailStatus: s.email_status && s.email_status.error ? s.email_status : null,
  });
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
  if (body.publicTagline !== undefined) {
    const t = v.text(body.publicTagline, "Front page tagline", 200);
    if (t !== before.public_tagline) { put("public_tagline", t); changed.push("front page tagline"); }
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
