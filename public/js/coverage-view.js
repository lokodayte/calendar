// Coverage tab: who's at the desk now, who's next, the week grid and the gap list.
// Everything is computed in the browser from the shift calendars' events.

import { h, toast } from "./dom.js";
import { TZ, ymd, mondayOf, addDays, zonedParts, timeLabel, rangeLabel, WEEKDAY_SHORT, WEEKDAY_LONG } from "./tz.js";
import { expandIcs } from "./ics.js";
import { buildWeek, whoIsOn, nextUp, officeNow, shiftsFromOccurrences, gapListText } from "./coverage.js";

const shortDate = (date, opts = { month: "short", day: "numeric" }) => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, { ...opts, timeZone: "UTC" });
};
const clockAt = (ms) => timeLabel(zonedParts(ms, TZ).minutes);
function whenLabel(ms, now) {
  const p = zonedParts(ms, TZ);
  const today = ymd(now, TZ);
  if (p.date === today) return clockAt(ms);
  if (p.date === addDays(today, 1)) return `tomorrow at ${clockAt(ms)}`;
  return `${WEEKDAY_LONG[p.weekday]} at ${clockAt(ms)}`;
}
const shiftRange = (s, date) => {
  const a = zonedParts(s.start, TZ), b = zonedParts(s.end, TZ);
  const endMin = b.date === a.date ? b.minutes : 1440;
  return a.date === date ? rangeLabel(a.minutes, endMin) : `${shortDate(a.date)} ${rangeLabel(a.minutes, endMin)}`;
};

