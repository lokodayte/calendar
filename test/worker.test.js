import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../worker/src/index.js";
import { FakeD1 } from "./helpers/d1.js";

const SITE = "https://scsm.web.app";
const ADMIN = "boss@marist.edu";
const A = "alice@marist.edu";
const B = "bob@marist.edu";
const ICS = (title = "Club meeting") =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:1\r\nDTSTART:20261001T160000Z\r\nDTEND:20261001T170000Z\r\nSUMMARY:${title}\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:2\r\nDTSTART:20261002T160000Z\r\nDTEND:20261002T170000Z\r\nSUMMARY:Front desk: Sam\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;

let env, outbox, feeds, feedHits, realFetch;

beforeEach(() => {
  env = {
    DB: new FakeD1(),
    ADMIN_EMAILS: ADMIN,
    SESSION_SECRET: "test-secret-test-secret-test-secret-1234",
    ALLOWED_ORIGINS: SITE,
    SENDER_EMAIL: ADMIN,
    BREVO_API_KEY: "test-key",
    SITE_URL: SITE,
  };
  env.DB.q("INSERT INTO staff (email, added_at) VALUES (?, 0), (?, 0)", A, B);
  outbox = [];
  feeds = new Map();
  feedHits = 0;
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    if (url === "https://api.brevo.com/v3/smtp/email") {
      const body = JSON.parse(init.body);
      outbox.push({ to: body.to[0].email, subject: body.subject, text: body.textContent, html: body.htmlContent });
      return new Response("{}", { status: 201 });
    }
    feedHits++;
    const f = feeds.get(url);
    if (!f) return new Response("not found", { status: 404 });
    return typeof f === "function" ? f() : new Response(f, { status: 200 });
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

async function call(method, path, { body, token, origin = SITE } = {}) {
  const headers = {};
  if (origin) headers.origin = origin;
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const pending = [];
  const res = await worker.fetch(
    new Request("https://api.example.workers.dev" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
    env,
    { waitUntil: (p) => pending.push(p) },
  );
  await Promise.all(pending);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers, text };
}

const lastCodeFor = (email) => {
  const m = [...outbox].reverse().find((e) => e.to === email);
  return m && /code is (\d{6})/.exec(m.text)[1];
};

async function signIn(email, device = "Test browser") {
  const r1 = await call("POST", "/api/auth/request", { body: { email } });
  assert.equal(r1.status, 200);
  const code = lastCodeFor(email);
  assert.ok(code, `no code emailed to ${email}`);
  const r2 = await call("POST", "/api/auth/verify", { body: { email, code, device } });
  assert.equal(r2.status, 200, JSON.stringify(r2.data));
  return r2.data.token;
}

const event = (over = {}) => ({ title: "Dentist", date: "2026-10-01", startTime: "15:00", endTime: "16:00", color: "#0E7C86", ...over });

/* ------------------------------------------------------------------ */

describe("sign-in with an email code", () => {
  test("the answer is identical for staff and unknown emails, and only staff get a code", async () => {
    const staff = await call("POST", "/api/auth/request", { body: { email: A } });
    const stranger = await call("POST", "/api/auth/request", { body: { email: "nobody@example.com" } });
    assert.equal(staff.status, stranger.status);
    assert.deepEqual(staff.data, stranger.data);
    assert.deepEqual(outbox.map((m) => m.to), [A]);
  });

  test("codes are stored hashed, never in plain text", async () => {
    await call("POST", "/api/auth/request", { body: { email: A } });
    const code = lastCodeFor(A);
    const [row] = env.DB.q("SELECT * FROM login_codes WHERE email = ?", A);
    assert.ok(row.code_hash.length >= 40);
    assert.ok(!JSON.stringify(row).includes(code));
  });

  test("a correct code signs the device in for 365 days; the session stores only a hash of the token", async () => {
    const token = await signIn(A);
    const [s] = env.DB.q("SELECT * FROM sessions WHERE email = ?", A);
    assert.notEqual(s.id, token);
    assert.ok(!JSON.stringify(s).includes(token));
    assert.ok(Math.abs(s.expires_at - (Date.now() + 365 * 864e5)) < 60e3);
    assert.equal(s.device, "Test browser");
    assert.ok(env.DB.q("SELECT last_sign_in FROM staff WHERE email = ?", A)[0].last_sign_in > 0);
    const boot = await call("GET", "/api/bootstrap", { token });
    assert.equal(boot.status, 200);
    assert.equal(boot.data.me.email, A);
    assert.equal(boot.data.me.isAdmin, false);
  });

  test("a code can only be used once", async () => {
    await call("POST", "/api/auth/request", { body: { email: A } });
    const code = lastCodeFor(A);
    assert.equal((await call("POST", "/api/auth/verify", { body: { email: A, code } })).status, 200);
    assert.equal((await call("POST", "/api/auth/verify", { body: { email: A, code } })).status, 400);
  });

  test("5 wrong tries cancel the code", async () => {
    await call("POST", "/api/auth/request", { body: { email: A } });
    const code = lastCodeFor(A);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 1; i <= 5; i++) {
      const r = await call("POST", "/api/auth/verify", { body: { email: A, code: wrong } });
      assert.equal(r.status, 400);
      if (i < 5) assert.match(r.data.error, new RegExp(`${5 - i} tr`));
    }
    const r = await call("POST", "/api/auth/verify", { body: { email: A, code } });
    assert.equal(r.status, 400, "the right code no longer works");
  });

  test("codes expire after 10 minutes", async () => {
    await call("POST", "/api/auth/request", { body: { email: A } });
    const code = lastCodeFor(A);
    const [row] = env.DB.q("SELECT expires_at FROM login_codes WHERE email = ?", A);
    assert.ok(Math.abs(row.expires_at - (Date.now() + 10 * 60e3)) < 5e3);
    env.DB.q("UPDATE login_codes SET expires_at = ? WHERE email = ?", Date.now() - 1, A);
    const r = await call("POST", "/api/auth/verify", { body: { email: A, code } });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /expired/);
  });

  test("at most 3 codes per email per hour (the 4th request looks the same but sends nothing)", async () => {
    const answers = [];
    for (let i = 0; i < 4; i++) answers.push((await call("POST", "/api/auth/request", { body: { email: A } })).data);
    assert.equal(outbox.length, 3);
    assert.deepEqual(answers[3], answers[0]);
    // An hour later it works again.
    env.DB.q("UPDATE login_codes SET window_start = ? WHERE email = ?", Date.now() - 3601e3, A);
    await call("POST", "/api/auth/request", { body: { email: A } });
    assert.equal(outbox.length, 4);
  });

  test("admins can sign in without being on the staff list", async () => {
    const token = await signIn(ADMIN);
    const boot = await call("GET", "/api/bootstrap", { token });
    assert.equal(boot.data.me.isAdmin, true);
  });

  test("bad input is rejected politely", async () => {
    assert.equal((await call("POST", "/api/auth/request", { body: { email: "not an email" } })).status, 400);
    assert.equal((await call("POST", "/api/auth/verify", { body: { email: A, code: "12" } })).status, 400);
    const big = await call("POST", "/api/auth/request", { body: { email: "a".repeat(5000) + "@x.edu" } });
    assert.equal(big.status, 413);
  });
});

