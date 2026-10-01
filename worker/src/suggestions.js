// Event suggestions: any signed-in person can suggest an event (with an optional flyer);
// admins mark it "added" or "not added". The decision deletes the details and the file at once.

import { fail, json, readJson } from "./lib/http.js";
import * as v from "./lib/validate.js";

export const SUGGEST = {
  MAX_PENDING_PER_PERSON: 5,
  MAX_PER_HOUR_PER_PERSON: 10,
  MAX_PENDING_TOTAL: 300,           // with 1.2 MB files, worst case ≈ 0.5 GB of the free 5 GB
  MAX_FILE_BYTES: 1_200_000,        // base64 makes this ~1.6 MB, under D1's 2 MB row limit
  KEEP_RECEIPTS_DAYS: 30,
};

// Only these file kinds, checked by their first bytes as well as their declared type.
const FILE_TYPES = {
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/png": (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  "image/gif": (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46,
  "image/webp": (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45,
  "application/pdf": (b) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46,
};

/** Validate an attachment sent as a data: URL (the browser does the encoding, so the server does almost no work). */
function fileIn(file) {
  if (!file) return null;
  if (typeof file !== "object") fail(400, "The attachment couldn't be read.");
  const name = v.text(file.name, "File name", 120, { required: true }).replace(/[\\/]/g, "_");
  const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(file.data || ""));
  if (!m || !FILE_TYPES[m[1]]) fail(400, "Attach a photo (JPG, PNG, GIF, WebP) or a PDF.");
  const size = Math.floor((m[2].length * 3) / 4) - (m[2].endsWith("==") ? 2 : m[2].endsWith("=") ? 1 : 0);
  if (size > SUGGEST.MAX_FILE_BYTES) fail(400, `The file is too large (max ${(SUGGEST.MAX_FILE_BYTES / 1e6).toFixed(1)} MB). For a PDF, try a photo or screenshot of the flyer instead.`);
  const head = Uint8Array.from(atob(m[2].slice(0, 16)), (c) => c.charCodeAt(0));
  if (!FILE_TYPES[m[1]](head)) fail(400, "That file doesn't look like the photo or PDF it claims to be.");
  return { name, type: m[1], size, data: file.data };
}

function suggestionIn(body) {
  const s = {
    title: v.text(body.title, "Title", 200, { required: true }),
    date: v.date(body.date, "Date"),
    allDay: v.bool(body.allDay),
    startTime: null, endTime: null,
    location: v.text(body.location, "Location", 200),
    host: v.text(body.host, "Host", 120),
    details: v.text(body.details, "Details", 2000, { multiline: true }),
    link: "",
    calendarId: body.calendarId ? v.id(body.calendarId) : null,
  };
  if (!s.allDay) {
    s.startTime = v.time(body.startTime, "Start time");
    s.endTime = v.time(body.endTime, "End time");
    if (s.endTime <= s.startTime) fail(400, "The end time must be after the start time.");
  }
  const link = String(body.link || "").trim();
  if (link) {
    let u;
    try { u = new URL(link); } catch { fail(400, "The link should start with https://"); }
    if (!["https:", "http:"].includes(u.protocol) || link.length > 500) fail(400, "The link should start with https://");
    s.link = u.toString();
  }
  return s;
}

const out = (r) => ({
  id: r.id, title: r.title, date: r.date, allDay: !!r.all_day, startTime: r.start_time, endTime: r.end_time,
  location: r.location, host: r.host, details: r.details, link: r.link, calendarId: r.calendar_id,
  file: r.file_name ? { name: r.file_name, type: r.file_type, size: r.file_size } : null,
  status: r.status, note: r.note, createdAt: r.created_at, decidedAt: r.decided_at,
});
const COLS = "id, email, title, date, all_day, start_time, end_time, location, host, details, link, calendar_id, file_name, file_type, file_size, status, note, created_at, decided_at";

/** Old receipts (decided more than 30 days ago) are removed whenever someone opens or adds suggestions. */
const purgeOld = (env) => env.DB.prepare("DELETE FROM suggestions WHERE status <> 'pending' AND decided_at < ?")
  .bind(Date.now() - SUGGEST.KEEP_RECEIPTS_DAYS * 864e5);

/** GET /api/suggestions/mine */
export async function mySuggestions(req, env, ctx, user) {
  const [, mine] = await env.DB.batch([
    purgeOld(env),
    env.DB.prepare(`SELECT ${COLS} FROM suggestions WHERE email = ? ORDER BY created_at DESC LIMIT 50`).bind(user.email),
  ]);
  return json({ suggestions: mine.results.map(out), limits: { perPerson: SUGGEST.MAX_PENDING_PER_PERSON, maxFileBytes: SUGGEST.MAX_FILE_BYTES } });
}

