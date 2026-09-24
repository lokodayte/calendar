// Admin tab: staff list and devices, shared calendars, desk coverage settings, site settings, activity log.
// Visible only to admins; the Worker enforces this independently on every admin request.

import { api } from "./api.js";
import { h, toast, confirmDialog, busy, colorPicker, sourceIcon, SOURCES, fmtStamp } from "./dom.js";
import { extractName, DEFAULT_COVERAGE } from "./coverage.js";
import { WEEKDAY_LONG } from "./tz.js";

function detectSource(url) {
  const u = String(url || "").toLowerCase();
  if (/outlook\.(office365|office|live)\.com|\.outlook\.com|office365\.com|hotmail|exchange/.test(u)) return "outlook";
  if (/calendar\.google\.com|googleusercontent|google\.com\/calendar/.test(u)) return "google";
  if (/icloud\.com|\.me\.com|apple\.com/.test(u)) return "apple";
  return "other";
}

/** A throwaway modal dialog. */
function modal(title, body, actions) {
  const d = h("dialog", { "aria-label": title },
    h("div", { class: "dlg" },
      h("button", { class: "x", type: "button", "aria-label": "Close", text: "×", onclick: () => d.close() }),
      h("h2", { text: title }), body, actions ? h("div", { class: "dlg-actions" }, actions) : null));
  d.addEventListener("close", () => d.remove());
  d.addEventListener("click", (e) => { if (e.target === d) d.close(); });
  document.body.append(d);
  d.showModal();
  return d;
}

const field = (labelText, input, hint) => h("div", { style: { display: "flex", "flex-direction": "column", gap: "6px" } },
  h("label", { text: labelText }), input, hint ? h("p", { class: "muted small", text: hint }) : null);

