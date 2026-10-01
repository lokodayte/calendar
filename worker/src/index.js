// SCSM Calendar API (Cloudflare Worker). Routes, CORS and access checks live here;
// every route declares who may call it: "public" (sign-in only), "user" or "admin".

import { HttpError, json } from "./lib/http.js";
import { devMode } from "./settings.js";
import { authenticate, requestCode, verifyCode, signOut } from "./auth.js";
import * as me from "./personal.js";
import * as admin from "./admin.js";
import * as sug from "./suggestions.js";

const routes = [
  ["POST", "/api/auth/request", "public", requestCode],
  ["POST", "/api/auth/verify", "public", verifyCode],
  ["POST", "/api/auth/signout", "user", signOut],

  ["GET", "/api/public", "public", me.publicInfo],
  ["GET", "/api/public/feeds/:id", "public", me.publicFeed],

  ["GET", "/api/bootstrap", "user", me.bootstrap],
  ["PUT", "/api/prefs", "user", me.savePrefs],
  ["GET", "/api/feeds/shared/:id", "user", me.sharedFeed],
  ["GET", "/api/feeds/mine/:id", "user", me.myFeed],
  ["GET", "/api/my-agenda", "user", me.listEvents],
  ["POST", "/api/my-agenda", "user", me.createEvent],
  ["PUT", "/api/my-agenda/:id", "user", me.updateEvent],
  ["DELETE", "/api/my-agenda/:id", "user", me.deleteEvent],
  ["GET", "/api/my-feeds", "user", me.listMyFeeds],
  ["POST", "/api/my-feeds", "user", me.createMyFeed],
  ["PUT", "/api/my-feeds/:id", "user", me.updateMyFeed],
  ["DELETE", "/api/my-feeds/:id", "user", me.deleteMyFeed],
  ["POST", "/api/my-feeds/:id/refresh", "user", me.refreshMyFeed],

  ["GET", "/api/suggestions/mine", "user", sug.mySuggestions],
  ["POST", "/api/suggestions", "user", sug.createSuggestion],
  ["DELETE", "/api/suggestions/:id", "user", sug.withdrawSuggestion],

  ["GET", "/api/admin/suggestions", "admin", sug.pendingSuggestions],
  ["GET", "/api/admin/suggestions/:id/file", "admin", sug.suggestionFile],
  ["POST", "/api/admin/suggestions/:id/decide", "admin", sug.decideSuggestion],
  ["GET", "/api/admin/staff", "admin", admin.listStaff],
  ["POST", "/api/admin/staff", "admin", admin.addStaff],
  ["PUT", "/api/admin/staff/:email", "admin", admin.updatePerson],
  ["DELETE", "/api/admin/staff/:email", "admin", admin.removeStaff],
  ["GET", "/api/admin/staff/:email/sessions", "admin", admin.listSessions],
  ["DELETE", "/api/admin/staff/:email/sessions", "admin", admin.revokeAllSessions],
  ["DELETE", "/api/admin/sessions/:id", "admin", admin.revokeSession],
  ["GET", "/api/admin/calendars", "admin", admin.listCalendarsAdmin],
  ["POST", "/api/admin/calendars", "admin", admin.createCalendar],
  ["POST", "/api/admin/calendars/order", "admin", admin.reorderCalendars],
  ["PUT", "/api/admin/calendars/:id", "admin", admin.updateCalendar],
  ["DELETE", "/api/admin/calendars/:id", "admin", admin.deleteCalendar],
  ["POST", "/api/admin/calendars/:id/refresh", "admin", admin.refreshCalendar],
  ["POST", "/api/admin/test-feed", "admin", admin.testFeed],
  ["GET", "/api/admin/settings", "admin", admin.getAdminSettings],
  ["PUT", "/api/admin/settings", "admin", admin.saveAdminSettings],
  ["GET", "/api/admin/log", "admin", admin.getLog],
].map(([method, path, access, handler]) => ({
  method, access, handler,
  re: new RegExp("^" + path.replace(/:(\w+)/g, "(?<$1>[^/]{1,200})") + "$"),
}));

