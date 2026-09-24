// Desk coverage: turns shift events into "who's on", a week grid and a gap list.
// Pure functions, no DOM. Shifts are {name, start, end} with start/end as epoch ms.
// Office hours, closed dates and grid rows are wall-clock times in the calendar's zone.

import { TZ, zonedToUtc, zonedParts, addDays, weekdayOf, parseHm, rangeLabel, WEEKDAY_SHORT } from "./tz.js";

export const DEFAULT_COVERAGE = {
  hours: { 1: ["09:00", "17:00"], 2: ["09:00", "17:00"], 3: ["09:00", "17:00"], 4: ["09:00", "17:00"], 5: ["09:00", "17:00"] },
  minStaff: 1,
  slotMinutes: 30,
  closed: [], // [{from:"2026-11-26", to:"2026-11-27", label:"Thanksgiving"}]
  prefixes: ["Front desk", "Desk", "Shift", "Student worker", "Work", "Office"],
};

/** Fill in defaults and drop anything malformed. */
export function normalizeCoverage(s) {
  s = s && typeof s === "object" ? s : {};
  const hours = {};
  const src = s.hours && typeof s.hours === "object" ? s.hours : DEFAULT_COVERAGE.hours;
  for (let wd = 0; wd < 7; wd++) {
    const h = src[wd];
    if (!Array.isArray(h)) continue;
    const a = parseHm(h[0]), b = parseHm(h[1]);
    if (a != null && b != null && b > a) hours[wd] = [h[0], h[1]];
  }
  const minStaff = Math.min(20, Math.max(1, parseInt(s.minStaff, 10) || 1));
  const slotMinutes = +s.slotMinutes === 15 ? 15 : 30;
  const closed = (Array.isArray(s.closed) ? s.closed : [])
    .filter((c) => c && /^\d{4}-\d{2}-\d{2}$/.test(c.from))
    .map((c) => ({ from: c.from, to: /^\d{4}-\d{2}-\d{2}$/.test(c.to || "") && c.to >= c.from ? c.to : c.from, label: String(c.label || "").slice(0, 80) }));
  const prefixes = (Array.isArray(s.prefixes) ? s.prefixes : DEFAULT_COVERAGE.prefixes)
    .map((p) => String(p).trim()).filter(Boolean).slice(0, 30);
  return { hours, minStaff, slotMinutes, closed, prefixes };
}

/* ---------- names from event titles ---------- */

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const SEP = "[:\\-–—|/]";

/** "Front desk: Elina" → "Elina", "Shift - Sam" → "Sam", "Sam (front desk)" → "Sam". */
export function extractName(title, prefixes = DEFAULT_COVERAGE.prefixes) {
  const original = String(title || "").replace(/\s+/g, " ").trim();
  let t = original;
  const ps = [...prefixes].sort((a, b) => b.length - a.length).map(esc);
  for (let changed = true; changed;) {
    changed = false;
    for (const p of ps) {
      const lead = new RegExp(`^${p}\\b\\s*(?:${SEP}\\s*)?`, "i");
      const tail = new RegExp(`\\s*${SEP}\\s*${p}$`, "i");
      for (const re of [lead, tail]) {
        const next = t.replace(re, "").trim();
        if (next && next !== t) { t = next; changed = true; }
      }
    }
  }
  t = t.replace(/^[:\-–—|/\s]+|[:\-–—|/\s]+$/g, "");
  const colon = t.lastIndexOf(":");
  if (colon >= 0 && t.slice(colon + 1).trim()) t = t.slice(colon + 1).trim();
  t = t.replace(/\s*[([].*?[)\]]\s*$/, "").trim();
  return t || original;
}

const keyOf = (name) => name.toLowerCase().replace(/\s+/g, " ").trim();

/** Timed occurrences (from ics.js) → shifts with a worker name. All-day events are skipped. */
export function shiftsFromOccurrences(occurrences, prefixes) {
  const out = [];
  for (const o of occurrences) {
    if (o.allDay || !(o.end > o.start)) continue;
    out.push({ name: extractName(o.title, prefixes), start: o.start, end: o.end, title: o.title });
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

/* ---------- time slicing ---------- */

/** Split [from, to) at every shift start/end; each piece lists the distinct people on. */
export function timeline(shifts, from, to) {
  const rel = shifts.filter((s) => s.start < to && s.end > from);
  const pts = new Set([from, to]);
  for (const s of rel) {
    if (s.start > from && s.start < to) pts.add(s.start);
    if (s.end > from && s.end < to) pts.add(s.end);
  }
  const sorted = [...pts].sort((a, b) => a - b);
  const segs = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i], b = sorted[i + 1];
    const names = new Map();
    for (const s of rel) if (s.start < b && s.end > a && !names.has(keyOf(s.name))) names.set(keyOf(s.name), s.name);
    segs.push({ start: a, end: b, people: [...names.values()] });
  }
  return segs;
}

/** Office hours for a date, or why it's closed. Minutes after midnight. */
export function dayInfo(date, settings) {
  const closedEntry = settings.closed.find((c) => date >= c.from && date <= c.to);
  const h = settings.hours[weekdayOf(date)];
  if (!h) return { date, open: false, reason: "No office hours" };
  if (closedEntry) return { date, open: false, reason: closedEntry.label || "Closed", closedDate: true };
  return { date, open: true, openMin: parseHm(h[0]), closeMin: parseHm(h[1]) };
}

function minutesOf(ms, date, tz) {
  const p = zonedParts(ms, tz);
  return p.date === date ? p.minutes : p.date > date ? 1440 : 0;
}

/* ---------- the week ---------- */