export function initAdmin(root, ctx) {
  const D = { staff: [], calendars: [], settings: null, log: [] };
  let filter = "";

  const staffPanel = h("section", { class: "card panel", id: "admin-staff" });
  const calPanel = h("section", { class: "card panel", id: "admin-calendars" });
  const covPanel = h("section", { class: "card panel", id: "admin-coverage" });
  const setPanel = h("section", { class: "card panel", id: "admin-settings" });
  const logPanel = h("section", { class: "card panel", id: "admin-log" });
  const jump = (id) => (e) => { e.preventDefault(); document.getElementById(id).scrollIntoView({ behavior: "smooth" }); };
  root.append(
    h("nav", { class: "admin-nav", "aria-label": "Admin sections" },
      h("a", { href: "#admin", text: "Staff", onclick: jump("admin-staff") }),
      h("a", { href: "#admin", text: "Shared calendars", onclick: jump("admin-calendars") }),
      h("a", { href: "#admin", text: "Desk coverage", onclick: jump("admin-coverage") }),
      h("a", { href: "#admin", text: "Settings", onclick: jump("admin-settings") }),
      h("a", { href: "#admin", text: "Recent activity", onclick: jump("admin-log") })),
    staffPanel, calPanel, covPanel, setPanel, logPanel);

  async function loadAll() {
    const [st, cal, set, log] = await Promise.all([
      api("/api/admin/staff"), api("/api/admin/calendars"), api("/api/admin/settings"), api("/api/admin/log"),
    ]);
    D.staff = st.staff; D.calendars = cal.calendars; D.settings = set; D.log = log.log;
  }
  const refreshLog = async () => { D.log = (await api("/api/admin/log")).log; renderLog(); };

  /* ================= Staff ================= */

  function renderStaff() {
    const ta = h("textarea", { rows: 3, placeholder: "name@marist.edu, other@marist.edu…\nYou can paste a whole list, one per line or separated by commas.", "aria-label": "Emails to add" });
    const welcome = h("input", { type: "checkbox" });
    const result = h("p", { class: "muted", hidden: true });
    const addBtn = h("button", { class: "btn primary", type: "submit", text: "Add to staff list" });
    const form = h("form", { class: "inline-form", novalidate: true },
      ta,
      h("div", { class: "inline-row" }, h("label", { class: "check" }, welcome, h("span", { text: "Send them a welcome email with the site link (uses your monthly email allowance; up to 20 at a time)" })), h("span", { class: "grow" }), addBtn),
      result);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!ta.value.trim()) return;
      await busy(addBtn, "Adding…", async () => {
        try {
          const r = await api("/api/admin/staff", { method: "POST", body: { emails: ta.value, welcome: welcome.checked } });
          const parts = [];
          parts.push(r.added.length ? `Added ${r.added.length}: ${r.added.join(", ")}.` : "No new people added.");
          if (r.already.length) parts.push(`Already on the list: ${r.already.join(", ")}.`);
          if (welcome.checked && r.added.length) parts.push(r.welcomeFailed ? `${r.welcomed} welcome emails sent, ${r.welcomeFailed} failed.` : `Welcome email sent to ${r.welcomed}.`);
          ta.value = "";
          D.staff = (await api("/api/admin/staff")).staff;
          renderStaff();
          const res = staffPanel.querySelector(".add-result");
          res.textContent = parts.join(" ");
          res.hidden = false;
          refreshLog();
        } catch (err) { result.textContent = err.message; result.className = "err"; result.hidden = false; }
      });
    });
    result.classList.add("add-result");

    const search = h("input", { type: "search", placeholder: "Find a person…", value: filter, "aria-label": "Find a person" });
    const tbody = h("tbody");
    const draw = () => {
      tbody.textContent = "";
      const rows = D.staff.filter((s) => s.email.includes(filter.toLowerCase()));
      if (!rows.length) tbody.append(h("tr", {}, h("td", { colspan: 4, class: "muted", text: D.staff.length ? "No match." : "Nobody yet. Paste emails above." })));
      for (const s of rows) {
        tbody.append(h("tr", {},
          h("td", { class: "email" }, s.email, s.isAdmin ? h("span", { class: "pill", style: { "margin-left": "8px" }, text: "Admin" }) : null),
          h("td", { class: "hide-phone", text: s.lastSignIn ? fmtStamp(s.lastSignIn) : "Never" }),
          h("td", { text: String(s.devices) }),
          h("td", { class: "actions" },
            h("button", { class: "btn small", type: "button", text: "Devices", onclick: () => showDevices(s) }),
            s.devices ? h("button", { class: "btn small", type: "button", text: "Revoke all devices", onclick: () => revokeAll(s) }) : null,
            s.isAdmin ? null : h("button", { class: "btn small danger", type: "button", text: "Remove", onclick: () => removeStaff(s) }))));
      }
    };
    search.addEventListener("input", () => { filter = search.value.trim(); draw(); });
    draw();

    staffPanel.replaceChildren(
      h("h2", { text: `Staff list (${D.staff.length})` }),
      h("p", { class: "muted sub", text: "Only people on this list can sign in. Removing someone signs them out everywhere immediately." }),
      form,
      h("div", { class: "inline-row" }, search),
      h("div", { style: { "overflow-x": "auto" } }, h("table", { class: "tbl" },
        h("thead", {}, h("tr", {}, h("th", { text: "Email" }), h("th", { class: "hide-phone", text: "Last sign-in" }), h("th", { text: "Devices" }), h("th"))),
        tbody)));
  }

  async function reloadStaff() { D.staff = (await api("/api/admin/staff")).staff; renderStaff(); refreshLog(); }

  async function removeStaff(s) {
    if (!(await confirmDialog(`Remove ${s.email}?`, "They'll be signed out on every device right away and won't be able to sign in again unless you add them back.", "Remove"))) return;
    try { await api(`/api/admin/staff/${encodeURIComponent(s.email)}`, { method: "DELETE" }); toast(`${s.email} removed.`); await reloadStaff(); }
    catch (err) { toast(err.message); }
  }

  async function revokeAll(s) {
    if (!(await confirmDialog(`Sign ${s.email} out everywhere?`, "They stay on the staff list and can sign in again with a new email code.", "Sign out all"))) return;
    try { const r = await api(`/api/admin/staff/${encodeURIComponent(s.email)}/sessions`, { method: "DELETE" }); toast(`Signed out of ${r.devicesSignedOut} device(s).`); await reloadStaff(); }
    catch (err) { toast(err.message); }
  }

  async function showDevices(s) {
    let sessions;
    try { sessions = (await api(`/api/admin/staff/${encodeURIComponent(s.email)}/sessions`)).sessions; }
    catch (err) { return toast(err.message); }
    const list = h("ul", { class: "log" });
    const d = modal(`Devices for ${s.email}`, sessions.length ? list : h("p", { class: "muted", text: "Not signed in on any device." }));
    for (const x of sessions) {
      const li = h("li", {},
        h("span", { class: "grow" }, h("b", { text: x.device }), h("br"),
          h("span", { class: "muted small", text: `Signed in ${fmtStamp(x.createdAt)} · last seen ${fmtStamp(x.lastSeen)}` })),
        h("button", { class: "btn small danger", type: "button", text: "Sign out", onclick: async () => {
          try { await api(`/api/admin/sessions/${encodeURIComponent(x.id)}`, { method: "DELETE" }); li.remove(); toast("Device signed out."); reloadStaff(); if (!list.children.length) d.close(); }
          catch (err) { toast(err.message); }
        } }));
      list.append(li);
    }
  }

  /* ================= Shared calendars ================= */

  function renderCalendars() {
    const rows = h("ul", { class: "cal-rows" });
    D.calendars.forEach((c, i) => {
      rows.append(h("li", { class: "cal-row" },
        h("div", { class: "order" },
          h("button", { type: "button", "aria-label": `Move ${c.name} up`, text: "▲", disabled: i === 0, onclick: () => move(i, -1) }),
          h("button", { type: "button", "aria-label": `Move ${c.name} down`, text: "▼", disabled: i === D.calendars.length - 1, onclick: () => move(i, 1) })),
        h("span", { class: "swatch", style: { "--c": c.color, width: "16px", height: "16px" } }),
        h("div", { class: "grow" },
          h("div", { class: "nm", text: c.name }),
          h("div", { class: "meta" },
            h("span", { class: "pill", style: { display: "inline-flex", gap: "5px", "align-items": "center" } }, h("span", { style: { display: "inline-flex", width: "13px" } }, sourceIcon(c.source)), SOURCES[c.source].label),
            c.isShift ? h("span", { class: "pill", text: "Shift calendar" }) : null,
            c.defaultOn ? null : h("span", { class: "pill", text: "Off by default" }),
            c.owner ? h("span", { class: "muted small", text: `Contact: ${c.owner}` }) : null)),
        h("button", { class: "btn small", type: "button", text: "Edit", onclick: () => editCalendar(c) })));
    });
    calPanel.replaceChildren(
      h("h2", { text: "Shared calendars" }),
      h("p", { class: "muted sub", text: "Everyone on the staff list sees these. Links stay on the server — staff never see them." }),
      D.calendars.length ? rows : h("p", { class: "muted", text: "No shared calendars yet. Add the Student Work Schedule, School Events, Club Events and Social Media." }),
      h("div", {}, h("button", { class: "btn primary", type: "button", text: "+ Add shared calendar", onclick: () => editCalendar(null) })));
  }

  async function move(i, dir) {
    const list = [...D.calendars];
    [list[i], list[i + dir]] = [list[i + dir], list[i]];
    try {
      await api("/api/admin/calendars/order", { method: "POST", body: { ids: list.map((c) => c.id) } });
      D.calendars = list;
      renderCalendars();
      ctx.reload();
      refreshLog();
    } catch (err) { toast(err.message); }
  }

  function editCalendar(cal) {
    const c = cal || { name: "", color: "#2F5BD3", url: "", source: "", owner: "", defaultOn: true, isShift: false };
    let sourceTouched = !!cal;
    const name = h("input", { maxlength: 80, value: c.name, required: true });
    const url = h("input", { maxlength: 2000, value: c.url, placeholder: "https://outlook.office365.com/owa/calendar/…/calendar.ics", spellcheck: "false", autocomplete: "off" });
    const source = h("select", {},
      ...["outlook", "google", "apple", "other"].map((s) => h("option", { value: s, text: SOURCES[s].label, selected: s === (c.source || "other") })));
    url.addEventListener("input", () => { if (!sourceTouched) source.value = detectSource(url.value); });
    source.addEventListener("change", () => { sourceTouched = true; });
    const owner = h("input", { maxlength: 120, value: c.owner, placeholder: "e.g. Parijat Das" });
    const colors = h("div", { class: "swatches" });
    const picked = colorPicker(colors, c.color);
    const defaultOn = h("input", { type: "checkbox", checked: c.defaultOn });
    const isShift = h("input", { type: "checkbox", checked: c.isShift });
    const testOut = h("div", { class: "test-result", hidden: true });
    const err = h("p", { class: "err", hidden: true });
    const testBtn = h("button", { class: "btn", type: "button", text: "Test link" });

    testBtn.onclick = () => busy(testBtn, "Testing…", async () => {
      testOut.hidden = false;
      testOut.className = "test-result";
      testOut.textContent = "Testing…";
      try {
        const body = url.value.trim() ? { url: url.value.trim() } : cal ? { id: cal.id } : null;
        if (!body) { testOut.textContent = "Paste a link first."; return; }
        const r = await api("/api/admin/test-feed", { method: "POST", body });
        if (!r.ok) { testOut.className = "test-result bad"; testOut.textContent = r.error; return; }
        testOut.replaceChildren(h("b", { text: `It works: found ${r.events} event${r.events === 1 ? "" : "s"}.` }));
        if (!sourceTouched) source.value = r.source;
        if (r.titles.length) {
          const prefixes = D.settings.coverage.prefixes;
          testOut.append(
            h("p", { class: "muted small", style: { margin: "8px 0 0" }, text: isShift.checked || c.isShift
              ? "Worker names we'll read from the event titles. If a name looks wrong, adjust “Words to ignore” in Desk coverage."
              : "Some event titles from this calendar:" }),
            h("table", {}, h("tbody", {}, r.titles.slice(0, 15).map((t) => h("tr", {},
              h("td", { text: t }), isShift.checked || c.isShift ? h("td", { text: `→ ${extractName(t, prefixes)}` }) : null)))));
        }
      } catch (e2) { testOut.className = "test-result bad"; testOut.textContent = e2.message; }
    });

    const save = h("button", { class: "btn primary", type: "button", text: "Save" });
    const del = cal ? h("button", { class: "btn danger", type: "button", text: "Delete" }) : null;
    const d = modal(cal ? `Edit ${cal.name}` : "Add shared calendar",
      h("div", { style: { display: "flex", "flex-direction": "column", gap: "12px" } },
        field("Name", name),
        field("ICS link", url, "Outlook: Settings → Calendar → Shared calendars → Publish → copy the ICS link. Google: Settings → the calendar → Integrate calendar → iCal address."),
        h("div", { class: "inline-row" }, testBtn),
        testOut,
        field("Source", source, "Detected from the link. Change it if it's wrong."),
        field("Owner or contact (optional)", owner),
        h("div", {}, h("span", { class: "label", text: "Color" }), colors),
        h("label", { class: "check" }, defaultOn, h("span", { text: "On by default for staff (each person can still turn it off)" })),
        h("label", { class: "check" }, isShift, h("span", { text: "Shift calendar — each event is a person's desk shift (used by Coverage)" })),
        err),
      [del, h("span", { class: "grow" }), h("button", { class: "btn", type: "button", text: "Cancel", onclick: () => d.close() }), save].filter(Boolean));

    save.onclick = () => busy(save, "Saving…", async () => {
      err.hidden = true;
      const body = { name: name.value.trim(), color: picked.value, url: url.value.trim(), source: source.value, owner: owner.value.trim(), defaultOn: defaultOn.checked, isShift: isShift.checked };
      if (!body.name) { err.textContent = "Give the calendar a name."; err.hidden = false; return; }
      if (!body.url) { err.textContent = "Paste the calendar's ICS link."; err.hidden = false; return; }
      try {
        if (cal) await api(`/api/admin/calendars/${cal.id}`, { method: "PUT", body });
        else await api("/api/admin/calendars", { method: "POST", body });
        D.calendars = (await api("/api/admin/calendars")).calendars;
        d.close();
        renderCalendars();
        toast(cal ? "Calendar saved." : "Calendar added.");
        ctx.reload();
        refreshLog();
      } catch (e2) { err.textContent = e2.message; err.hidden = false; }
    });
    if (del) {
      del.onclick = async () => {
        if (!(await confirmDialog(`Delete ${cal.name}?`, "It disappears for everyone. The original Outlook or Google calendar isn't touched.", "Delete"))) return;
        try {
          await api(`/api/admin/calendars/${cal.id}`, { method: "DELETE" });
          D.calendars = D.calendars.filter((x) => x.id !== cal.id);
          d.close();
          renderCalendars();
          toast("Calendar deleted.");
          ctx.reload();
          refreshLog();
        } catch (e2) { err.textContent = e2.message; err.hidden = false; }
      };
    }
    name.focus();
  }

  /* ================= Desk coverage settings ================= */

  function renderCoverage() {
    const cov = D.settings.coverage;
    const order = [1, 2, 3, 4, 5, 6, 0];
    const hourInputs = {};
    const hours = h("div", { class: "hours" },
      h("span", { class: "label", text: "Day" }), h("span", { class: "label", text: "Opens" }), h("span", { class: "label", text: "Closes" }));
    for (const wd of order) {
      const cur = cov.hours[wd];
      const open = h("input", { type: "checkbox", checked: !!cur });
      const from = h("input", { type: "time", value: cur ? cur[0] : "09:00", step: 900, disabled: !cur, "aria-label": `${WEEKDAY_LONG[wd]} opens` });
      const to = h("input", { type: "time", value: cur ? cur[1] : "17:00", step: 900, disabled: !cur, "aria-label": `${WEEKDAY_LONG[wd]} closes` });
      open.addEventListener("change", () => { from.disabled = to.disabled = !open.checked; });
      hourInputs[wd] = { open, from, to };
      hours.append(h("label", { class: "check" }, open, h("span", { text: WEEKDAY_LONG[wd] })), from, to);
    }
    const minStaff = h("input", { type: "number", min: 1, max: 20, value: cov.minStaff, style: { width: "90px" } });
    const slot = h("select", { style: { width: "140px" } },
      h("option", { value: "30", text: "30 minutes", selected: cov.slotMinutes === 30 }),
      h("option", { value: "15", text: "15 minutes", selected: cov.slotMinutes === 15 }));

    const closedBox = h("div", { class: "closed-rows" });
    const addClosed = (c = { from: "", to: "", label: "" }) => {
      const from = h("input", { type: "date", value: c.from, "aria-label": "First closed day" });
      const to = h("input", { type: "date", value: c.to === c.from ? "" : c.to, "aria-label": "Last closed day (optional)" });
      const label = h("input", { value: c.label, maxlength: 80, placeholder: "e.g. Thanksgiving", "aria-label": "Reason" });
      const row = h("div", { class: "closed-row" }, from, to, label,
        h("button", { class: "btn small", type: "button", text: "Remove", onclick: () => row.remove() }));
      row._get = () => ({ from: from.value, to: to.value || from.value, label: label.value.trim() });
      closedBox.append(row);
    };
    for (const c of cov.closed) addClosed(c);

    const prefixes = h("input", { value: cov.prefixes.join(", "), maxlength: 600 });
    const tryTitle = h("input", { placeholder: "Try an event title, e.g. Front desk: Elina", maxlength: 200 });
    const tryOut = h("p", { class: "muted small" });
    const updateTry = () => {
      const list = prefixes.value.split(",").map((s) => s.trim()).filter(Boolean);
      tryOut.textContent = tryTitle.value.trim() ? `Worker name: ${extractName(tryTitle.value, list)}` : "";
    };
    prefixes.addEventListener("input", updateTry);
    tryTitle.addEventListener("input", updateTry);

    const err = h("p", { class: "err", hidden: true });
    const save = h("button", { class: "btn primary", type: "button", text: "Save coverage settings" });
    save.onclick = () => busy(save, "Saving…", async () => {
      err.hidden = true;
      const hoursOut = {};
      for (const wd of order) {
        const x = hourInputs[wd];
        if (!x.open.checked) continue;
        if (!x.from.value || !x.to.value || x.to.value <= x.from.value) { err.textContent = `${WEEKDAY_LONG[wd]}: closing time must be after opening time.`; err.hidden = false; return; }
        hoursOut[wd] = [x.from.value, x.to.value];
      }
      const closed = [...closedBox.children].map((r) => r._get()).filter((c) => c.from);
      if (closed.some((c) => c.to < c.from)) { err.textContent = "A closed-dates range ends before it starts."; err.hidden = false; return; }
      const coverage = {
        hours: hoursOut, minStaff: +minStaff.value || 1, slotMinutes: +slot.value, closed,
        prefixes: prefixes.value.split(",").map((s) => s.trim()).filter(Boolean),
      };
      try {
        D.settings = await api("/api/admin/settings", { method: "PUT", body: { coverage } });
        renderCoverage();
        toast("Coverage settings saved.");
        ctx.reload();
        refreshLog();
      } catch (e2) { err.textContent = e2.message; err.hidden = false; }
    });

    covPanel.replaceChildren(
      h("h2", { text: "Desk coverage" }),
      h("p", { class: "muted sub", text: "Used by the Coverage tab. Mark the student work schedule as a “Shift calendar” under Shared calendars." }),
      h("h3", { text: "Office hours", style: { margin: "4px 0 0", "font-size": "16px" } }), hours,
      h("div", { class: "inline-row" },
        h("div", {}, h("label", { text: "People needed at the desk" }), minStaff),
        h("div", {}, h("label", { text: "Grid block size" }), slot)),
      h("h3", { text: "Closed dates (holidays and breaks)", style: { margin: "8px 0 0", "font-size": "16px" } }),
      h("p", { class: "muted small", text: "These days never count as gaps. Leave “to” empty for a single day." }),
      closedBox,
      h("div", {}, h("button", { class: "btn small", type: "button", text: "+ Add closed dates", onclick: () => addClosed() })),
      h("h3", { text: "Reading worker names", style: { margin: "8px 0 0", "font-size": "16px" } }),
      field("Words to ignore in shift titles (comma-separated)", prefixes, `Default: ${DEFAULT_COVERAGE.prefixes.join(", ")}. “Front desk: Elina” becomes “Elina”.`),
      tryTitle, tryOut,
      err,
      h("div", {}, save));
  }

  /* ================= Site settings ================= */

  function renderSettings() {
    const s = D.settings;
    const title = h("input", { value: s.siteTitle, maxlength: 60 });
    const sender = h("input", { value: s.senderName, maxlength: 60 });
    const err = h("p", { class: "err", hidden: true });
    const save = h("button", { class: "btn primary", type: "button", text: "Save settings" });
    save.onclick = () => busy(save, "Saving…", async () => {
      err.hidden = true;
      try {
        D.settings = await api("/api/admin/settings", { method: "PUT", body: { siteTitle: title.value.trim(), senderName: sender.value.trim() } });
        toast("Settings saved.");
        ctx.reload();
        refreshLog();
      } catch (e2) { err.textContent = e2.message; err.hidden = false; }
    });
    setPanel.replaceChildren(
      h("h2", { text: "Settings" }),
      field("Site title", title),
      field("Sender name for emails", sender, {
        emailjs: "Emails are sent through EmailJS, from the Gmail or Outlook account connected there. Free plan: 200 emails a month.",
        brevo: "Emails are sent through Brevo.",
        dev: "Local dev mode: emails are printed in the Worker terminal.",
      }[s.emailProvider] || "No email service is set up yet, so sign-in codes can't be sent. See README, Part A."),
      s.emailStatus ? h("p", { class: "warn", text: `Emails are failing (last problem ${fmtStamp(s.emailStatus.at)}): ${s.emailStatus.error}. Staff may not be getting sign-in codes. If EmailJS says the limit is reached, it resets at the start of next month.` }) : null,
      s.siteUrl ? h("p", { class: "muted small", text: `Link in welcome emails: ${s.siteUrl}` }) : null,
      err, h("div", {}, save));
  }

  /* ================= Log ================= */

  function renderLog() {
    logPanel.replaceChildren(
      h("h2", { text: "Recent activity" }),
      D.log.length
        ? h("ul", { class: "log" }, D.log.map((l) => h("li", {},
          h("time", { text: fmtStamp(l.at) }),
          h("span", { class: "grow" }, l.detail, h("br"), h("span", { class: "who", text: l.actor })))))
        : h("p", { class: "muted", text: "Nothing yet. Changes made in this Admin tab are listed here." }));
  }

  return {
    async show() {
      if (!D.settings) root.querySelector(".admin-nav").after(h("p", { class: "muted admin-loading", text: "Loading…" }));
      try {
        await loadAll();
        root.querySelector(".admin-loading")?.remove();
        renderStaff(); renderCalendars(); renderCoverage(); renderSettings(); renderLog();
      } catch (err) {
        root.querySelector(".admin-loading")?.remove();
        toast(err.message);
      }
    },
  };
}
