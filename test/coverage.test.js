import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { zonedToUtc, parseHm } from "../public/js/tz.js";
import { buildWeek, whoIsOn, nextUp, officeNow, extractName, shiftsFromOccurrences, gapListText } from "../public/js/coverage.js";
import { parseIcs, expandIcs } from "../public/js/ics.js";

const ICAL = createRequire(import.meta.url)("ical.js");

const at = (date, time) => zonedToUtc(date, parseHm(time));
const shift = (name, date, from, to) => ({ name, start: at(date, from), end: at(date, to) });
const MON = "2026-09-28"; // a normal EDT week
const labels = (w) => w.gaps.map((g) => g.label);
const cell = (w, date, time) => w.days.find((d) => d.date === date).cells.find((c) => c.rowMin === parseHm(time));

describe("desk coverage", () => {
  test("several people on the same day with different hours (Elina 9–11, Sam 11–1, Elina 2–4)", () => {
    const shifts = [shift("Elina", MON, "09:00", "11:00"), shift("Sam", MON, "11:00", "13:00"), shift("Elina", MON, "14:00", "16:00")];
    const w = buildWeek({ shifts, weekStart: MON, settings: {} });
    assert.deepEqual(labels(w).filter((l) => l.startsWith("Mon")), ["Mon 1:00–2:00 pm", "Mon 4:00–5:00 pm"]);
    assert.equal(cell(w, MON, "09:00").status, "covered");
    assert.deepEqual(cell(w, MON, "11:30").people.map((p) => p.name), ["Sam"]);
    assert.equal(cell(w, MON, "13:00").status, "gap");
    assert.equal(cell(w, MON, "13:30").status, "gap");
    assert.equal(cell(w, MON, "14:00").status, "covered");
    // Tue–Fri have no shifts at all: one gap per day for the whole day.
    assert.ok(labels(w).includes("Tue 9:00–5:00 pm") === false);
    assert.ok(labels(w).includes("Tue 9:00 am–5:00 pm"));
    assert.equal(w.days.length, 5);
    assert.equal(w.rows.length, 16);
  });

  test("one person with two separate shifts in one day", () => {
    const shifts = [shift("Elina", MON, "09:00", "11:00"), shift("Sam", MON, "11:00", "13:00"), shift("Elina", MON, "14:00", "16:00")];
    assert.deepEqual(whoIsOn(shifts, at(MON, "10:00")).map((p) => [p.name, p.end]), [["Elina", at(MON, "11:00")]]);
    assert.deepEqual(whoIsOn(shifts, at(MON, "14:30")).map((p) => [p.name, p.end]), [["Elina", at(MON, "16:00")]]);
    assert.deepEqual(whoIsOn(shifts, at(MON, "13:30")), []);
    const next = nextUp(shifts, at(MON, "11:30"));
    assert.equal(next.start, at(MON, "14:00"));
    assert.deepEqual(next.people.map((p) => p.name), ["Elina"]);
  });

  test("back-to-back shifts of the same person read as one stretch", () => {
    const shifts = [shift("Elina", MON, "09:00", "11:00"), shift("Elina", MON, "11:00", "13:00"), shift("Sam", MON, "13:00", "15:00")];
    const on = whoIsOn(shifts, at(MON, "10:00"));
    assert.equal(on[0].end, at(MON, "13:00"));
    const next = nextUp(shifts, at(MON, "10:00"));
    assert.deepEqual(next.people.map((p) => p.name), ["Sam"]); // Elina's 11:00 continuation isn't "next up"
  });

  test("a short gap between shifts is found to the minute", () => {
    const shifts = [shift("Sam", MON, "09:00", "12:10"), shift("Ana", MON, "12:20", "17:00")];
    const w = buildWeek({ shifts, weekStart: MON, settings: {} });
    assert.deepEqual(labels(w).filter((l) => l.startsWith("Mon")), ["Mon 12:10–12:20 pm"]);
    const c = cell(w, MON, "12:00");
    assert.equal(c.status, "thin");
    assert.equal(c.partial, true);
    assert.deepEqual(c.people.map((p) => p.name), ["Sam", "Ana"]);
  });

  test("shifts starting at odd times like 10:15", () => {
    const shifts = [shift("Elina", MON, "10:15", "11:45")];
    const w30 = buildWeek({ shifts, weekStart: MON, settings: {} });
    assert.deepEqual(labels(w30).filter((l) => l.startsWith("Mon")), ["Mon 9:00–10:15 am", "Mon 11:45 am–5:00 pm"]);
    assert.equal(cell(w30, MON, "10:00").status, "thin"); // partly covered
    assert.equal(cell(w30, MON, "10:30").status, "covered");
    assert.equal(cell(w30, MON, "11:30").status, "thin");
    const w15 = buildWeek({ shifts, weekStart: MON, settings: { slotMinutes: 15 } });
    assert.equal(w15.rows.length, 32);
    assert.equal(cell(w15, MON, "10:00").status, "gap");
    assert.equal(cell(w15, MON, "10:15").status, "covered");
    assert.equal(cell(w15, MON, "11:30").status, "covered");
    assert.equal(cell(w15, MON, "11:45").status, "gap");
  });

  test("overlapping shifts count everyone on, and the same person only once", () => {
    const shifts = [shift("Elina", MON, "09:00", "12:00"), shift("Sam", MON, "11:00", "13:00"), shift("Elina", MON, "10:00", "11:00")];
    const w = buildWeek({ shifts, weekStart: MON, settings: { minStaff: 2 } });
    assert.deepEqual(labels(w).filter((l) => l.startsWith("Mon")), [
      "Mon 9:00–11:00 am (only 1 of 2)", "Mon 12:00–1:00 pm (only 1 of 2)", "Mon 1:00–5:00 pm",
    ]);
    const c = cell(w, MON, "11:00");
    assert.equal(c.status, "covered");
    assert.deepEqual([...new Set(c.people.map((p) => p.name))].sort(), ["Elina", "Sam"]);
    assert.equal(cell(w, MON, "10:00").min, 1);
    assert.deepEqual(whoIsOn(shifts, at(MON, "11:30")).map((p) => p.name), ["Elina", "Sam"]);
  });

  test("shifts crossing the office-hours boundary only count inside office hours", () => {
    const shifts = [shift("Elina", MON, "08:00", "09:30"), shift("Sam", MON, "16:30", "18:00")];
    const w = buildWeek({ shifts, weekStart: MON, settings: {} });
    assert.deepEqual(labels(w).filter((l) => l.startsWith("Mon")), ["Mon 9:30 am–4:30 pm"]);
    assert.equal(cell(w, MON, "09:00").status, "covered");
    assert.equal(cell(w, MON, "16:30").status, "covered");
    // Before hours: office is closed, but Elina is still shown as on shift.
    assert.equal(officeNow(at(MON, "08:30"), {}).open, false);
    assert.deepEqual(whoIsOn(shifts, at(MON, "08:30")).map((p) => p.name), ["Elina"]);
    assert.equal(officeNow(at(MON, "09:00"), {}).open, true);
  });

  test("closed dates are never gaps", () => {
    const settings = { closed: [{ from: "2026-09-29", to: "2026-09-30", label: "Fall break" }] };
    const w = buildWeek({ shifts: [], weekStart: MON, settings });
    assert.deepEqual(labels(w), ["Mon 9:00 am–5:00 pm", "Thu 9:00 am–5:00 pm", "Fri 9:00 am–5:00 pm"]);
    const tue = w.days.find((d) => d.date === "2026-09-29");
    assert.equal(tue.open, false);
    assert.equal(tue.reason, "Fall break");
    assert.ok(tue.cells.every((c) => c.status === "closed"));
    const now = officeNow(at("2026-09-30", "10:00"), settings);
    assert.deepEqual([now.open, now.reason], [false, "Fall break"]);
  });

  test("gap list text for copying", () => {
    const w = buildWeek({ shifts: [shift("A", MON, "09:00", "17:00")], weekStart: MON, settings: { hours: { 1: ["09:00", "17:00"], 2: ["13:00", "15:00"] } } });
    assert.equal(gapListText(w.gaps, "Gaps:"), "Gaps:\n• Tue 1:00–3:00 pm");
    assert.match(gapListText([], ""), /No gaps/);
  });
});

