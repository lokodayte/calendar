// SCSM Calendar — main app: sign-in, calendar view, sidebar toggles, event details and editors.

import { api, apiFeed, getToken, setToken, clearToken, whenSignedOut, apiConfigured } from "./api.js";
import { $, $$, h, toast, setErr, confirmDialog, busy, colorPicker, sourceIcon, SOURCES, fmtDate, fmtTime, linkify, eventColors } from "./dom.js";
import { TZ, zonedToUtc, parseHm, addDays, ymd } from "./tz.js";
import { parseIcs, expandIcs } from "./ics.js";
import { initAdmin } from "./admin-view.js";
import { initPublic } from "./public-view.js";

const ICAL = window.ICAL;

const S = {
  me: null, site: null, calendars: [], myFeeds: [], visible: {},
  events: [],              // my personal events (from the server)
  feeds: new Map(),        // key -> {at, promise, parsed, stale, error}
  fc: null,
  tab: "calendar",
};

/* =====================================================================
   Sign-in
   ===================================================================== */

let pendingEmail = "";

function deviceLabel() {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /iPhone|iPad/.test(ua) ? "iPhone/iPad" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /CrOS/.test(ua) ? "Chromebook" : /Linux/.test(ua) ? "Linux" : "device";
  return `${browser} on ${os}`;
}

/** The sign-in window, over the public front page. */
function openSignIn(message) {
  $("#formEmail").hidden = false;
  $("#formCode").hidden = true;
  setErr($("#errEmail"), message || "");
  if (!$("#dlgSignin").open) $("#dlgSignin").showModal();
  $("#inEmail").focus();
}

let publicView = null;
function showPublic() {
  $("#boot").hidden = true;
  $("#app").hidden = true;
  $("#public").hidden = false;
  const signedIn = !!S.me && !!getToken();
  for (const id of ["#btnStaffSignIn"]) $(id).textContent = signedIn ? "My calendar" : "Staff sign in";
  publicView = publicView || initPublic({ openEvent: (ev) => openEvent(ev) });
  publicView.show();
}
const staffButton = () => (S.me && getToken() ? (location.hash = "#calendar") : openSignIn());
$("#btnStaffSignIn").onclick = staffButton;
$("#btnStaffSignIn2").onclick = staffButton;

$("#formEmail").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("#inEmail").value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return setErr($("#errEmail"), "Enter your full work email, like name@marist.edu.");
  setErr($("#errEmail"));
  await busy($("#btnSend"), "Sending…", async () => {
    try {
      const r = await api("/api/auth/request", { method: "POST", body: { email } });
      pendingEmail = email;
      $("#codeMsg").textContent = `${r.message} It works for 10 minutes. You can ask for up to 3 codes an hour, so if one is slow, wait for it rather than asking again.`;
      $("#inCode").value = "";
      setErr($("#errCode"));
      $("#formEmail").hidden = true;
      $("#formCode").hidden = false;
      $("#inCode").focus();
    } catch (err) { setErr($("#errEmail"), err.message); }
  });
});

$("#inCode").addEventListener("input", (e) => {
  e.target.value = e.target.value.replace(/\D/g, "").slice(0, 6);
});

$("#formCode").addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = $("#inCode").value;
  if (code.length !== 6) return setErr($("#errCode"), "Enter the 6-digit code from your email.");
  const remember = $("#inRemember").checked;
  await busy($("#btnVerify"), "Checking…", async () => {
    try {
      const r = await api("/api/auth/verify", { method: "POST", body: { email: pendingEmail, code, remember, device: deviceLabel() } });
      setToken(r.token, remember);
      $("#dlgSignin").close();
      if (location.hash === "#public") history.replaceState(null, "", "#calendar");
      await start();
    } catch (err) {
      setErr($("#errCode"), err.message);
      $("#inCode").select();
    }
  });
});

$("#btnBack").onclick = () => { $("#formCode").hidden = true; $("#formEmail").hidden = false; $("#inEmail").focus(); };

whenSignedOut((msg) => {
  S.feeds.clear();
  S.me = null;
  for (const d of $$("dialog[open]")) d.close();
  showPublic();
  openSignIn(msg);
});

async function signOut() {
  try { await api("/api/auth/signout", { method: "POST" }); } catch { /* already gone */ }
  clearToken();
  location.hash = "";
  location.reload();
}

/* =====================================================================
   Loading data
   ===================================================================== */

const keyShared = (id) => `shared:${id}`;
const keyFeed = (id) => `feed:${id}`;

