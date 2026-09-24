// Fetching calendar links (ICS) with a ~20 minute cache and a "last good copy" fallback.
// Cached copies are gzipped into D1 so big Outlook feeds stay well under the row size limit.

import { fromBase64, sha256, toBase64 } from "./lib/crypto.js";
import { LIMITS, devMode } from "./settings.js";
import { sampleIcs } from "./dev/samples.js";

const MAX_FEED_BYTES = 8 * 1024 * 1024;
const MAX_CACHED_BYTES = 1_800_000;

/** Guess where a link comes from, from its address. */
export function detectSource(url) {
  const u = String(url || "").toLowerCase();
  if (/outlook\.(office365|office|live)\.com|\.outlook\.com|office365\.com|hotmail|exchange/.test(u)) return "outlook";
  if (/calendar\.google\.com|googleusercontent|google\.com\/calendar/.test(u)) return "google";
  if (/icloud\.com|\.me\.com|apple\.com/.test(u)) return "apple";
  return "other";
}

async function gzip(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

/** Pauses before retrying a busy calendar server (tests set these to 0). */
export const RETRY = { delaysMs: [1000, 2500] };

/** A failure that may go away on its own (busy or unreachable server), as opposed to a wrong link. */
function temporary(message) {
  const err = new Error(message);
  err.temporary = true;
  return err;
}

/** Download an ICS feed right now (no cache). Throws a friendly Error on failure; err.temporary marks busy/unreachable. */
export async function downloadIcs(env, url) {
  if (url.startsWith("sample:")) {
    if (!devMode(env)) throw new Error("Sample calendars only work in local dev mode.");
    return sampleIcs(url.slice(7));
  }
  let r;
  for (let attempt = 0; ; attempt++) {
    try {
      r = await fetch(url, {
        headers: { "user-agent": "SCSM-Calendar/2.0", accept: "text/calendar, text/plain, */*" },
        redirect: "follow",
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      throw temporary(err && err.name === "TimeoutError" ? "the calendar took too long to answer" : "the calendar couldn't be reached");
    }
    // Google in particular answers 429 ("too many requests") to cloud servers now and then; a short wait usually helps.
    const busy = r.status === 429 || r.status === 503;
    if (!busy || attempt >= RETRY.delaysMs.length) break;
    await r.body?.cancel();
    await new Promise((res) => setTimeout(res, RETRY.delaysMs[attempt]));
  }
  if (r.status === 404 || r.status === 410) throw new Error("the link no longer works (not found). For Google, use the “Secret address in iCal format”");
  if (r.status === 401 || r.status === 403) throw new Error("the calendar refused access. Is it still published or shared?");
  if (r.status === 429) throw temporary("the calendar's server is limiting requests right now (error 429). It usually works again within a few minutes");
  if (r.status >= 500) throw temporary(`the calendar's server had a problem (error ${r.status})`);
  if (!r.ok) throw new Error(`the calendar answered with error ${r.status}`);
  const len = +(r.headers.get("content-length") || 0);
  if (len > MAX_FEED_BYTES) throw new Error("the calendar is too large");
  const body = await r.text();
  if (body.length > MAX_FEED_BYTES) throw new Error("the calendar is too large");
  if (!/BEGIN:VCALENDAR/i.test(body)) throw new Error("the link isn't an ICS calendar. Use the ICS link, not the web page link");
  return body;
}

/**
 * Cached feed text. Returns {text, stale, fetchedAt, error}.
 * Fresh copies come from the cache for CACHE_MINUTES; if the source is down, the last good copy is returned with stale=true.
 */
export async function getFeed(env, ctx, key, url) {
  const now = Date.now();
  const urlHash = await sha256(url);
  const row = await env.DB.prepare("SELECT url_hash, body, fetched_at, checked_at, last_error FROM feed_cache WHERE key = ?").bind(key).first();
  const sameUrl = row && row.url_hash === urlHash;
  const cached = sameUrl && row.body ? row : null;

  if (cached && now - cached.checked_at < LIMITS.CACHE_MINUTES * 60e3) {
    const stale = !!cached.last_error;
    return { text: await gunzip(fromBase64(cached.body)), stale, fetchedAt: cached.fetched_at, error: cached.last_error || null };
  }
  if (sameUrl && !row.body && row.last_error && now - row.checked_at < LIMITS.RETRY_AFTER_ERROR_MIN * 60e3) {
    throw new Error(row.last_error);
  }

  const save = (p) => (ctx && ctx.waitUntil ? ctx.waitUntil(p) : p);
  try {
    const text = await downloadIcs(env, url);
    const zipped = await gzip(text);
    const body = zipped.length <= MAX_CACHED_BYTES ? toBase64(zipped) : null;
    await save(env.DB.prepare(
      `INSERT INTO feed_cache (key, url_hash, body, fetched_at, checked_at, last_error) VALUES (?, ?, ?, ?, ?, NULL)
       ON CONFLICT(key) DO UPDATE SET url_hash = excluded.url_hash, body = excluded.body, fetched_at = excluded.fetched_at,
         checked_at = excluded.checked_at, last_error = NULL`,
    ).bind(key, urlHash, body, now, now).run());
    return { text, stale: false, fetchedAt: now, error: null };
  } catch (err) {
    const message = String(err && err.message || err).slice(0, 200);
    // Remember the failure so we don't retry on every page load; keep the last good copy.
    await save(env.DB.prepare(
      `INSERT INTO feed_cache (key, url_hash, body, fetched_at, checked_at, last_error) VALUES (?, ?, NULL, 0, ?, ?)
       ON CONFLICT(key) DO UPDATE SET checked_at = excluded.checked_at, last_error = excluded.last_error,
         body = CASE WHEN feed_cache.url_hash = excluded.url_hash THEN feed_cache.body ELSE NULL END,
         fetched_at = CASE WHEN feed_cache.url_hash = excluded.url_hash THEN feed_cache.fetched_at ELSE 0 END,
         url_hash = excluded.url_hash`,
    ).bind(key, urlHash, now, message).run());
    if (cached) return { text: await gunzip(fromBase64(cached.body)), stale: true, fetchedAt: cached.fetched_at, error: message };
    throw new Error(message);
  }
}

export function dropCache(env, key) {
  return env.DB.prepare("DELETE FROM feed_cache WHERE key = ?").bind(key);
}

/** Response for a feed request. ICS text plus status headers the website reads. */
export function feedResponse(result) {
  return new Response(result.text, {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "cache-control": "private, no-store",
      "x-feed-status": result.stale ? "stale" : "fresh",
      "x-feed-fetched-at": String(result.fetchedAt || 0),
    },
  });
}

/** Unique event titles and a count, for the admin "Test link" button. */
export function summarizeIcs(text) {
  const unfolded = text.replace(/\r?\n[ \t]/g, "");
  const events = (unfolded.match(/^BEGIN:VEVENT/gim) || []).length;
  const titles = new Set();
  for (const m of unfolded.matchAll(/^SUMMARY(?:;[^:]*)?:(.*)$/gim)) {
    const t = m[1].replace(/\\([,;\\])/g, "$1").replace(/\\n/gi, " ").trim();
    if (t) titles.add(t);
    if (titles.size >= 40) break;
  }
  return { events, titles: [...titles] };
}