describe("sessions", () => {
  test("no token, a made-up token, or a malformed header → 401", async () => {
    assert.equal((await call("GET", "/api/bootstrap")).status, 401);
    assert.equal((await call("GET", "/api/bootstrap", { token: "x".repeat(43) })).status, 401);
    assert.equal((await call("GET", "/api/events", { token: "<script>" })).status, 401);
  });

  test("“Sign out of this device” ends only that device", async () => {
    const laptop = await signIn(A, "Laptop");
    const phone = await signIn(A, "Phone");
    assert.equal((await call("POST", "/api/auth/signout", { token: laptop })).status, 200);
    assert.equal((await call("GET", "/api/bootstrap", { token: laptop })).status, 401);
    assert.equal((await call("GET", "/api/bootstrap", { token: phone })).status, 200);
  });

  test("removing someone from the staff list ends all their sessions immediately", async () => {
    const admin = await signIn(ADMIN);
    const t1 = await signIn(A, "Laptop");
    const t2 = await signIn(A, "Phone");
    const r = await call("DELETE", `/api/admin/staff/${encodeURIComponent(A)}`, { token: admin });
    assert.equal(r.status, 200);
    assert.equal(r.data.devicesSignedOut, 2);
    assert.equal((await call("GET", "/api/bootstrap", { token: t1 })).status, 401);
    assert.equal((await call("GET", "/api/bootstrap", { token: t2 })).status, 401);
    // They can't get a new code either.
    outbox.length = 0;
    await call("POST", "/api/auth/request", { body: { email: A } });
    assert.equal(outbox.length, 0);
  });

  test("a session for someone no longer on the list is refused even if the row survived", async () => {
    const t = await signIn(A);
    env.DB.q("DELETE FROM staff WHERE email = ?", A);
    assert.equal((await call("GET", "/api/bootstrap", { token: t })).status, 401);
    assert.equal(env.DB.q("SELECT COUNT(*) AS n FROM sessions WHERE email = ?", A)[0].n, 0);
  });

  test("expired sessions are refused", async () => {
    const t = await signIn(A);
    env.DB.q("UPDATE sessions SET expires_at = ? WHERE email = ?", Date.now() - 1, A);
    assert.equal((await call("GET", "/api/bootstrap", { token: t })).status, 401);
  });

  test("admin can list a person's devices and revoke them", async () => {
    const admin = await signIn(ADMIN);
    await signIn(A, "Laptop");
    const phone = await signIn(A, "Phone");
    const list = await call("GET", `/api/admin/staff/${encodeURIComponent(A)}/sessions`, { token: admin });
    assert.deepEqual(list.data.sessions.map((s) => s.device).sort(), ["Laptop", "Phone"]);
    const staff = await call("GET", "/api/admin/staff", { token: admin });
    assert.equal(staff.data.staff.find((s) => s.email === A).devices, 2);
    const one = list.data.sessions.find((s) => s.device === "Laptop");
    assert.equal((await call("DELETE", `/api/admin/sessions/${one.id}`, { token: admin })).status, 200);
    assert.equal((await call("GET", "/api/bootstrap", { token: phone })).status, 200);
    assert.equal((await call("DELETE", `/api/admin/staff/${encodeURIComponent(A)}/sessions`, { token: admin })).data.devicesSignedOut, 1);
    assert.equal((await call("GET", "/api/bootstrap", { token: phone })).status, 401);
  });
});