function isOn(key) {
  if (key in S.visible) return !!S.visible[key];
  if (key.startsWith("shared:")) {
    const c = S.calendars.find((x) => keyShared(x.id) === key);
    return c ? c.defaultOn : false;
  }
  return true;
}

/** Load (once every 5 minutes) and parse a feed. */
export function loadFeed(key) {
  const cached = S.feeds.get(key);
  if (cached && Date.now() - cached.at < 5 * 60e3) return cached.promise;
  const [kind, id] = key.split(":");
  const path = kind === "shared" ? `/api/feeds/shared/${id}` : `/api/feeds/mine/${id}`;
  const entry = { at: Date.now() };
  entry.promise = apiFeed(path).then((r) => {
    entry.parsed = parseIcs(ICAL, r.text);
    entry.stale = r.stale;
    entry.fetchedAt = r.fetchedAt;
    noteFeedState(key, r.stale ? "stale" : "ok");
    return entry;
  }, (err) => {
    S.feeds.delete(key);
    noteFeedState(key, "error", err.message);
    throw err;
  });
  S.feeds.set(key, entry);
  return entry.promise;
}

function calFor(key) {
  if (key.startsWith("shared:")) {
    const c = S.calendars.find((x) => keyShared(x.id) === key);
    return c && { ...c, kind: "shared" };
  }
  const f = S.myFeeds.find((x) => keyFeed(x.id) === key);
  return f && { ...f, kind: "feed", owner: "" };
}

/* ---------- notices (feed problems) ---------- */

const feedState = new Map();
function noteFeedState(key, state, message) {
  const prev = feedState.get(key);
  feedState.set(key, { state, message });
  if (!prev || prev.state !== state) renderNotices();
  renderSidebar();
}

function renderNotices() {
  const box = $("#notices");
  box.textContent = "";
  for (const [key, st] of feedState) {
    const cal = calFor(key);
    if (!cal || !isOn(key) || st.state === "ok" || st.dismissed) continue;
    const text = st.state === "stale"
      ? `Couldn't load ${cal.name} right now. Showing the last saved copy.`
      : `Couldn't load ${cal.name} right now. We'll try again in a few minutes.`;
    box.append(h("div", { class: `notice${st.state === "error" ? " error" : ""}` },
      h("span", { class: "grow", text }),
      h("button", { type: "button", "aria-label": "Dismiss", text: "×", onclick: () => { st.dismissed = true; renderNotices(); } })));
  }
}

async function loadMyEvents() {
  S.events = (await api("/api/my-agenda")).events;
}

/* =====================================================================
   Sidebar
   ===================================================================== */

let savePrefsTimer;
function toggle(key) {
  S.visible[key] = !isOn(key);
  renderSidebar();
  refreshSources();
  renderNotices();
  clearTimeout(savePrefsTimer);
  savePrefsTimer = setTimeout(() => {
    api("/api/prefs", { method: "PUT", body: { visible: S.visible } }).catch((err) => toast(`Couldn't save your choices: ${err.message}`));
  }, 700);
}

function calRow(key, { name, color, source, extra }) {
  const on = isOn(key);
  const st = feedState.get(key);
  const btn = h("button", {
    type: "button", class: "cal-toggle", role: "switch", "aria-checked": String(on), style: { "--c": color },
    title: `${on ? "Hide" : "Show"} ${name}`, onclick: () => toggle(key),
  },
  h("span", { class: "box" }),
  h("span", { class: "nm", text: name }),
  st && st.state === "error" && on ? h("span", { class: "state", text: "!", title: st.message }) : null,
  h("span", { class: "src", title: SOURCES[source]?.label || "" }, sourceIcon(source)));
  return h("li", { class: "cal-item" }, btn, extra || null);
}

function renderSidebar() {
  const shared = $("#listShared");
  shared.textContent = "";
  if (!S.calendars.length) {
    shared.append(h("li", { class: "empty-line", text: S.me?.isAdmin ? "No shared calendars yet. Add them in the Admin tab." : "No shared calendars yet." }));
  }
  for (const c of S.calendars) shared.append(calRow(keyShared(c.id), c));

  const mine = $("#listMine");
  mine.textContent = "";
  mine.append(calRow("mine", { name: "My events", color: "#0E7C86", source: "scsm" }));
  for (const f of S.myFeeds) {
    mine.append(calRow(keyFeed(f.id), {
      ...f,
      extra: h("button", { type: "button", class: "more", "aria-label": `Edit ${f.name}`, title: "Edit", text: "⋯", onclick: () => openFeedEditor(f) }),
    }));
  }
}