describe("shift names from event titles", () => {
  const cases = [
    ["Front desk: Elina", "Elina"], ["Shift - Sam", "Sam"], ["Shift – Sam", "Sam"], ["Elina", "Elina"],
    ["Front Desk - Maria Lopez", "Maria Lopez"], ["Sam (front desk)", "Sam"], ["Desk | Ana", "Ana"],
    ["Elina - Front desk", "Elina"], ["Student worker: Jo", "Jo"], ["Shifty Sam", "Shifty Sam"], ["Shift", "Shift"],
  ];
  for (const [title, name] of cases) test(`"${title}" → "${name}"`, () => assert.equal(extractName(title), name));
  test("custom prefixes", () => assert.equal(extractName("Help desk: Kai", ["Help desk"]), "Kai"));
});

/* ---------- through real ICS data (recurrence, cancellations, DST) ---------- */

const VTZ = `BEGIN:VTIMEZONE
TZID:America/New_York
BEGIN:DAYLIGHT
TZOFFSETFROM:-0500
TZOFFSETTO:-0400
TZNAME:EDT
DTSTART:19700308T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:-0400
TZOFFSETTO:-0500
TZNAME:EST
DTSTART:19701101T020000
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
END:STANDARD
END:VTIMEZONE`;
const cal = (body) => `BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:test\n${VTZ}\n${body}\nEND:VCALENDAR`.replace(/\n/g, "\r\n");