describe("personal events are private", () => {
  test("user A can't read, change or delete user B's events", async () => {
    const a = await signIn(A);
    const b = await signIn(B);
    const created = await call("POST", "/api/events", { token: a, body: event({ title: "A's private thing" }) });
    assert.equal(created.status, 201);
    const id = created.data.event.id;

    const bList = await call("GET", "/api/events", { token: b });
    assert.deepEqual(bList.data.events, []);
    assert.ok(!bList.text.includes("private thing"));

    assert.equal((await call("PUT", `/api/events/${id}`, { token: b, body: event({ title: "hacked" }) })).status, 404);
    assert.equal((await call("DELETE", `/api/events/${id}`, { token: b })).status, 404);

    const aList = await call("GET", "/api/events", { token: a });
    assert.equal(aList.data.events.length, 1);
    assert.equal(aList.data.events[0].title, "A's private thing");
  });

  test("the owner can create, edit and delete; weekly repeats need an end date", async () => {
    const a = await signIn(A);
    const { data } = await call("POST", "/api/events", { token: a, body: event() });
    const id = data.event.id;
    const upd = await call("PUT", `/api/events/${id}`, { token: a, body: event({ title: "Dentist (moved)", repeatWeekly: true, repeatUntil: "2026-12-01", location: "Main St" }) });
    assert.equal(upd.status, 200);
    assert.equal(upd.data.event.repeatWeekly, true);
    assert.equal(upd.data.event.location, "Main St");
    assert.equal((await call("PUT", `/api/events/${id}`, { token: a, body: event({ repeatWeekly: true }) })).status, 400);
    const allDay = await call("POST", "/api/events", { token: a, body: { title: "Conference", date: "2026-10-05", allDay: true, color: "#983BAE" } });
    assert.equal(allDay.status, 201);
    assert.equal(allDay.data.event.startTime, null);
    assert.equal((await call("DELETE", `/api/events/${id}`, { token: a })).status, 200);
    assert.equal((await call("DELETE", `/api/events/${id}`, { token: a })).status, 404);
  });

  test("inputs are validated and limited", async () => {
    const a = await signIn(A);
    const bad = [
      event({ title: "" }),
      event({ title: "x".repeat(201) }),
      event({ date: "2026-02-30" }),
      event({ startTime: "16:00", endTime: "15:00" }),
      event({ startTime: "25:00" }),
      event({ color: "red; background:url(x)" }),
      event({ notes: "n".repeat(2001) }),
      event({ repeatWeekly: true, repeatUntil: "2026-09-01" }),
      event({ repeatWeekly: true, repeatUntil: "2030-01-01" }),
    ];
    for (const body of bad) assert.equal((await call("POST", "/api/events", { token: a, body })).status, 400, JSON.stringify(body));
    const r = await call("POST", "/api/events", { token: a, body: "[1,2]" });
    assert.equal(r.status, 400);
  });

  test("HTML in titles is stored as plain text (the website shows it with textContent)", async () => {
    const a = await signIn(A);
    const r = await call("POST", "/api/events", { token: a, body: event({ title: "<img src=x onerror=alert(1)>" }) });
    assert.equal(r.status, 201);
    assert.equal(r.data.event.title, "<img src=x onerror=alert(1)>");
    assert.equal(r.headers.get("content-type"), "application/json; charset=utf-8");
  });

  test("calendar toggles are saved per person", async () => {
    const a = await signIn(A);
    const b = await signIn(B);
    assert.equal((await call("PUT", "/api/prefs", { token: a, body: { visible: { "shared:1": false, mine: true, "bogus key": true } } })).status, 200);
    assert.deepEqual((await call("GET", "/api/bootstrap", { token: a })).data.visible, { "shared:1": false, mine: true });
    assert.deepEqual((await call("GET", "/api/bootstrap", { token: b })).data.visible, {});
  });

  test("personal calendar links are private to their owner", async () => {
    feeds.set("https://calendar.google.com/calendar/ical/alice/basic.ics", ICS("Alice's dentist"));
    const a = await signIn(A);
    const b = await signIn(B);
    const add = await call("POST", "/api/my-feeds", { token: a, body: { name: "My Google", url: "https://calendar.google.com/calendar/ical/alice/basic.ics", color: "#123456" } });
    assert.equal(add.status, 201);
    assert.equal(add.data.feed.source, "google");
    assert.equal(add.data.feed.url, undefined, "the full link isn't sent back");
    const id = add.data.feed.id;
    assert.equal((await call("GET", `/api/feeds/mine/${id}`, { token: a })).status, 200);
    assert.equal((await call("GET", `/api/feeds/mine/${id}`, { token: b })).status, 404);
    assert.equal((await call("DELETE", `/api/my-feeds/${id}`, { token: b })).status, 404);
    assert.equal((await call("PUT", `/api/my-feeds/${id}`, { token: b, body: { name: "x", color: "#000000" } })).status, 404);
    assert.deepEqual((await call("GET", "/api/my-feeds", { token: b })).data.feeds, []);
    assert.equal((await call("DELETE", `/api/my-feeds/${id}`, { token: a })).status, 200);
  });

  test("bad personal links are refused", async () => {
    const a = await signIn(A);
    for (const url of ["http://example.com/cal.ics", "https://localhost/x.ics", "https://10.0.0.1/cal.ics", "javascript:alert(1)", "https://example.com/missing.ics"]) {
      const r = await call("POST", "/api/my-feeds", { token: a, body: { name: "X", url, color: "#123456" } });
      assert.equal(r.status, 400, url);
    }
  });
});