/* ---------- phone drawer ---------- */

function setDrawer(open) {
  $("#sidebar").classList.toggle("open", open);
  $("#scrim").hidden = !open;
  $("#btnDrawer").setAttribute("aria-expanded", String(open));
}
$("#btnDrawer").onclick = () => { if (S.tab !== "calendar") showTab("calendar"); setDrawer(true); };
$("#btnDrawerClose").onclick = () => setDrawer(false);
$("#scrim").onclick = () => setDrawer(false);

/* =====================================================================
   Calendar
   ===================================================================== */

const isPhone = () => window.matchMedia("(max-width: 800px)").matches;

function buildCalendar() {
  const phone = isPhone();
  S.fc = new FullCalendar.Calendar($("#calendar"), {
    initialView: phone ? "listWeek" : "dayGridMonth",
    headerToolbar: phone
      ? { left: "prev,next today", center: "", right: "listWeek,dayGridMonth" }
      : { left: "prev,next today", center: "title", right: "dayGridMonth,timeGridWeek,listWeek" },
    footerToolbar: phone ? { center: "title" } : false,
    buttonText: { today: "Today", month: "Month", week: "Week", list: "List" },
    height: "auto",
    dayMaxEventRows: 4,
    eventDisplay: "block",
    nowIndicator: true,
    scrollTime: "08:00:00",
    slotMinTime: "07:00:00",
    slotMaxTime: "21:00:00",
    firstDay: 0,
    eventTimeFormat: { hour: "numeric", minute: "2-digit", omitZeroMinute: true, meridiem: "short" },
    noEventsContent: "No events on the calendars you're showing.",
    eventClick(info) { info.jsEvent.preventDefault(); openEvent(info.event); },
    eventDidMount(info) {
      const loc = info.event.extendedProps.location;
      info.el.title = info.event.title + (loc ? ` — ${loc}` : "");
    },
    dateClick: undefined,
  });
  S.fc.render();
}

function feedSource(key) {
  const cal = calFor(key);
  return {
    id: key,
    events: (info, ok, fail) => {
      loadFeed(key).then((entry) => {
        const occs = expandIcs(entry.parsed, info.start.getTime(), info.end.getTime());
        ok(occs.map((o) => ({
          id: `${key}|${o.key}`,
          title: o.title,
          start: o.allDay ? o.startDate : new Date(o.start),
          end: o.allDay ? o.endDate : new Date(o.end),
          allDay: o.allDay,
          ...eventColors(cal.color),
          extendedProps: { kind: cal.kind, cal, color: cal.color, location: o.location, description: o.description },
        })));
      }, () => ok([]));
    },
  };
}

/** Personal events → concrete occurrences between two instants. */
function personalOccurrences(fromMs, toMs) {
  const out = [];
  const fromDay = addDays(ymd(fromMs, TZ), -1), toDay = addDays(ymd(toMs, TZ), 1);
  for (const e of S.events) {
    const last = e.repeatWeekly ? e.repeatUntil : e.date;
    for (let d = e.date, n = 0; d <= last && n < 200; d = addDays(d, 7), n++) {
      if (d < fromDay) continue;
      if (d > toDay) break;
      const base = { title: e.title, ...eventColors(e.color), extendedProps: { kind: "mine", personal: e, color: e.color, location: e.location, description: e.notes, occurrenceDate: d } };
      if (e.allDay) out.push({ ...base, id: `mine|${e.id}|${d}`, start: d, end: addDays(d, 1), allDay: true });
      else out.push({ ...base, id: `mine|${e.id}|${d}`, start: new Date(zonedToUtc(d, parseHm(e.startTime))), end: new Date(zonedToUtc(d, parseHm(e.endTime))) });
    }
  }
  return out;
}

function refreshSources() {
  if (!S.fc) return;
  for (const src of S.fc.getEventSources()) src.remove();
  for (const c of S.calendars) if (isOn(keyShared(c.id))) S.fc.addEventSource(feedSource(keyShared(c.id)));
  for (const f of S.myFeeds) if (isOn(keyFeed(f.id))) S.fc.addEventSource(feedSource(keyFeed(f.id)));
  if (isOn("mine")) {
    S.fc.addEventSource({ id: "mine", events: (info, ok) => ok(personalOccurrences(info.start.getTime(), info.end.getTime())) });
  }
}

/* ---------- event details ---------- */

