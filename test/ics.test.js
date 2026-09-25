import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { zonedToUtc, parseHm, ymd, addDays, mondayOf } from "../public/js/tz.js";
import { parseIcs, expandIcs } from "../public/js/ics.js";

const ICAL = createRequire(import.meta.url)("ical.js");
const at = (date, time) => zonedToUtc(date, parseHm(time));

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

// A weekly Monday 9–11 club meeting: one week cancelled, one moved to noon, one removed with EXDATE.
const weekly = cal(`BEGIN:VEVENT
UID:club@test
DTSTAMP:20260901T000000Z
DTSTART;TZID=America/New_York:20260921T090000
DTEND;TZID=America/New_York:20260921T110000
RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261215T000000Z
EXDATE;TZID=America/New_York:20261019T090000
SUMMARY:Computer Society
LOCATION:Hancock 2023
END:VEVENT
BEGIN:VEVENT
UID:club@test
DTSTAMP:20260901T000000Z
RECURRENCE-ID;TZID=America/New_York:20261005T090000
DTSTART;TZID=America/New_York:20261005T090000
DTEND;TZID=America/New_York:20261005T110000
STATUS:CANCELLED
SUMMARY:Computer Society
END:VEVENT
BEGIN:VEVENT
UID:club@test
DTSTAMP:20260901T000000Z
RECURRENCE-ID;TZID=America/New_York:20261012T090000
DTSTART;TZID=America/New_York:20261012T120000
DTEND;TZID=America/New_York:20261012T140000
SUMMARY:Computer Society (moved)
END:VEVENT
BEGIN:VEVENT
UID:allday@test
DTSTAMP:20260901T000000Z
DTSTART;VALUE=DATE:20261006
DTEND;VALUE=DATE:20261007
SUMMARY:No classes
END:VEVENT`);

const week = (monday) => expandIcs(parseIcs(ICAL, weekly), at(monday, "00:00"), at(addDays(monday, 7), "00:00"));

describe("reading calendar feeds", () => {
  test("a normal week of a repeating event", () => {
    const occ = week("2026-09-28").filter((o) => !o.allDay); // all-day events get a day of slack at the edges
    assert.equal(occ.length, 1);
    assert.equal(occ[0].start, at("2026-09-28", "09:00"));
    assert.equal(occ[0].location, "Hancock 2023");
  });

  test("a cancelled occurrence is left out; all-day events keep their date", () => {
    const occ = week("2026-10-05");
    assert.deepEqual(occ.map((o) => o.title), ["No classes"]);
    assert.deepEqual([occ[0].allDay, occ[0].startDate, occ[0].endDate], [true, "2026-10-06", "2026-10-07"]);
  });

  test("a moved occurrence shows at its new time, and EXDATE removes one", () => {
    const moved = week("2026-10-12");
    assert.deepEqual(moved.map((o) => [o.title, o.start]), [["Computer Society (moved)", at("2026-10-12", "12:00")]]);
    assert.deepEqual(week("2026-10-19"), []);
  });

  test("daylight saving time ends (Nov 1, 2026): 9 am stays 9 am", () => {
    assert.equal(new Date(week("2026-10-26")[0].start).toISOString(), "2026-10-26T13:00:00.000Z"); // EDT
    assert.equal(new Date(week("2026-11-02")[0].start).toISOString(), "2026-11-02T14:00:00.000Z"); // EST
  });

  test("Outlook's Windows time zone name works even without a definition in the feed", () => {
    const text = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:o@test\r\nDTSTART;TZID=Eastern Standard Time:20261102T090000\r\nDTEND;TZID=Eastern Standard Time:20261102T100000\r\nSUMMARY:Outlook meeting\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
    const occ = expandIcs(parseIcs(ICAL, text), Date.parse("2026-11-01"), Date.parse("2026-11-04"));
    assert.equal(new Date(occ[0].start).toISOString(), "2026-11-02T14:00:00.000Z");
  });
});

describe("time zone helpers", () => {
  test("wall-clock times convert correctly on both sides of the DST change", () => {
    assert.equal(new Date(at("2026-10-30", "09:00")).toISOString(), "2026-10-30T13:00:00.000Z");
    assert.equal(new Date(at("2026-11-02", "09:00")).toISOString(), "2026-11-02T14:00:00.000Z");
    assert.equal(ymd(Date.parse("2026-11-02T03:30:00Z")), "2026-11-01"); // still Sunday evening in New York
    assert.equal(mondayOf("2026-11-01"), "2026-10-26");
  });
});