// Protection against one visitor or script using up the free daily allowance for everyone.
// Per-network counters live in the Worker's memory (no database writes). Best effort — each
// Cloudflare location counts separately — but enough to stop a runaway script or bot.
const BURST_PER_MINUTE = { public: 120, request: 10, verify: 20 };
const hits = new Map();
function burstBucket(path) {
  if (path.startsWith("/api/public")) return "public";
  if (path === "/api/auth/request") return "request";
  if (path === "/api/auth/verify") return "verify";
  return null;
}
function tooMany(req, bucket) {
  const ip = req.headers.get("cf-connecting-ip");
  if (!ip || !bucket) return false;
  const now = Date.now(), key = `${bucket}|${ip}`;
  let e = hits.get(key);
  if (!e || now - e.t > 60e3) {
    if (hits.size > 10000) hits.clear();
    e = { n: 0, t: now };
    hits.set(key, e);
  }
  return ++e.n > BURST_PER_MINUTE[bucket];
}

function allowedOrigin(req, env) {
  const origin = req.headers.get("origin");
  if (!origin) return { ok: true, value: null }; // not a browser cross-site call; auth still applies
  const list = String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
  if (list.includes(origin)) return { ok: true, value: origin };
  if (devMode(env) && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return { ok: true, value: origin };
  return { ok: false, value: null };
}

function withCors(res, origin) {
  const h = new Headers(res.headers);
  if (origin) {
    h.set("access-control-allow-origin", origin);
    h.set("access-control-expose-headers", "x-feed-status, x-feed-fetched-at");
  }
  h.append("vary", "Origin");
  h.set("x-content-type-options", "nosniff");
  return new Response(res.body, { status: res.status, headers: h });
}

export default {
  async fetch(req, env, ctx) {
    const cors = allowedOrigin(req, env);
    if (!cors.ok) return json({ error: "This site isn't allowed to use the calendar service." }, 403);
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": cors.value || "",
          "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
          "access-control-allow-headers": "authorization, content-type",
          "access-control-max-age": "86400",
          vary: "Origin",
        },
      });
    }

    let res, user = null;
    try {
      const path = new URL(req.url).pathname.replace(/\/+$/, "") || "/";
      if (tooMany(req, burstBucket(path))) {
        res = json({ error: "Too many requests from your network. Please wait a minute and try again." }, 429, { "retry-after": "60" });
      } else if (path === "/" && req.method === "GET") {
        res = json({ ok: true, service: "SCSM Calendar API" });
      } else {
        let match = null, pathMatched = false;
        for (const r of routes) {
          const m = r.re.exec(path);
          if (!m) continue;
          pathMatched = true;
          if (r.method === req.method) { match = { r, params: m.groups || {} }; break; }
        }
        if (!match) {
          res = json({ error: pathMatched ? "Method not allowed." : "Not found." }, pathMatched ? 405 : 404);
        } else {
          const { r, params } = match;
          if (r.access !== "public") {
            user = await authenticate(req, env, ctx);
            if (r.access === "admin" && !user.isAdmin) throw new HttpError(403, "Only admins can do that.");
          }
          res = await r.handler(req, env, ctx, user, params);
        }
      }
    } catch (err) {
      if (err instanceof HttpError) res = json({ error: err.message }, err.status);
      else {
        // A short reference ties what the person sees to the log line (Cloudflare → Worker → Observability).
        const ref = crypto.randomUUID().slice(0, 8);
        console.error(`[error ${ref}]`, err && err.stack || err);
        const detail = user?.isAdmin ? ` Details for admins: ${String(err && err.message || err).slice(0, 200)}` : "";
        res = json({ error: `Something went wrong on the server (reference ${ref}). Please try again.${detail}` }, 500);
      }
    }
    return withCors(res, cors.value);
  },
};