function whenText(ev) {
  const s = ev.start, e = ev.end;
  if (ev.allDay) {
    const last = e ? new Date(e.getTime() - 864e5) : s;
    return last > s ? `${fmtDate(s)} – ${fmtDate(last)}` : `${fmtDate(s)} (all day)`;
  }
  if (!e) return `${fmtDate(s)}, ${fmtTime(s)}`;
  return s.toDateString() === e.toDateString()
    ? `${fmtDate(s)}, ${fmtTime(s)} – ${fmtTime(e)}`
    : `${fmtDate(s)} ${fmtTime(s)} – ${fmtDate(e)} ${fmtTime(e)}`;
}

function openEvent(ev) {
  const p = ev.extendedProps;
  const color = p.color || ev.borderColor;
  $("#evStripe").style.setProperty("--c", color);
  $("#evSwatch").style.setProperty("--c", color);
  $("#evTitle").textContent = ev.title;
  $("#evWhen").textContent = whenText(ev);
  $("#evLoc").textContent = p.location || "";
  for (const el of $$('[data-row="loc"]', $("#dlgEvent"))) el.hidden = !p.location;

  let calName, source, owner = "", sourceText;
  if (p.kind === "mine") {
    calName = "My events";
    source = "scsm";
    sourceText = `${SOURCES.scsm.from} · only you can see this`;
  } else if (p.kind === "public") {
    calName = p.cal.name;
    source = p.cal.source;
    owner = p.cal.owner || "";
    sourceText = p.cal.name;
  } else {
    calName = p.cal.name;
    source = p.cal.source;
    owner = p.cal.owner || "";
    sourceText = `${SOURCES[source]?.from || SOURCES.other.from} — ${p.cal.name}${p.kind === "feed" ? " · only you can see this" : ""}`;
  }
  $("#evCal").textContent = calName;
  $("#evOwner").textContent = owner;
  for (const el of $$('[data-row="owner"]', $("#dlgEvent"))) el.hidden = !owner;
  const src = $("#evSource");
  src.textContent = "";
  src.append(sourceIcon(source), h("span", { text: sourceText }));
  linkify($("#evDesc"), p.description || "");

  $("#evActions").hidden = p.kind !== "mine";
  if (p.kind === "mine") {
    $("#evEdit").onclick = () => { $("#dlgEvent").close(); openEventEditor(p.personal); };
    $("#evDelete").onclick = async () => {
      const repeat = p.personal.repeatWeekly ? " This deletes every week of it." : "";
      if (!(await confirmDialog("Delete this event?", `“${p.personal.title}” will be removed.${repeat}`, "Delete"))) return;
      try {
        await api(`/api/my-agenda/${p.personal.id}`, { method: "DELETE" });
        S.events = S.events.filter((x) => x.id !== p.personal.id);
        $("#dlgEvent").close();
        refreshSources();
        toast("Event deleted.");
      } catch (err) { toast(err.message); }
    };
  }
  $("#dlgEvent").showModal();
}

/* ---------- add / edit personal event ---------- */

let editing = null;
let eventColor;

function openEventEditor(ev) {
  editing = ev || null;
  const today = ymd(Date.now(), TZ);
  const e = ev || { title: "", date: today, allDay: false, startTime: "09:00", endTime: "10:00", location: "", notes: "", repeatWeekly: false, repeatUntil: null, color: "#0E7C86" };
  $("#editHeading").textContent = ev ? "Edit event" : "Add event";
  $("#feTitle").value = e.title;
  $("#feDate").value = e.date;
  $("#feAllDay").checked = e.allDay;
  $("#feStart").value = e.startTime || "09:00";
  $("#feEnd").value = e.endTime || "10:00";
  $("#feLoc").value = e.location;
  $("#feNotes").value = e.notes;
  $("#feRepeat").checked = e.repeatWeekly;
  $("#feUntil").value = e.repeatUntil || addDays(e.date, 7 * 12);
  eventColor = colorPicker($("#feColors"), e.color);
  syncEditor();
  setErr($("#feErr"));
  $("#dlgEdit").showModal();
  $("#feTitle").focus();
}