describe("admin-only endpoints", () => {
  const adminRoutes = [
    ["GET", "/api/admin/staff"], ["POST", "/api/admin/staff", { emails: "x@marist.edu" }],
    ["DELETE", `/api/admin/staff/${encodeURIComponent(B)}`], ["GET", `/api/admin/staff/${encodeURIComponent(B)}/sessions`],
    ["DELETE", `/api/admin/staff/${encodeURIComponent(B)}/sessions`], ["DELETE", "/api/admin/sessions/abc"],
    ["GET", "/api/admin/calendars"], ["POST", "/api/admin/calendars", { name: "X", color: "#123456", url: "https://example.com/a.ics" }],
    ["PUT", "/api/admin/calendars/1", { name: "X" }], ["DELETE", "/api/admin/calendars/1"], ["POST", "/api/admin/calendars/order", { ids: [1] }],
    ["POST", "/api/admin/test-feed", { url: "https://example.com/a.ics" }],
    ["GET", "/api/admin/settings"], ["PUT", "/api/admin/settings", { siteTitle: "Hacked" }], ["GET", "/api/admin/log"],
  ];

  test("non-admins get 403 on every admin endpoint, and nothing changes", async () => {
    const a = await signIn(A);
    for (const [method, path, body] of adminRoutes) {
      const r = await call(method, path, { token: a, body });
      assert.equal(r.status, 403, `${method} ${path}`);
    }
    assert.equal(env.DB.q("SELECT COUNT(*) AS n FROM staff")[0].n, 2);
    assert.equal(env.DB.q("SELECT COUNT(*) AS n FROM settings")[0].n, 0);
  });

  test("signed-out callers get 401 on every admin endpoint", async () => {
    for (const [method, path, body] of adminRoutes) assert.equal((await call(method, path, { body })).status, 401, `${method} ${path}`);
  });

  test("shared calendar links never reach non-admins", async () => {
    const secretUrl = "https://outlook.office365.com/owa/calendar/abc/SECRET123/calendar.ics";
    feeds.set(secretUrl, ICS());
    const admin = await signIn(ADMIN);
    const created = await call("POST", "/api/admin/calendars", { token: admin, body: { name: "Student Work Schedule", color: "#B07A00", url: secretUrl, isShift: true, owner: "Office" } });
    assert.equal(created.status, 201);
    assert.equal(created.data.calendar.source, "outlook");
    const a = await signIn(A);
    const boot = await call("GET", "/api/bootstrap", { token: a });
    assert.ok(!boot.text.includes("SECRET123"));
    assert.equal(boot.data.calendars[0].isShift, true);
    const feed = await call("GET", `/api/feeds/shared/${created.data.calendar.id}`, { token: a });
    assert.equal(feed.status, 200);
    assert.ok(!JSON.stringify([...feed.headers]).includes("SECRET123"));
  });

  test("adding staff by pasting, with welcome emails, is logged", async () => {
    const admin = await signIn(ADMIN);
    outbox.length = 0;
    const r = await call("POST", "/api/admin/staff", { token: admin, body: { emails: `New Person <new@marist.edu>, ${A}\nother@marist.edu; not-an-email`, welcome: true } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.added.sort(), ["new@marist.edu", "other@marist.edu"]);
    assert.deepEqual(r.data.already, [A]);
    assert.equal(r.data.welcomed, 2);
    assert.deepEqual(outbox.map((m) => m.to).sort(), ["new@marist.edu", "other@marist.edu"]);
    assert.match(outbox[0].text, /scsm\.web\.app/);
    const log = await call("GET", "/api/admin/log", { token: admin });
    assert.equal(log.data.log[0].actor, ADMIN);
    assert.match(log.data.log[0].detail, /Added 2 staff/);
  });

  test("admins can't be removed through the staff list", async () => {
    const admin = await signIn(ADMIN);
    assert.equal((await call("DELETE", `/api/admin/staff/${encodeURIComponent(ADMIN)}`, { token: admin })).status, 400);
  });

  test("test link reports the number of events and titles, or the error", async () => {
    feeds.set("https://example.com/work.ics", ICS());
    const admin = await signIn(ADMIN);
    const ok = await call("POST", "/api/admin/test-feed", { token: admin, body: { url: "https://example.com/work.ics" } });
    assert.deepEqual([ok.data.ok, ok.data.events], [true, 2]);
    assert.ok(ok.data.titles.includes("Front desk: Sam"));
    const bad = await call("POST", "/api/admin/test-feed", { token: admin, body: { url: "https://example.com/gone.ics" } });
    assert.equal(bad.data.ok, false);
    assert.match(bad.data.error, /not found/);
  });

  test("calendar edits, reorder and settings are logged", async () => {
    feeds.set("https://example.com/a.ics", ICS());
    const admin = await signIn(ADMIN);
    const c1 = (await call("POST", "/api/admin/calendars", { token: admin, body: { name: "One", color: "#111111", url: "https://example.com/a.ics" } })).data.calendar;
    const c2 = (await call("POST", "/api/admin/calendars", { token: admin, body: { name: "Two", color: "#222222", url: "https://example.com/a.ics", defaultOn: false } })).data.calendar;
    assert.equal((await call("PUT", `/api/admin/calendars/${c1.id}`, { token: admin, body: { name: "One!", isShift: true } })).status, 200);
    assert.equal((await call("POST", "/api/admin/calendars/order", { token: admin, body: { ids: [c2.id, c1.id] } })).status, 200);
    const s = await call("PUT", "/api/admin/settings", { token: admin, body: { siteTitle: "SCSM Staff", coverage: { minStaff: 2, slotMinutes: 15, closed: [{ from: "2026-11-26", to: "2026-11-27", label: "Thanksgiving" }] } } });
    assert.equal(s.status, 200);
    assert.equal(s.data.coverage.minStaff, 2);
    assert.equal(s.data.coverage.slotMinutes, 15);
    const a = await signIn(A);
    const boot = (await call("GET", "/api/bootstrap", { token: a })).data;
    assert.deepEqual(boot.calendars.map((c) => c.name), ["Two", "One!"]);
    assert.equal(boot.site.title, "SCSM Staff");
    assert.equal(boot.coverage.closed[0].label, "Thanksgiving");
    const actions = (await call("GET", "/api/admin/log", { token: admin })).data.log.map((l) => l.action);
    assert.deepEqual(actions.slice(0, 5), ["settings.edit", "calendar.reorder", "calendar.edit", "calendar.add", "calendar.add"]);
  });
});

describe("calendar feeds", () => {
  test("feeds are cached ~20 minutes and the last good copy is served when the source is down", async () => {
    const url = "https://calendar.google.com/calendar/ical/clubs/basic.ics";
    feeds.set(url, ICS("Hackathon"));
    const admin = await signIn(ADMIN);
    const id = (await call("POST", "/api/admin/calendars", { token: admin, body: { name: "Club Events", color: "#1B7F52", url } })).data.calendar.id;
    const a = await signIn(A);

    const first = await call("GET", `/api/feeds/shared/${id}`, { token: a });
    assert.equal(first.status, 200);
    assert.match(first.text, /Hackathon/);
    assert.equal(first.headers.get("x-feed-status"), "fresh");
    const hits = feedHits;
    await call("GET", `/api/feeds/shared/${id}`, { token: a });
    assert.equal(feedHits, hits, "second load comes from the cache");

    // 21 minutes later the source is down.
    env.DB.q("UPDATE feed_cache SET checked_at = checked_at - ?", 21 * 60e3);
    feeds.set(url, () => new Response("oops", { status: 500 }));
    const stale = await call("GET", `/api/feeds/shared/${id}`, { token: a });
    assert.equal(stale.status, 200);
    assert.match(stale.text, /Hackathon/);
    assert.equal(stale.headers.get("x-feed-status"), "stale");
  });

  test("a feed that never worked gives a friendly error", async () => {
    feeds.set("https://example.com/c.ics", ICS());
    const admin = await signIn(ADMIN);
    const id = (await call("POST", "/api/admin/calendars", { token: admin, body: { name: "Club Events", color: "#1B7F52", url: "https://example.com/c.ics" } })).data.calendar.id;
    feeds.delete("https://example.com/c.ics");
    const a = await signIn(A);
    const r = await call("GET", `/api/feeds/shared/${id}`, { token: a });
    assert.equal(r.status, 502);
    assert.match(r.data.error, /Couldn't load Club Events right now/);
  });
});

describe("CORS", () => {
  test("only the site's own address is allowed", async () => {
    const ok = await call("POST", "/api/auth/request", { body: { email: A } });
    assert.equal(ok.headers.get("access-control-allow-origin"), SITE);
    const evil = await call("POST", "/api/auth/request", { body: { email: A }, origin: "https://evil.example" });
    assert.equal(evil.status, 403);
    assert.equal(evil.headers.get("access-control-allow-origin"), null);
    const pre = await worker.fetch(new Request("https://api/api/events", { method: "OPTIONS", headers: { origin: "https://evil.example" } }), env, {});
    assert.equal(pre.status, 403);
  });

  test("localhost is only allowed in dev mode", async () => {
    assert.equal((await call("GET", "/", { origin: "http://localhost:5500" })).status, 403);
    env.DEV_MODE = "true";
    assert.equal((await call("GET", "/", { origin: "http://localhost:5500" })).status, 200);
  });
});
