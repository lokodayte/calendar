import { normalizeCoverage } from "../../public/js/coverage.js";

export const LIMITS = {
  CACHE_MINUTES: 20,          // how often calendar links are re-read
  RETRY_AFTER_ERROR_MIN: 5,   // after a failed fetch, serve the saved copy this long before retrying
  CODE_MINUTES: 10,           // how long an emailed code works
  MAX_TRIES: 5,               // wrong guesses allowed per code
  MAX_CODES_PER_HOUR: 3,      // codes one email can request per hour
  SESSION_DAYS: 365,          // how long a device stays signed in
  SHORT_SESSION_HOURS: 12,    // when "keep me signed in" is unticked
  MAX_EVENTS_PER_USER: 1000,
  MAX_FEEDS_PER_USER: 10,
  MAX_CALENDARS: 50,
  MAX_STAFF_PER_PASTE: 200,
  MAX_WELCOME_EMAILS: 20,     // EmailJS's free plan is 200 emails a month
};

const DEFAULTS = {
  site_title: "SCSM Calendar",
  sender_name: "SCSM Calendar",
  public_tagline: "Club meetings, labs and school events at the School of Computer Science & Mathematics.",
};

export async function getSettings(env) {
  const { results } = await env.DB.prepare("SELECT key, value FROM settings").all();
  const out = { ...DEFAULTS, coverage: null };
  for (const r of results) {
    try { out[r.key] = JSON.parse(r.value); } catch { /* ignore a broken row */ }
  }
  out.coverage = normalizeCoverage(out.coverage);
  return out;
}

const emailList = (v) => String(v || "").split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);

/** Super admins come from wrangler.toml, so nobody can remove or demote them from the website. */
export function superAdmins(env) {
  return emailList(env.SUPERADMIN_EMAILS || env.ADMIN_EMAILS);
}
export const isSuperAdmin = (env, email) => superAdmins(env).includes(email);

export const ROLES = ["admin", "staff", "assistant"];
export const ROLE_LABEL = { superadmin: "Super admin", admin: "Admin", staff: "Staff", assistant: "Student assistant" };
export const AUDIENCES = ["public", "everyone", "staff"];

/** Calendars a signed-in person may see. Student assistants don't see "staff only" calendars. */
export const visibleAudiences = (user) => (user.role === "assistant" ? ["public", "everyone"] : AUDIENCES);

/** Today's date in Eastern Time, for "access until" checks. */
export function todayNY() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

/**
 * Who is this email? {role, name, accessUntil, expired} or null if they aren't on the list.
 * Super admins always get role "superadmin".
 */
export async function lookupPerson(env, email) {
  const row = await env.DB.prepare("SELECT role, name, access_until FROM staff WHERE email = ?").bind(email).first();
  if (isSuperAdmin(env, email)) return { role: "superadmin", name: row?.name || "", accessUntil: null, expired: false };
  if (!row) return null;
  return personFromRow(row);
}

export function personFromRow(row) {
  const role = ROLES.includes(row.role) ? row.role : "staff";
  const accessUntil = row.access_until || null;
  return { role, name: row.name || "", accessUntil, expired: !!accessUntil && accessUntil < todayNY() };
}

export const devMode = (env) => String(env.DEV_MODE || "").toLowerCase() === "true";
