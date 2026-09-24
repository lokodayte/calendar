// Talking to the Worker. The device token lives in localStorage ("keep me signed in")
// or sessionStorage (shared computers: gone when the browser closes).

const BASE = String((window.SCSM_CONFIG || {}).apiUrl || "").replace(/\/+$/, "");
const KEY = "scsm_token";

function storage(kind) {
  try { return kind === "local" ? window.localStorage : window.sessionStorage; } catch { return null; }
}

export function getToken() {
  for (const k of ["local", "session"]) {
    try { const t = storage(k)?.getItem(KEY); if (t) return t; } catch { /* blocked storage */ }
  }
  return null;
}

export function setToken(token, remember) {
  clearToken();
  try { storage(remember ? "local" : "session")?.setItem(KEY, token); } catch { /* blocked storage */ }
}

export function clearToken() {
  for (const k of ["local", "session"]) { try { storage(k)?.removeItem(KEY); } catch { /* ignore */ } }
}

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

let onSignedOut = () => {};
export function whenSignedOut(fn) { onSignedOut = fn; }

async function request(path, { method = "GET", body } = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  let res;
  try {
    res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (err) {
    // Shows up in the browser console (Cmd+Option+J) to tell a blocked request from an outage.
    console.error(`Request to ${BASE + path} failed. If this is only in one browser, an ad blocker or privacy extension may be blocking it.`, err);
    throw new ApiError(0, "Couldn't reach the calendar service. If you use an ad blocker, allow this site and try again.");
  }
  if (res.status === 401 && !path.startsWith("/api/auth/")) {
    let msg = "Your sign-in has expired. Please sign in again.";
    try { msg = (await res.clone().json()).error || msg; } catch { /* keep default */ }
    clearToken();
    onSignedOut(msg);
    throw new ApiError(401, msg);
  }
  return res;
}

export async function api(path, opts) {
  const res = await request(path, opts);
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || `Something went wrong (error ${res.status}).`);
  return data;
}

/** ICS text for a feed, with whether it is the last saved copy. */
export async function apiFeed(path) {
  const res = await request(path);
  if (!res.ok) {
    let msg = "Couldn't load this calendar right now.";
    try { msg = (await res.json()).error || msg; } catch { /* keep default */ }
    throw new ApiError(res.status, msg);
  }
  return {
    text: await res.text(),
    stale: res.headers.get("x-feed-status") === "stale",
    fetchedAt: +(res.headers.get("x-feed-fetched-at") || 0),
  };
}

export const apiConfigured = () => BASE && !BASE.includes("YOUR-NAME");
