// Email-code sign-in and device sessions.

import { fail, json, readJson } from "./lib/http.js";
import { hmac, randomCode, randomToken, safeEqual } from "./lib/crypto.js";
import { normEmail, isEmail, text, bool } from "./lib/validate.js";
import { LIMITS, getSettings, isAdminEmail } from "./settings.js";
import { sendEmail, codeEmail } from "./email.js";

const GENERIC = "If this email is on the staff list, a code is on its way. Check your inbox (and junk folder).";

function secret(env) {
  const s = env.SESSION_SECRET;
  if (!s || s.length < 32) fail(500, "The server isn't set up yet: SESSION_SECRET is missing. See the README.");
  return s;
}

async function mayUseSite(env, email) {
  if (isAdminEmail(env, email)) return true;
  return !!(await env.DB.prepare("SELECT 1 AS ok FROM staff WHERE email = ?").bind(email).first());
}

const codeHash = (env, email, code) => hmac(secret(env), `code:${email}:${code}`);
export const sessionId = (env, token) => hmac(secret(env), `session:${token}`);

/** POST /api/auth/request {email} — same answer whether or not the email is allowed. */
export async function requestCode(req, env, ctx) {
  const body = await readJson(req, 2048);
  const email = normEmail(body.email);
  if (!isEmail(email)) fail(400, "Enter a valid email address.");
  secret(env);
  const ok = json({ ok: true, message: GENERIC });
  if (!(await mayUseSite(env, email))) return ok;

  const now = Date.now();
  const row = await env.DB.prepare("SELECT window_start, window_count FROM login_codes WHERE email = ?").bind(email).first();
  let windowStart = now, windowCount = 1;
  if (row && now - row.window_start < 3600e3) {
    if (row.window_count >= LIMITS.MAX_CODES_PER_HOUR) return ok;
    windowStart = row.window_start;
    windowCount = row.window_count + 1;
  }
  const code = randomCode();
  await env.DB.prepare(
    `INSERT INTO login_codes (email, code_hash, tries, expires_at, window_start, window_count) VALUES (?, ?, 0, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, tries = 0, expires_at = excluded.expires_at,
       window_start = excluded.window_start, window_count = excluded.window_count`,
  ).bind(email, await codeHash(env, email, code), now + LIMITS.CODE_MINUTES * 60e3, windowStart, windowCount).run();

  const settings = await getSettings(env);
  // Send in the background: the reply is the same (and about as fast) whether or not the email is on the list.
  const send = sendEmail(env, settings.sender_name, { to: email, ...codeEmail(settings.site_title, code) })
    .then((sent) => { if (!sent) console.error("Sign-in code email failed for a staff address."); });
  ctx && ctx.waitUntil ? ctx.waitUntil(send) : await send;
  return ok;
}

/** POST /api/auth/verify {email, code, device} → {token} */
export async function verifyCode(req, env) {
  const body = await readJson(req, 2048);
  const email = normEmail(body.email);
  const code = String(body.code || "").replace(/\D/g, "");
  const device = text(body.device, "Device", 100);
  if (!isEmail(email) || code.length !== 6) fail(400, "Enter the 6-digit code from your email.");

  const now = Date.now();
  const row = await env.DB.prepare("SELECT code_hash, tries, expires_at FROM login_codes WHERE email = ?").bind(email).first();
  if (!row || !row.code_hash || row.expires_at < now) fail(400, "That code has expired or was already used. Request a new one.");
  const cancel = env.DB.prepare("UPDATE login_codes SET code_hash = '', expires_at = 0 WHERE email = ?").bind(email);
  if (row.tries >= LIMITS.MAX_TRIES) { await cancel.run(); fail(400, "Too many tries. Request a new code."); }

  if (!safeEqual(await codeHash(env, email, code), row.code_hash)) {
    const tries = row.tries + 1;
    const left = LIMITS.MAX_TRIES - tries;
    await (left > 0
      ? env.DB.prepare("UPDATE login_codes SET tries = ? WHERE email = ?").bind(tries, email)
      : cancel).run();
    fail(400, left > 0 ? `That code isn't right. ${left} ${left === 1 ? "try" : "tries"} left.` : "Too many tries. Request a new code.");
  }
  if (!(await mayUseSite(env, email))) { await cancel.run(); fail(400, "This email doesn't have access anymore."); }

  const token = randomToken();
  // "Keep me signed in" (the default) lasts a year; unticked (shared computers) lasts 12 hours.
  const remember = body.remember === undefined ? true : bool(body.remember);
  const expires = now + (remember ? LIMITS.SESSION_DAYS * 864e5 : LIMITS.SHORT_SESSION_HOURS * 3600e3);
  await env.DB.batch([
    cancel,
    env.DB.prepare("INSERT INTO sessions (id, email, device, created_at, last_seen, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(await sessionId(env, token), email, device, now, now, expires),
    env.DB.prepare("INSERT OR IGNORE INTO staff (email, added_at, added_by) VALUES (?, ?, 'admin list')").bind(email, now),
    env.DB.prepare("UPDATE staff SET last_sign_in = ? WHERE email = ?").bind(now, email),
  ]);
  return json({ ok: true, token, email, isAdmin: isAdminEmail(env, email), expires });
}

/** Who is making this request? Throws 401 unless the device has a live session and the person is still allowed. */
export async function authenticate(req, env, ctx) {
  const m = /^Bearer\s+([A-Za-z0-9_-]{20,100})$/.exec(req.headers.get("authorization") || "");
  if (!m) fail(401, "Please sign in.");
  const id = await sessionId(env, m[1]);
  const row = await env.DB.prepare(
    `SELECT s.email, s.last_seen, s.expires_at, (SELECT 1 FROM staff WHERE email = s.email) AS on_staff
     FROM sessions s WHERE s.id = ?`,
  ).bind(id).first();
  const now = Date.now();
  if (!row || row.expires_at <= now) fail(401, "Your sign-in has expired. Please sign in again.");
  const isAdmin = isAdminEmail(env, row.email);
  if (!row.on_staff && !isAdmin) {
    await env.DB.prepare("DELETE FROM sessions WHERE email = ?").bind(row.email).run();
    fail(401, "This email doesn't have access anymore.");
  }
  // Only record "last seen" about twice a day, to keep database writes low.
  if (now - row.last_seen > 12 * 3600e3) {
    const p = env.DB.prepare("UPDATE sessions SET last_seen = ? WHERE id = ?").bind(now, id).run();
    ctx && ctx.waitUntil ? ctx.waitUntil(p) : await p;
  }
  return { email: row.email, isAdmin, sessionId: id };
}

/** POST /api/auth/signout — ends this device's session only. */
export async function signOut(req, env, ctx, user) {
  await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(user.sessionId).run();
  return json({ ok: true });
}