function syncEditor() {
  $("#feTimes").hidden = $("#feAllDay").checked;
  $("#feRepeatRow").hidden = !$("#feRepeat").checked;
}
$("#feAllDay").onchange = syncEditor;
$("#feRepeat").onchange = syncEditor;
$("#feStart").addEventListener("change", () => {
  const s = parseHm($("#feStart").value), e = parseHm($("#feEnd").value);
  if (s != null && (e == null || e <= s)) {
    const n = Math.min(s + 60, 23 * 60 + 55);
    $("#feEnd").value = `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
  }
});

$("#formEvent").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = {
    title: $("#feTitle").value.trim(),
    date: $("#feDate").value,
    allDay: $("#feAllDay").checked,
    startTime: $("#feStart").value,
    endTime: $("#feEnd").value,
    location: $("#feLoc").value.trim(),
    notes: $("#feNotes").value.trim(),
    repeatWeekly: $("#feRepeat").checked,
    repeatUntil: $("#feRepeat").checked ? $("#feUntil").value : null,
    color: eventColor.value,
  };
  if (!body.title) return setErr($("#feErr"), "Give the event a title.");
  if (!body.date) return setErr($("#feErr"), "Pick a date.");
  if (!body.allDay && body.endTime <= body.startTime) return setErr($("#feErr"), "The end time must be after the start time.");
  await busy($("#feSave"), "Saving…", async () => {
    try {
      const r = editing
        ? await api(`/api/my-agenda/${editing.id}`, { method: "PUT", body })
        : await api("/api/my-agenda", { method: "POST", body });
      S.events = S.events.filter((x) => x.id !== r.event.id).concat(r.event);
      if (!isOn("mine")) toggle("mine");
      $("#dlgEdit").close();
      refreshSources();
      S.fc.gotoDate(r.event.date);
      toast(editing ? "Event updated." : "Event added. Only you can see it.");
    } catch (err) { setErr($("#feErr"), err.message); }
  });
});

$("#btnAddEvent").onclick = () => { setDrawer(false); openEventEditor(null); };

/* ---------- personal calendar links ---------- */

let editingFeed = null;
let feedColor;

function openFeedEditor(feed) {
  editingFeed = feed || null;
  setDrawer(false);
  $("#feedHeading").textContent = feed ? "Edit my calendar" : "Add my calendar";
  $("#ffName").value = feed ? feed.name : "";
  $("#ffUrl").value = "";
  $("#ffUrl").placeholder = feed ? `Current link: ${feed.host}` : "https://outlook.office365.com/owa/calendar/…/calendar.ics";
  $("#ffUrlNote").hidden = !feed;
  $("#ffSource").value = feed ? feed.source : "";
  $("#ffDelete").hidden = !feed;
  feedColor = colorPicker($("#ffColors"), feed ? feed.color : "#4B5563");
  setErr($("#ffErr"));
  $("#dlgFeed").showModal();
  $("#ffName").focus();
}

$("#btnAddFeed").onclick = () => openFeedEditor(null);

$("#formFeed").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = { name: $("#ffName").value.trim(), url: $("#ffUrl").value.trim(), color: feedColor.value, source: $("#ffSource").value };
  if (!body.name) return setErr($("#ffErr"), "Give this calendar a name, like “My Outlook”.");
  if (!editingFeed && !body.url) return setErr($("#ffErr"), "Paste the calendar's ICS link.");
  if (!body.url) delete body.url;
  await busy($("#ffSave"), "Checking the link…", async () => {
    try {
      const r = editingFeed
        ? await api(`/api/my-feeds/${editingFeed.id}`, { method: "PUT", body })
        : await api("/api/my-feeds", { method: "POST", body });
      S.myFeeds = S.myFeeds.filter((f) => f.id !== r.feed.id).concat(r.feed).sort((a, b) => a.id - b.id);
      S.feeds.delete(keyFeed(r.feed.id));
      $("#dlgFeed").close();
      renderSidebar();
      refreshSources();
      toast(r.warning || (editingFeed ? "Calendar updated." : "Calendar added. Only you can see it."));
    } catch (err) { setErr($("#ffErr"), err.message); }
  });
});

$("#ffDelete").onclick = async () => {
  const f = editingFeed;
  if (!(await confirmDialog("Remove this calendar?", `“${f.name}” will no longer show here. Your Outlook or Google calendar itself isn't changed.`, "Remove"))) return;
  try {
    await api(`/api/my-feeds/${f.id}`, { method: "DELETE" });
    S.myFeeds = S.myFeeds.filter((x) => x.id !== f.id);
    delete S.visible[keyFeed(f.id)];
    feedState.delete(keyFeed(f.id));
    $("#dlgFeed").close();
    renderSidebar();
    refreshSources();
    renderNotices();
    toast("Calendar removed.");
  } catch (err) { setErr($("#ffErr"), err.message); }
};

/* =====================================================================
   Tabs, menu, dialogs
   ===================================================================== */

let adminView = null;

function showTab(tab) {
  if (tab === "public") { showPublic(); return; }
  $("#public").hidden = true;
  $("#app").hidden = false;
  if (tab === "admin" && !S.me?.isAdmin) tab = "calendar";
  if (!["calendar", "admin"].includes(tab)) tab = "calendar";
  S.tab = tab;
  for (const b of $$(".tabs [role=tab]")) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
  for (const v of $$(".view")) v.hidden = v.dataset.view !== tab;
  $("#btnDrawer").style.visibility = tab === "calendar" ? "" : "hidden";
  if (tab === "calendar" && S.fc) S.fc.updateSize();
  if (tab === "admin") adminView.show();
  if (location.hash.slice(1) !== tab) history.replaceState(null, "", `#${tab}`);
}
for (const b of $$(".tabs [role=tab]")) b.onclick = () => showTab(b.dataset.tab);
window.addEventListener("hashchange", () => {
  const tab = location.hash.slice(1);
  if (S.me && getToken()) showTab(tab);
  else if (tab !== "public") showPublic();
});

$("#btnMe").onclick = (e) => {
  e.stopPropagation();
  const open = $("#meMenu").hidden;
  $("#meMenu").hidden = !open;
  $("#btnMe").setAttribute("aria-expanded", String(open));
};
document.addEventListener("click", (e) => {
  if (!$("#meMenu").hidden && !e.target.closest(".menu-wrap")) { $("#meMenu").hidden = true; $("#btnMe").setAttribute("aria-expanded", "false"); }
});
$("#btnSignOut").onclick = async () => {
  if (await confirmDialog("Sign out of this device?", "You'll need a new email code to sign in here again. Your other devices stay signed in.", "Sign out")) signOut();
};

for (const d of $$("dialog")) {
  d.addEventListener("click", (e) => { if (e.target === d || e.target.closest("[data-close]")) d.close(); });
}

/* =====================================================================
   Start
   ===================================================================== */

/** Reload everything from the server (after sign-in, or after admin changes). */
async function reload() {
  const data = await api("/api/bootstrap");
  S.me = data.me;
  S.site = data.site;
  S.calendars = data.calendars;
  S.myFeeds = data.myFeeds;
  S.visible = data.visible || {};
  S.feeds.clear();
  feedState.clear();
  try { await loadMyEvents(); }
  catch (err) {
    if (err.status === 401) throw err;
    S.events = [];
    toast(`Couldn't load your own events right now (${err.message}). Shared calendars still work.`);
  }
  document.title = S.site.title;
  $("#siteTitle").textContent = S.site.title;
  $("#tabAdmin").hidden = !S.me.isAdmin;
  $("#devBanner").hidden = !S.site.devMode;
  const first = (S.me.name || "").split(" ")[0] || S.me.email.split(/[@._]/)[0];
  const nice = first.charAt(0).toUpperCase() + first.slice(1);
  const hour = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: TZ }).format(new Date()));
  $("#helloDate").textContent = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  $("#helloName").textContent = `${hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening"}, ${nice}`;
  $("#meName").textContent = S.me.name || "";
  $("#meEmail").textContent = S.me.email;
  $("#meRole").textContent = S.me.roleLabel || "";
  $("#meRole").className = `pill role role-${S.me.role}`;
  $("#btnMe").textContent = (S.me.name || S.me.email)[0].toUpperCase();
  renderSidebar();
  renderNotices();
  refreshSources();
}

const ctx = {
  get state() { return S; },
  loadFeed,
  reload,
};

async function start() {
  const bootMsg = (msg) => { $(".spinner").hidden = true; $("#bootText").textContent = msg; };
  if (!window.FullCalendar || !window.ICAL) return bootMsg("Couldn't load the calendar tools. Check your internet connection and reload the page.");
  if (!apiConfigured()) return bootMsg("This site isn't connected to its Worker yet. An admin needs to set apiUrl in config.js (see README).");
  if (!getToken()) return showPublic();
  try {
    $("#public").hidden = true;
    $("#boot").hidden = false;
    await reload();
  } catch (err) {
    if (err.status === 401) return; // whenSignedOut already showed the public page and sign-in
    return bootMsg(`${err.message} Try reloading the page.`);
  }
  $("#boot").hidden = true;
  $("#app").hidden = false;
  if (!S.fc) {
    buildCalendar();
    refreshSources();
    adminView = initAdmin($("#adminRoot"), ctx);
  }
  showTab(location.hash.slice(1) || "calendar");
}

start();