/**
 * Build the coverage week starting at weekStart (a Monday, "YYYY-MM-DD").
 * Returns { days, rows, gaps }. Each day has cells aligned with rows.
 * Cell status: covered | thin | gap | off (outside that day's hours) | closed.
 */
export function buildWeek({ shifts, weekStart, settings, tz = TZ }) {
  settings = normalizeCoverage(settings);
  const slot = settings.slotMinutes;
  const weekdays = Object.keys(settings.hours).map(Number);
  const dates = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(weekStart, i);
    if (weekdays.includes(weekdayOf(d))) dates.push(d);
  }
  let first = 1440, last = 0;
  for (const wd of weekdays) {
    first = Math.min(first, parseHm(settings.hours[wd][0]));
    last = Math.max(last, parseHm(settings.hours[wd][1]));
  }
  first = Math.floor(first / slot) * slot;
  const rows = [];
  for (let m = first; m < last; m += slot) rows.push(m);

  const days = [];
  const gaps = [];
  for (const date of dates) {
    const info = dayInfo(date, settings);
    const day = { date, weekday: weekdayOf(date), label: WEEKDAY_SHORT[weekdayOf(date)], ...info, cells: [] };
    for (const r of rows) {
      if (!info.open) { day.cells.push({ status: "closed", rowMin: r }); continue; }
      const a = Math.max(r, info.openMin), b = Math.min(r + slot, info.closeMin);
      if (b <= a) { day.cells.push({ status: "off", rowMin: r }); continue; }
      const from = zonedToUtc(date, a, tz), to = zonedToUtc(date, b, tz);
      const segs = timeline(shifts, from, to);
      const counts = segs.map((s) => s.people.length);
      const min = Math.min(...counts), max = Math.max(...counts);
      const people = shifts.filter((s) => s.start < to && s.end > from).map((s) => ({ name: s.name, start: s.start, end: s.end }));
      const status = max === 0 ? "gap" : min >= settings.minStaff ? "covered" : "thin";
      day.cells.push({ status, rowMin: r, startMin: a, endMin: b, start: from, end: to, min, max, partial: min !== max, people });
    }
    if (info.open) {
      const from = zonedToUtc(date, info.openMin, tz), to = zonedToUtc(date, info.closeMin, tz);
      let cur = null;
      for (const seg of timeline(shifts, from, to)) {
        const n = seg.people.length;
        const kind = n === 0 ? "gap" : n < settings.minStaff ? "thin" : null;
        if (cur && kind === cur.kind && (kind === "gap" || n === cur.count)) { cur.end = seg.end; continue; }
        if (cur) gaps.push(cur);
        cur = kind ? { date, kind, count: n, start: seg.start, end: seg.end } : null;
      }
      if (cur) gaps.push(cur);
    }
    days.push(day);
  }
  for (const g of gaps) {
    g.startMin = minutesOf(g.start, g.date, tz);
    g.endMin = minutesOf(g.end, g.date, tz);
    g.label = `${WEEKDAY_SHORT[weekdayOf(g.date)]} ${rangeLabel(g.startMin, g.endMin)}`;
    if (g.kind === "thin") g.label += ` (only ${g.count} of ${settings.minStaff})`;
  }
  return { days, rows, gaps, settings };
}

/** Plain text for the "Copy list" button. */
export function gapListText(gaps, heading) {
  const lines = gaps.map((g) => `• ${g.label}`);
  return [heading, ...(lines.length ? lines : ["No gaps — every office hour is covered."])].filter(Boolean).join("\n");
}

/* ---------- now / next ---------- */

/** People on shift at `now`, one entry per person, with when their (continuous) shift ends. */
export function whoIsOn(shifts, now) {
  const byName = new Map();
  for (const s of shifts) {
    if (!(s.start <= now && s.end > now)) continue;
    const k = keyOf(s.name);
    const cur = byName.get(k);
    if (!cur || s.end > cur.end) byName.set(k, { name: s.name, start: Math.min(s.start, cur ? cur.start : s.start), end: s.end });
  }
  // Extend through back-to-back shifts of the same person (9–11 then 11–1 ends at 1).
  for (const p of byName.values()) {
    for (let extended = true; extended;) {
      extended = false;
      for (const s of shifts) {
        if (keyOf(s.name) === keyOf(p.name) && s.start <= p.end && s.end > p.end) { p.end = s.end; extended = true; }
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.end - b.end || a.name.localeCompare(b.name));
}

/** The next shift start after `now` that brings someone new to the desk (everyone starting then). */
export function nextUp(shifts, now) {
  const on = whoIsOn(shifts, now);
  const onUntil = new Map(on.map((p) => [keyOf(p.name), p.end]));
  const upcoming = shifts.filter((s) => s.start > now && !(onUntil.has(keyOf(s.name)) && s.start <= onUntil.get(keyOf(s.name))));
  if (!upcoming.length) return null;
  const start = Math.min(...upcoming.map((s) => s.start));
  const seen = new Set();
  const people = [];
  for (const s of upcoming) {
    if (s.start !== start || seen.has(keyOf(s.name))) continue;
    seen.add(keyOf(s.name));
    people.push({ name: s.name, start: s.start, end: s.end });
  }
  return { start, people };
}

/** Is the office open at `now`? */
export function officeNow(now, settings, tz = TZ) {
  settings = normalizeCoverage(settings);
  const p = zonedParts(now, tz);
  const info = dayInfo(p.date, settings);
  if (!info.open) return { open: false, reason: info.closedDate ? info.reason : "Office closed today" };
  if (p.minutes < info.openMin) return { open: false, reason: "Before office hours", opensAt: zonedToUtc(p.date, info.openMin, tz) };
  if (p.minutes >= info.closeMin) return { open: false, reason: "After office hours" };
  return { open: true, closesAt: zonedToUtc(p.date, info.closeMin, tz) };
}
