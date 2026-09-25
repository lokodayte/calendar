// Wall-clock <-> instant conversions for one named time zone, using only Intl.
// Dates as "YYYY-MM-DD" strings, times as minutes after midnight.

export const TZ = "America/New_York";

const fmtCache = new Map();
function formatter(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

/** Wall-clock parts of an instant in tz. */
export function zonedParts(ms, tz = TZ) {
  const p = {};
  for (const { type, value } of formatter(tz).formatToParts(new Date(ms))) p[type] = value;
  const y = +p.year, m = +p.month, d = +p.day, h = +p.hour % 24, mi = +p.minute;
  return { y, m, d, h, mi, s: +p.second, date: `${p.year}-${p.month}-${p.day}`, minutes: h * 60 + mi, weekday: weekdayOf(`${p.year}-${p.month}-${p.day}`) };
}

function offsetAt(ms, tz) {
  const p = zonedParts(ms, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

/** Instant (ms) for a wall-clock date + minutes-after-midnight in tz. */
export function zonedToUtc(date, minutes, tz = TZ) {
  const [y, m, d] = date.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, minutes);
  let t = guess - offsetAt(guess, tz);
  const o2 = offsetAt(t, tz);
  if (guess - o2 !== t) t = guess - o2;
  return t;
}

export function ymd(ms, tz = TZ) { return zonedParts(ms, tz).date; }

export function addDays(date, n) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday */
export function weekdayOf(date) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function mondayOf(date) {
  return addDays(date, -((weekdayOf(date) + 6) % 7));
}

export function parseHm(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ""));
  if (!m) return null;
  const v = +m[1] * 60 + +m[2];
  return +m[1] <= 24 && +m[2] < 60 && v <= 1440 ? v : null;
}
