// Sample calendars for local dev mode, generated around the current week so there's
// always something to see. Used only when DEV_MODE = "true".

import { TZ, ymd, mondayOf, addDays } from "../../../public/js/tz.js";

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

const compact = (date) => date.replace(/-/g, "");
const dt = (date, time) => `${compact(date)}T${time.replace(":", "")}00`;

function vevent({ uid, date, from, to, title, location = "", description = "", rrule = "", allDay = false, extra = [] }) {
  const lines = ["BEGIN:VEVENT", `UID:${uid}@scsm-sample`, "DTSTAMP:20260101T000000Z"];
  if (allDay) lines.push(`DTSTART;VALUE=DATE:${compact(date)}`, `DTEND;VALUE=DATE:${compact(addDays(date, 1))}`);
  else lines.push(`DTSTART;TZID=${TZ}:${dt(date, from)}`, `DTEND;TZID=${TZ}:${dt(date, to)}`);
  lines.push(`SUMMARY:${title}`);
  if (location) lines.push(`LOCATION:${location}`);
  if (description) lines.push(`DESCRIPTION:${description}`);
  if (rrule) lines.push(`RRULE:${rrule}`);
  lines.push(...extra, "END:VEVENT");
  return lines.join("\n");
}

const wrap = (name, events) => `BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//SCSM sample//EN\nX-WR-CALNAME:${name}\n${VTZ}\n${events.join("\n")}\nEND:VCALENDAR`.replace(/\n/g, "\r\n");

export function sampleIcs(name, now = Date.now()) {
  const mon = mondayOf(ymd(now));
  const d = (weekOffset, weekday) => addDays(mon, weekOffset * 7 + weekday); // weekday 0 = Monday
  const ev = [];

  if (name === "school") {
    ev.push(vevent({ uid: "s1", date: d(0, 2), from: "12:00", to: "13:00", title: "Faculty meeting", location: "Hancock 2023", description: "Monthly faculty meeting. Lunch provided." }));
    ev.push(vevent({ uid: "s2", date: d(0, 4), allDay: true, title: "Last day to drop without a W" }));
    ev.push(vevent({ uid: "s3", date: d(1, 1), from: "16:00", to: "18:00", title: "SCSM Open House", location: "Hancock atrium", description: "Prospective students and families." }));
    ev.push(vevent({ uid: "s4", date: d(2, 3), from: "09:00", to: "15:00", title: "Advising day", location: "Hancock" }));
    return wrap("School Events", ev);
  }

  if (name === "clubs") {
    ev.push(vevent({ uid: "c1", date: d(-1, 1), from: "18:00", to: "19:30", title: "ACM chapter meeting", location: "Hancock 1021", rrule: "FREQ=WEEKLY;COUNT=10" }));
    ev.push(vevent({ uid: "c2", date: d(0, 3), from: "17:00", to: "19:00", title: "Hackathon planning", location: "Hancock 2012", description: "Contact: Parijat Das" }));
    ev.push(vevent({ uid: "c3", date: d(1, 4), from: "15:00", to: "17:00", title: "Math club puzzle night", location: "Library 3rd floor" }));
    return wrap("Club Events", ev);
  }

  if (name === "social") {
    ev.push(vevent({ uid: "m1", date: d(0, 0), from: "10:00", to: "10:30", title: "Post: Open House reminder" }));
    ev.push(vevent({ uid: "m2", date: d(0, 2), from: "14:00", to: "14:30", title: "Instagram story: club spotlight" }));
    ev.push(vevent({ uid: "m3", date: d(1, 0), from: "10:00", to: "10:30", title: "Post: Open House photos" }));
    return wrap("Social Media", ev);
  }

  if (name === "personal") {
    ev.push(vevent({ uid: "p1", date: d(0, 1), from: "15:00", to: "16:00", title: "Dentist", location: "Poughkeepsie" }));
    ev.push(vevent({ uid: "p2", date: d(0, 3), from: "08:00", to: "08:30", title: "Coffee with Sam" }));
    return wrap("My Outlook (sample)", ev);
  }

  throw new Error(`no sample calendar called "${name}"`);
}
