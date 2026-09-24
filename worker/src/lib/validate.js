import { fail } from "./http.js";

export const normEmail = (e) => String(e || "").trim().toLowerCase();
export const isEmail = (e) => typeof e === "string" && e.length <= 254 && /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i.test(e);

/** Pull every email address out of pasted text ("Name <a@b.edu>, c@d.edu; …"). */
export function emailsFromText(text) {
  const found = String(text || "").match(/[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}/gi) || [];
  return [...new Set(found.map(normEmail))];
}

/** A trimmed string with a length limit. Control characters are removed (newlines kept if multiline). */
export function text(v, field, max, { required = false, multiline = false } = {}) {
  if (v == null) v = "";
  if (typeof v !== "string" && typeof v !== "number") fail(400, `${field} must be text.`);
  let s = String(v).replace(multiline ? /[\u0000-\u0009\u000B-\u001F\u007F]/g : /[\u0000-\u001F\u007F]/g, "").trim();
  if (required && !s) fail(400, `${field} is required.`);
  if (s.length > max) fail(400, `${field} is too long (max ${max} characters).`);
  return s;
}

export function color(v, field = "Color") {
  const s = String(v || "").trim();
  if (!/^#[0-9a-f]{6}$/i.test(s)) fail(400, `${field} must look like #2F5BD3.`);
  return s.toUpperCase();
}

export function isDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s))) return false;
  const [y, m, d] = s.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d && y >= 2000 && y <= 2100;
}

export function date(v, field) {
  if (!isDate(v)) fail(400, `${field} must be a date (YYYY-MM-DD).`);
  return v;
}

export function time(v, field) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(v || ""));
  if (!m || +m[1] > 23 || +m[2] > 59) fail(400, `${field} must be a time (HH:MM).`);
  return v;
}

export const bool = (v) => v === true || v === 1 || v === "1" || v === "true";

export function id(v) {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) fail(404, "Not found.");
  return n;
}

const SOURCES = ["outlook", "google", "apple", "other"];
export function source(v) {
  const s = String(v || "").toLowerCase();
  return SOURCES.includes(s) ? s : null;
}

/** An https (or webcal) calendar link, returned as https. Blocks local/private hosts. */
export function feedUrl(v, { allowSamples = false } = {}) {
  let s = String(v || "").trim();
  if (allowSamples && /^sample:[a-z]+$/.test(s)) return s;
  if (!s) fail(400, "Paste the calendar's ICS link.");
  if (s.length > 2000) fail(400, "That link is too long.");
  s = s.replace(/^webcals?:\/\//i, "https://");
  let u;
  try { u = new URL(s); } catch { fail(400, "That doesn't look like a web link. It should start with https://"); }
  if (u.protocol !== "https:") fail(400, "The link must start with https:// (or webcal://).");
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || /^[\d.]+$/.test(host) || host.includes(":") || u.username || u.password) {
    fail(400, "That link isn't allowed. Use the ICS link from Outlook, Google or Apple Calendar.");
  }
  return u.toString();
}
