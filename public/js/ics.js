// Parse ICS text and expand it into concrete occurrences for a date range.
// ICAL (ical.js) is passed in so the same code runs in the browser (CDN global) and in Node tests.

const NY_VTIMEZONE = [
  "BEGIN:VTIMEZONE", "TZID:America/New_York",
  "BEGIN:DAYLIGHT", "TZOFFSETFROM:-0500", "TZOFFSETTO:-0400", "TZNAME:EDT",
  "DTSTART:19700308T020000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU", "END:DAYLIGHT",
  "BEGIN:STANDARD", "TZOFFSETFROM:-0400", "TZOFFSETTO:-0500", "TZNAME:EST",
  "DTSTART:19701101T020000", "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU", "END:STANDARD",
  "END:VTIMEZONE",
].join("\r\n");

// Outlook often uses Windows zone names. Map the common US ones to the Eastern definition
// only when the feed doesn't define them itself.
const ALIASES = ["America/New_York", "Eastern Standard Time", "US/Eastern", "(UTC-05:00) Eastern Time (US & Canada)"];

function ensureZones(ICAL) {
  for (const id of ALIASES) {
    if (ICAL.TimezoneService.has(id)) continue;
    const comp = new ICAL.Component(ICAL.parse(`BEGIN:VCALENDAR\r\n${NY_VTIMEZONE.replace("TZID:America/New_York", "TZID:" + id)}\r\nEND:VCALENDAR`));
    ICAL.TimezoneService.register(comp.getFirstSubcomponent("vtimezone"));
  }
}

/** Returns an opaque parsed calendar: master events with their exceptions attached. */
export function parseIcs(ICAL, text) {
  ensureZones(ICAL);
  const root = new ICAL.Component(ICAL.parse(text));
  for (const tz of root.getAllSubcomponents("vtimezone")) {
    try { ICAL.TimezoneService.register(tz); } catch { /* ignore bad zone */ }
  }
  const masters = new Map();
  const exceptions = [];
  let n = 0;
  for (const v of root.getAllSubcomponents("vevent")) {
    if (v.hasProperty("recurrence-id")) exceptions.push(v);
    else {
      const ev = new ICAL.Event(v);
      masters.set(ev.uid || `no-uid-${n++}`, ev);
    }
  }
  for (const v of exceptions) {
    const m = masters.get(v.getFirstPropertyValue("uid"));
    if (m && m.isRecurring()) { try { m.relateException(v); continue; } catch { /* fall through */ } }
    if (!m) masters.set(`orphan-${n++}`, new ICAL.Event(v));
  }
  return { events: [...masters.values()] };
}

function cancelled(item) {
  const s = item.component.getFirstPropertyValue("status");
  return !!s && String(s).toUpperCase() === "CANCELLED";
}

function occurrence(item, start, end, key) {
  if (cancelled(item)) return null;
  const allDay = start.isDate;
  let endTime = end;
  if (!endTime) {
    endTime = start.clone();
    if (allDay) endTime.day += 1;
  }
  return {
    key,
    uid: item.uid || "",
    title: item.summary || "(No title)",
    allDay,
    // For all-day events keep plain dates; otherwise absolute instants.
    startDate: allDay ? start.toString() : null,
    endDate: allDay ? endTime.toString() : null,
    start: allDay ? null : start.toJSDate().getTime(),
    end: allDay ? null : endTime.toJSDate().getTime(),
    location: item.location || "",
    description: item.description || "",
  };
}

function overlaps(o, fromMs, toMs) {
  if (o.allDay) {
    const s = Date.parse(o.startDate + "T00:00:00Z") - 864e5, e = Date.parse(o.endDate + "T00:00:00Z") + 864e5;
    return s < toMs && e > fromMs; // generous; the view trims
  }
  return o.start < toMs && o.end > fromMs;
}

/** Concrete occurrences overlapping [fromMs, toMs). Handles RRULE, EXDATE, moved and cancelled occurrences. */
export function expandIcs(parsed, fromMs, toMs, limit = 20000) {
  const out = [];
  for (const ev of parsed.events) {
    try {
      if (ev.isRecurring()) {
        if (cancelled(ev)) continue;
        const it = ev.iterator();
        let t, guard = 0;
        while ((t = it.next()) && guard++ < limit) {
          // Look 30 days past the range: an occurrence moved earlier can still land inside it.
          if (t.toJSDate().getTime() >= toMs + 30 * 864e5) break;
          const d = ev.getOccurrenceDetails(t);
          const o = occurrence(d.item, d.startDate, d.endDate, `${ev.uid}@${t.toString()}`);
          if (o && overlaps(o, fromMs, toMs)) out.push(o);
        }
      } else {
        if (!ev.startDate) continue;
        const o = occurrence(ev, ev.startDate, ev.endDate, ev.uid || String(ev.startDate));
        if (o && overlaps(o, fromMs, toMs)) out.push(o);
      }
    } catch (err) {
      if (typeof console !== "undefined") console.warn("Skipped an event:", err && err.message);
    }
  }
  return out;
}
