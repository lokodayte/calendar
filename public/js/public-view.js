// The public front page: calendars an admin marked "Public", visible to anyone without signing in.

import { api, apiFeed } from "./api.js";
import { $, h, eventColors, fmtTime } from "./dom.js";
import { parseIcs, expandIcs } from "./ics.js";

const HIDDEN_KEY = "scsm_public_hidden";
const readHidden = () => { try { return new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) || "[]")); } catch { return new Set(); } };
const saveHidden = (set) => { try { localStorage.setItem(HIDDEN_KEY, JSON.stringify([...set])); } catch { /* private mode */ } };

export function initPublic({ openEvent }) {
  const ICAL = window.ICAL;
  let info = null;
  let fc = null;
  const hidden = readHidden();
  const feeds = new Map(); // id -> promise of parsed calendar

  const load = (cal) => {
    if (!feeds.has(cal.id)) {
      const p = apiFeed(`/api/public/feeds/${cal.id}`).then((r) => parseIcs(ICAL, r.text));
      p.catch(() => feeds.delete(cal.id));
      feeds.set(cal.id, p);
    }
    return feeds.get(cal.id);
  };

  const toFc = (cal, o) => ({
    id: `pub${cal.id}|${o.key}`,
    title: o.title,
    start: o.allDay ? o.startDate : new Date(o.start),
    end: o.allDay ? o.endDate : new Date(o.end),
    allDay: o.allDay,
    ...eventColors(cal.color),
    extendedProps: { kind: "public", cal, color: cal.color, location: o.location, description: o.description },
  });

  function renderChips() {
    const box = $("#pubCals");
    box.replaceChildren(...info.calendars.map((c) => h("button", {
      type: "button", class: "chip", "aria-pressed": String(!hidden.has(c.id)), style: { "--c": c.color },
      onclick: () => { hidden.has(c.id) ? hidden.delete(c.id) : hidden.add(c.id); saveHidden(hidden); renderChips(); refresh(); },
    }, h("span", { class: "dot" }), c.name)));
    box.hidden = info.calendars.length < 2;
  }

  async function renderUpcoming() {
    const box = $("#pubUpcoming");
    const cals = info.calendars.filter((c) => !hidden.has(c.id));
    if (!info.calendars.length) {
      box.replaceChildren(h("div", { class: "card empty", style: { "grid-column": "1 / -1" } },
        h("h2", { text: "Nothing to show yet" }),
        h("p", { class: "muted", text: "Public events will appear here soon. SCSM staff can sign in for the full calendar." })));
      return;
    }
    const now = Date.now(), until = now + 60 * 864e5;
    const all = [];
    await Promise.all(cals.map(async (c) => {
      try {
        for (const o of expandIcs(await load(c), now - 864e5, until)) {
          const start = o.allDay ? Date.parse(o.startDate + "T12:00:00") : o.start;
          const end = o.allDay ? Date.parse(o.endDate + "T00:00:00") : o.end;
          if (end > now) all.push({ c, o, start });
        }
      } catch { /* shown as a quiet gap; the calendar below retries */ }
    }));
    all.sort((a, b) => a.start - b.start);
    const next = all.slice(0, 8);
    if (!next.length) {
      box.replaceChildren(h("div", { class: "card empty", style: { "grid-column": "1 / -1" } },
        h("h2", { text: "No upcoming events" }), h("p", { class: "muted", text: "Check back soon." })));
      return;
    }
    box.replaceChildren(...next.map(({ c, o, start }) => {
      const d = new Date(start);
      const time = o.allDay ? "All day" : `${fmtTime(new Date(o.start))} – ${fmtTime(new Date(o.end))}`;
      return h("button", {
        type: "button", class: "up-card", style: { "--c": c.color, "--c-soft": c.color + "1A" },
        onclick: () => openEvent(toFc(c, o)),
      },
      h("span", { class: "up-date" },
        h("span", { class: "up-mon", text: d.toLocaleDateString(undefined, { month: "short" }) }),
        h("span", { class: "up-day", text: String(d.getDate()) }),
        h("span", { class: "up-wd", text: d.toLocaleDateString(undefined, { weekday: "short" }) })),
      h("span", { class: "up-body" },
        h("p", { class: "up-title", text: o.title }),
        h("p", { class: "up-meta", text: o.location ? `${time} · ${o.location}` : time }),
        info.calendars.length > 1 ? h("span", { class: "up-cal", text: c.name }) : null));
    }));
  }

  function buildCalendar() {
    const phone = window.matchMedia("(max-width: 820px)").matches;
    fc = new FullCalendar.Calendar($("#pubCalendar"), {
      initialView: phone ? "listMonth" : "dayGridMonth",
      headerToolbar: phone
        ? { left: "prev,next today", center: "", right: "listMonth,dayGridMonth" }
        : { left: "prev,next today", center: "title", right: "dayGridMonth,listMonth" },
      footerToolbar: phone ? { center: "title" } : false,
      buttonText: { today: "Today", month: "Month", list: "List" },
      height: "auto",
      dayMaxEventRows: 4,
      eventDisplay: "block",
      eventTimeFormat: { hour: "numeric", minute: "2-digit", omitZeroMinute: true, meridiem: "short" },
      noEventsContent: "No events this month.",
      eventClick(i) { i.jsEvent.preventDefault(); openEvent(i.event); },
    });
    fc.render();
  }

  function refresh() {
    renderUpcoming();
    if (!fc) return;
    for (const s of fc.getEventSources()) s.remove();
    for (const c of info.calendars) {
      if (hidden.has(c.id)) continue;
      fc.addEventSource({
        id: `pub${c.id}`,
        events: (range, ok) => load(c).then((cal) => ok(expandIcs(cal, range.start.getTime(), range.end.getTime()).map((o) => toFc(c, o))), () => ok([])),
      });
    }
  }

  return {
    async show() {
      $("#pubToday").textContent = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
      if (!info) {
        try { info = await api("/api/public"); }
        catch (err) {
          $("#pubUpcoming").replaceChildren(h("div", { class: "notice error", style: { "grid-column": "1 / -1" } }, h("span", { text: err.message })));
          return;
        }
        $("#pubTitle").textContent = info.site.title;
        $("#pubBrand").textContent = info.site.title;
        $("#pubTagline").textContent = info.site.tagline;
        document.title = info.site.title;
        renderChips();
        $("#pubCalendar").closest(".pub-section").hidden = !info.calendars.length;
        if (info.calendars.length) buildCalendar();
        refresh();
      } else if (fc) fc.updateSize();
    },
  };
}