export function initCoverage(root, ctx) {
  let weekStart = mondayOf(ymd(Date.now(), TZ));
  let selected = null;       // {date, rowMin}
  let timer = null;
  let loaded = null;         // {from, to, shifts, errors}

  async function loadShifts(from, to) {
    const cals = ctx.state.calendars.filter((c) => c.isShift);
    const errors = [];
    const occs = [];
    await Promise.all(cals.map(async (c) => {
      try {
        const entry = await ctx.loadFeed(`shared:${c.id}`);
        occs.push(...expandIcs(entry.parsed, from, to));
        if (entry.stale) errors.push(`Couldn't load ${c.name} right now. Showing the last saved copy.`);
      } catch {
        errors.push(`Couldn't load ${c.name} right now. Coverage may be incomplete.`);
      }
    }));
    return { from, to, errors, shifts: shiftsFromOccurrences(occs, ctx.state.coverage.prefixes) };
  }

  async function render() {
    const S = ctx.state;
    const cals = S.calendars.filter((c) => c.isShift);
    if (!cals.length) {
      root.replaceChildren(h("div", { class: "card empty" },
        h("h2", { text: "No shift calendar yet" }),
        h("p", { class: "muted", text: S.me.isAdmin
          ? "Go to Admin → Shared calendars, edit the Student Work Schedule and tick “Shift calendar”. Coverage will then show here."
          : "An admin needs to mark the student work schedule as a shift calendar. Coverage will then show here." })));
      return;
    }

    const now = Date.now();
    const today = ymd(now, TZ);
    const from = Math.min(Date.parse(`${weekStart}T00:00:00Z`), now) - 2 * 864e5;
    const to = Math.max(Date.parse(`${addDays(weekStart, 7)}T00:00:00Z`), now + 14 * 864e5) + 2 * 864e5;
    if (!loaded || loaded.from > from || loaded.to < to || now - loaded.at > 5 * 60e3) {
      if (!root.childElementCount) root.replaceChildren(h("div", { class: "card empty" }, h("p", { class: "muted", text: "Loading shifts…" })));
      loaded = { ...(await loadShifts(from, to)), at: now };
    }
    const { shifts, errors } = loaded;
    const settings = S.coverage;
    const week = buildWeek({ shifts, weekStart, settings, tz: TZ });

    /* ---- now / next ---- */
    const office = officeNow(now, settings, TZ);
    const on = whoIsOn(shifts, now);
    const next = nextUp(shifts, now);
    const nowCard = h("section", { class: `card cov-card${office.open && !on.length ? " alert" : ""}`, "aria-live": "polite" }, h("h2", { text: "Now" }));
    if (on.length) {
      nowCard.append(h("p", { class: "big", text: on.length === 1 ? `${on[0].name} is at the desk` : `${on.length} people at the desk` }),
        h("ul", { class: "people" }, on.map((p) => h("li", {}, h("span", {}, h("span", { class: "dot" }), p.name), h("span", { class: "t", text: `until ${clockAt(p.end)}` })))));
      if (on.length < settings.minStaff && office.open) nowCard.append(h("p", { class: "muted", text: `Fewer than the ${settings.minStaff} people needed.` }));
    } else if (office.open) {
      nowCard.append(h("p", { class: "big", text: "No one at the desk right now" }),
        h("p", { class: "muted", text: next ? `Next: ${next.people.map((p) => p.name).join(", ")} at ${whenLabel(next.start, now)}.` : "No more shifts are scheduled." }));
    } else {
      const hoursReason = office.reason === "After office hours" || office.reason === "Before office hours";
      nowCard.append(h("p", { class: "big", text: hoursReason ? "Office is closed now" : office.reason }),
        h("p", { class: "muted", text: office.opensAt ? `Opens today at ${clockAt(office.opensAt)}.`
          : office.reason === "After office hours" ? "Office hours are over for today." : "No office hours today." }));
    }
    const nextCard = h("section", { class: "card cov-card" }, h("h2", { text: "Next up" }));
    if (next) {
      nextCard.append(h("p", { class: "big", text: `${next.people.map((p) => p.name).join(" & ")}` }),
        h("ul", { class: "people" }, next.people.map((p) => h("li", {}, h("span", { text: whenLabel(p.start, now) }), h("span", { class: "t", text: `until ${clockAt(p.end)}` })))));
    } else {
      nextCard.append(h("p", { class: "big", text: "Nothing scheduled" }), h("p", { class: "muted", text: "No shifts in the next two weeks." }));
    }

    /* ---- week bar ---- */
    const days = week.days;
    const label = days.length ? `${shortDate(days[0].date)} – ${shortDate(days[days.length - 1].date)}` : shortDate(weekStart);
    const thisWeek = mondayOf(today);
    const bar = h("div", { class: "week-bar" },
      h("h2", { text: weekStart === thisWeek ? `This week · ${label}` : `Week of ${label}` }),
      h("button", { class: "btn", type: "button", onclick: () => go(-7), "aria-label": "Previous week", text: "‹ Previous" }),
      weekStart !== thisWeek ? h("button", { class: "btn", type: "button", onclick: () => { weekStart = thisWeek; selected = null; render(); }, text: "This week" }) : null,
      h("button", { class: "btn", type: "button", onclick: () => go(7), "aria-label": "Next week", text: "Next ›" }));

    const legend = h("div", { class: "legend-row" },
      h("span", { class: "lg-covered", text: `Covered (${settings.minStaff}+ people)` }),
      h("span", { class: "lg-thin", text: settings.minStaff > 1 ? `Thin (fewer than ${settings.minStaff}, or only part of the time)` : "Partly covered" }),
      h("span", { class: "lg-gap", text: "Gap (nobody)" }),
      h("span", { class: "lg-closed", text: "Closed" }));

    /* ---- grid ---- */
    const detail = h("div", { class: "card cell-detail", "aria-live": "polite" });
    const grid = h("div", { class: "cov-grid", "aria-label": "Desk coverage this week", style: { "grid-template-columns": `64px repeat(${days.length}, minmax(70px, 1fr))` } });
    grid.append(h("div"));
    for (const d of days) {
      grid.append(h("div", { class: `hd${d.date === today ? " today" : ""}` },
        d.label, h("b", { text: shortDate(d.date, { day: "numeric" }) }),
        !d.open && d.closedDate ? h("span", { class: "small", text: d.reason, style: { display: "block", "text-transform": "none", "letter-spacing": "0" } }) : null));
    }
    week.rows.forEach((rowMin, ri) => {
      grid.append(h("div", { class: "tm", text: rowMin % 60 === 0 ? timeLabel(rowMin) : "" }));
      for (const d of days) {
        const c = d.cells[ri];
        if (c.status === "off" || c.status === "closed") { grid.append(h("div", { class: `cell ${c.status}`, "aria-hidden": "true" })); continue; }
        const names = [...new Set(c.people.map((p) => p.name))];
        const isNow = now >= c.start && now < c.end;
        const isSel = selected && selected.date === d.date && selected.rowMin === rowMin;
        const what = c.status === "gap" ? "gap, nobody scheduled" : c.status === "covered" ? `covered by ${names.join(", ")}` : `partly covered by ${names.join(", ")}`;
        const cell = h("button", {
          type: "button", class: `cell ${c.status}${isNow ? " now" : ""}`, "aria-pressed": String(!!isSel),
          "aria-label": `${WEEKDAY_LONG[d.weekday]} ${rangeLabel(c.startMin, c.endMin)}: ${what}`,
          title: `${rangeLabel(c.startMin, c.endMin)} — ${c.people.length ? c.people.map((p) => `${p.name} ${shiftRange(p, d.date)}`).join("; ") : "nobody"}`,
          text: c.status === "gap" ? "" : names.join(", "),
          onclick: () => { selected = { date: d.date, rowMin }; showDetail(d, c); for (const b of grid.querySelectorAll(".cell[aria-pressed]")) b.setAttribute("aria-pressed", "false"); cell.setAttribute("aria-pressed", "true"); },
        });
        grid.append(cell);
      }
    });

    function showDetail(d, c) {
      detail.replaceChildren(
        h("b", { text: `${WEEKDAY_LONG[d.weekday]}, ${shortDate(d.date)} · ${rangeLabel(c.startMin, c.endMin)}` }), " — ",
        c.status === "gap" ? "nobody is scheduled." : c.status === "covered" ? "covered." : c.min === 0 ? "covered for only part of this time." : `only ${c.min} of the ${settings.minStaff} people needed.`,
        c.people.length ? h("ul", { class: "people", style: { "margin-top": "8px" } },
          c.people.map((p) => h("li", {}, h("span", { text: p.name }), h("span", { class: "t", text: shiftRange(p, d.date) })))) : null);
    }
    if (selected) {
      const d = days.find((x) => x.date === selected.date);
      const c = d && d.cells[week.rows.indexOf(selected.rowMin)];
      if (c && c.people) showDetail(d, c);
    }

    /* ---- gap list ---- */
    const gaps = week.gaps;
    const heading = `Desk coverage gaps, ${label}:`;
    const gapsCard = h("section", { class: "card gaps" },
      h("div", { class: "gaps-head" },
        h("h2", { text: gaps.length ? `Uncovered this week (${gaps.length})` : "Uncovered this week" }),
        h("button", { class: "btn small", type: "button", text: "Copy list", onclick: () => copy(gapListText(gaps, heading)) })),
      gaps.length
        ? h("ul", { class: "gap-list" }, gaps.map((g) => h("li", { class: `${g.kind === "thin" ? "thin" : ""}${g.end <= now ? " past" : ""}`, text: `${g.label} · ${shortDate(g.date)}` })))
        : h("p", { class: "muted", text: "Every office hour this week is covered." }),
      h("p", { class: "muted small", text: `Office hours and closed dates are set by an admin. Grid: ${settings.slotMinutes}-minute blocks, times in Eastern Time.` }));

    const warn = errors.map((e) => h("div", { class: "notice" }, h("span", { class: "grow", text: e })));
    root.replaceChildren(
      ...warn,
      h("div", { class: "cov-top" }, nowCard, nextCard),
      bar, legend,
      h("div", { class: "card grid-wrap" }, days.length ? grid : h("p", { class: "muted", text: "No office hours are set. An admin can add them in Admin → Desk coverage." })),
      detail,
      gapsCard,
    );
  }

  function go(days) { weekStart = addDays(weekStart, days); selected = null; render(); }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast("Copied. Paste it into an email.");
    } catch {
      const ta = h("textarea", { style: { position: "fixed", opacity: "0" } });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      try { document.execCommand("copy"); toast("Copied. Paste it into an email."); } catch { toast("Couldn't copy. Select the list and copy it by hand."); }
      ta.remove();
    }
  }

  const safeRender = () => render().catch((err) => { console.error(err); root.replaceChildren(h("div", { class: "notice error" }, h("span", { text: `Couldn't show coverage: ${err.message}` }))); });

  return {
    show() {
      safeRender();
      clearInterval(timer);
      timer = setInterval(() => { if (!root.closest(".view").hidden && !document.hidden) safeRender(); else clearInterval(timer); }, 60e3);
    },
    invalidate() { loaded = null; },
  };
}
