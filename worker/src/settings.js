import { normalizeCoverage } from "../../public/js/coverage.js";

export const LIMITS = {
  CACHE_MINUTES: 20,          // how often calendar links are re-read
  RETRY_AFTER_ERROR_MIN: 5,   // after a failed fetch, serve the saved copy this long before retrying
  CODE_MINUTES: 10,           // how long an emailed code works
  MAX_TRIES: 5,               // wrong guesses allowed per code
  MAX_CODES_PER_HOUR: 3,      // codes one email can request per hour
  SESSION_DAYS: 365,          // how long a device stays signed in
  MAX_EVENTS_PER_USER: 1000,
  MAX_FEEDS_PER_USER: 10,
  MAX_CALENDARS: 50,
  MAX_STAFF_PER_PASTE: 200,
  MAX_WELCOME_EMAILS: 50,
};

const DEFAULTS = { site_title: "SCSM Calendar", sender_name: "SCSM Calendar" };

export async function getSettings(env) {
  const { results } = await env.DB.prepare("SELECT key, value FROM settings").all();
  const out = { ...DEFAULTS, coverage: null };
  for (const r of results) {
    try { out[r.key] = JSON.parse(r.value); } catch { /* ignore a broken row */ }
  }
  out.coverage = normalizeCoverage(out.coverage);
  return out;
}

export function isAdminEmail(env, email) {
  return String(env.ADMIN_EMAILS || "").split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean).includes(email);
}

export function adminEmails(env) {
  return String(env.ADMIN_EMAILS || "").split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export const devMode = (env) => String(env.DEV_MODE || "").toLowerCase() === "true";