/** POST /api/suggestions {title, date, allDay, startTime, endTime, location, host, details, link, calendarId, file?} */
export async function createSuggestion(req, env, ctx, user) {
  const body = await readJson(req, 1_800_000);
  const s = suggestionIn(body);
  const file = fileIn(body.file);
  const now = Date.now();
  const counts = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM suggestions WHERE email = ?1 AND status = 'pending') AS mine,
       (SELECT COUNT(*) FROM suggestions WHERE email = ?1 AND created_at > ?2) AS hour,
       (SELECT COUNT(*) FROM suggestions WHERE status = 'pending') AS total`,
  ).bind(user.email, now - 3600e3).first();
  if (counts.mine >= SUGGEST.MAX_PENDING_PER_PERSON) fail(400, `You have ${counts.mine} suggestions waiting for review. Please wait until an admin has looked at them.`);
  if (counts.hour >= SUGGEST.MAX_PER_HOUR_PER_PERSON) fail(429, "That's a lot of suggestions in one hour. Please try again a bit later.");
  if (counts.total >= SUGGEST.MAX_PENDING_TOTAL) fail(503, "The suggestions inbox is full right now. Please try again after the admins have caught up.");

  const row = await env.DB.prepare(
    `INSERT INTO suggestions (email, title, date, all_day, start_time, end_time, location, host, details, link, calendar_id, file_name, file_type, file_size, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${COLS}`,
  ).bind(user.email, s.title, s.date, s.allDay ? 1 : 0, s.startTime, s.endTime, s.location, s.host, s.details, s.link, s.calendarId,
    file?.name ?? null, file?.type ?? null, file?.size ?? null, now).first();
  if (file) await env.DB.prepare("INSERT INTO suggestion_files (suggestion_id, data) VALUES (?, ?)").bind(row.id, file.data).run();
  await purgeOld(env).run();
  return json({ suggestion: out(row) }, 201);
}

/** DELETE /api/suggestions/:id — withdraw your own suggestion while it's waiting (or clear a receipt). */
export async function withdrawSuggestion(req, env, ctx, user, params) {
  const id = v.id(params.id);
  const [del] = await env.DB.batch([
    env.DB.prepare("DELETE FROM suggestions WHERE id = ? AND email = ?").bind(id, user.email),
    env.DB.prepare("DELETE FROM suggestion_files WHERE suggestion_id = ? AND NOT EXISTS (SELECT 1 FROM suggestions WHERE id = ?)").bind(id, id),
  ]);
  if (!del.meta.changes) fail(404, "Not found.");
  return json({ ok: true });
}

/* ---------- admins ---------- */

/** GET /api/admin/suggestions — everything waiting, oldest first, with who suggested it. */
export async function pendingSuggestions(req, env) {
  const [, pending] = await env.DB.batch([
    purgeOld(env),
    env.DB.prepare(
      `SELECT s.${COLS.split(", ").join(", s.")}, p.name AS by_name FROM suggestions s LEFT JOIN staff p ON p.email = s.email
       WHERE s.status = 'pending' ORDER BY s.created_at LIMIT ${SUGGEST.MAX_PENDING_TOTAL}`,
    ),
  ]);
  return json({ suggestions: pending.results.map((r) => ({ ...out(r), by: { email: r.email, name: r.by_name || "" } })) });
}

/** GET /api/admin/suggestions/:id/file — the attachment as a data: URL; the browser turns it into a file. */
export async function suggestionFile(req, env, ctx, user, params) {
  const r = await env.DB.prepare(
    "SELECT s.file_name, s.file_type, f.data FROM suggestions s JOIN suggestion_files f ON f.suggestion_id = s.id WHERE s.id = ?",
  ).bind(v.id(params.id)).first();
  if (!r) fail(404, "That file was already deleted.");
  return json({ name: r.file_name, type: r.file_type, data: r.data });
}

/** POST /api/admin/suggestions/:id/decide {decision: "added"|"rejected", note} — frees the space right away. */
export async function decideSuggestion(req, env, ctx, user, params) {
  const id = v.id(params.id);
  const body = await readJson(req, 4096);
  const decision = body.decision === "added" ? "added" : body.decision === "rejected" ? "rejected" : fail(400, "Choose Added or Not added.");
  const note = v.text(body.note, "Note", 300);
  const cur = await env.DB.prepare("SELECT title, email, date FROM suggestions WHERE id = ? AND status = 'pending'").bind(id).first();
  if (!cur) fail(404, "Another admin already handled this suggestion.");
  const now = Date.now();
  await env.DB.batch([
    // Keep only a one-line receipt for the person who suggested it.
    env.DB.prepare(
      `UPDATE suggestions SET status = ?, note = ?, decided_at = ?, decided_by = ?, details = '', location = '', host = '', link = '',
         file_name = NULL, file_type = NULL, file_size = NULL WHERE id = ?`,
    ).bind(decision, note, now, user.email, id),
    env.DB.prepare("DELETE FROM suggestion_files WHERE suggestion_id = ?").bind(id),
    env.DB.prepare("INSERT INTO admin_log (at, actor, action, detail) VALUES (?, ?, ?, ?)")
      .bind(now, user.email, `suggestion.${decision}`, `${decision === "added" ? "Added" : "Didn't add"} suggestion “${cur.title.slice(0, 80)}” (${cur.date}) from ${cur.email}`),
  ]);
  return json({ ok: true });
}

/** How many suggestions are waiting (for the badge on the admin's tab). */
export async function pendingCount(env) {
  return (await env.DB.prepare("SELECT COUNT(*) AS n FROM suggestions WHERE status = 'pending'").first("n")) || 0;
}