function weekFromIcs(text, weekStart, settings = {}) {
  const parsed = parseIcs(ICAL, text);
  const from = at(weekStart, "00:00"), to = at("2026-12-31", "00:00");
  const shifts = shiftsFromOccurrences(expandIcs(parsed, from, to));
  return { shifts, week: buildWeek({ shifts, weekStart, settings }) };
}

describe("coverage from ICS feeds", () => {
  const recurring = cal(`BEGIN:VEVENT
UID:elina-mon@test
DTSTAMP:20260901T000000Z
DTSTART;TZID=America/New_York:20260921T090000
DTEND;TZID=America/New_York:20260921T110000
RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261215T000000Z
EXDATE;TZID=America/New_York:20261019T090000
SUMMARY:Front desk: Elina
END:VEVENT
BEGIN:VEVENT
UID:elina-mon@test
DTSTAMP:20260901T000000Z
RECURRENCE-ID;TZID=America/New_York:20261005T090000
DTSTART;TZID=America/New_York:20261005T090000
DTEND;TZID=America/New_York:20261005T110000
STATUS:CANCELLED
SUMMARY:Front desk: Elina
END:VEVENT
BEGIN:VEVENT
UID:elina-mon@test
DTSTAMP:20260901T000000Z
RECURRENCE-ID;TZID=America/New_York:20261012T090000
DTSTART;TZID=America/New_York:20261012T120000
DTEND;TZID=America/New_York:20261012T140000
SUMMARY:Front desk: Elina
END:VEVENT
BEGIN:VEVENT
UID:sam-once@test
DTSTAMP:20260901T000000Z
DTSTART;TZID=America/New_York:20261005T101500
DTEND;TZID=America/New_York:20261005T114500
SUMMARY:Shift - Sam
END:VEVENT
BEGIN:VEVENT
UID:allday@test
DTSTAMP:20260901T000000Z
DTSTART;VALUE=DATE:20261006
DTEND;VALUE=DATE:20261007
SUMMARY:Staff meeting day
END:VEVENT`);

  test("a normal week of the recurring shift", () => {
    const { week } = weekFromIcs(recurring, MON);
    assert.equal(labels(week)[0], "Mon 11:00 am–5:00 pm");
  });

  test("a cancelled occurrence of a recurring shift leaves a gap (one-off shift still counts)", () => {
    const { week, shifts } = weekFromIcs(recurring, "2026-10-05");
    assert.ok(!shifts.some((s) => s.name === "Elina" && s.start === at("2026-10-05", "09:00")));
    assert.deepEqual(labels(week).filter((l) => l.startsWith("Mon")), ["Mon 9:00–10:15 am", "Mon 11:45 am–5:00 pm"]);
    assert.ok(!shifts.some((s) => s.title === "Staff meeting day")); // all-day events aren't shifts
  });

  test("a moved occurrence and an EXDATE are respected", () => {
    const moved = weekFromIcs(recurring, "2026-10-12").week;
    assert.deepEqual(labels(moved).filter((l) => l.startsWith("Mon")), ["Mon 9:00 am–12:00 pm", "Mon 2:00–5:00 pm"]);
    const excluded = weekFromIcs(recurring, "2026-10-19").week;
    assert.deepEqual(labels(excluded).filter((l) => l.startsWith("Mon")), ["Mon 9:00 am–5:00 pm"]);
  });

  test("daylight saving time ends (Nov 1, 2026): 9 am stays 9 am", () => {
    const before = weekFromIcs(recurring, "2026-10-26");
    const after = weekFromIcs(recurring, "2026-11-02");
    const oct26 = before.shifts.find((s) => s.name === "Elina" && s.start >= at("2026-10-26", "00:00"));
    const nov2 = after.shifts.find((s) => s.name === "Elina" && s.start >= at("2026-11-02", "00:00"));
    assert.equal(new Date(oct26.start).toISOString(), "2026-10-26T13:00:00.000Z"); // EDT, UTC-4
    assert.equal(new Date(nov2.start).toISOString(), "2026-11-02T14:00:00.000Z");  // EST, UTC-5
    assert.equal(labels(after.week)[0], "Mon 11:00 am–5:00 pm");
    assert.equal(cell(after.week, "2026-11-02", "09:00").status, "covered");
    assert.equal(cell(after.week, "2026-11-02", "09:00").start, Date.parse("2026-11-02T14:00:00Z"));
  });

  test("the 25-hour day itself: a Sunday 12–4 am window is 5 real hours", () => {
    const settings = { hours: { 0: ["00:00", "04:00"] } };
    const w = buildWeek({ shifts: [], weekStart: "2026-10-26", settings });
    assert.equal(w.days.length, 1);
    assert.equal(w.days[0].date, "2026-11-01");
    assert.equal(w.gaps.length, 1);
    assert.equal(w.gaps[0].end - w.gaps[0].start, 5 * 3600e3);
    assert.equal(w.gaps[0].label, "Sun 12:00–4:00 am");
    // A shift 12:30–1:30 am EDT (UTC 04:30–05:30) covers the first half of the repeated hour.
    const s = { name: "Night", start: Date.parse("2026-11-01T04:30:00Z"), end: Date.parse("2026-11-01T05:30:00Z") };
    const w2 = buildWeek({ shifts: [s], weekStart: "2026-10-26", settings });
    assert.deepEqual(w2.gaps.map((g) => [new Date(g.start).toISOString(), new Date(g.end).toISOString()]), [
      ["2026-11-01T04:00:00.000Z", "2026-11-01T04:30:00.000Z"],
      ["2026-11-01T05:30:00.000Z", "2026-11-01T09:00:00.000Z"],
    ]);
  });
});
