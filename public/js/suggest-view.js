// Suggestions tab: anyone signed in can suggest an event (with an optional flyer);
// admins see the inbox, add the event where it belongs, and mark it Added / Not added.
// Loaded only when someone opens the tab.

import { api } from "./api.js";
import { h, toast, busy, setErr, fmtStamp, linkify, fill } from "./dom.js";
import { TZ, ymd, addDays } from "./tz.js";

const MAX_FILE = 1_200_000;

/* ---------- small helpers ---------- */

function whenLabel(s) {
  const [y, m, d] = s.date.split("-").map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  if (s.allDay) return `${day} · all day`;
  const t = (hm) => { const [hh, mm] = hm.split(":").map(Number); return `${hh % 12 || 12}:${String(mm).padStart(2, "0")} ${hh < 12 ? "am" : "pm"}`; };
  return `${day} · ${t(s.startTime)} – ${t(s.endTime)}`;
}

/** A tiny dialog asking for an optional note. Resolves to the note, or null if cancelled. */
function askNote(title, placeholder, yesLabel) {
  return new Promise((resolve) => {
    const input = h("textarea", { rows: 2, maxlength: 300, placeholder });
    const d = h("dialog", { "aria-label": title },
      h("form", { class: "dlg", method: "dialog" },
        h("h2", { text: title }),
        h("label", { text: "Note for the person who suggested it (optional)" }), input,
        h("div", { class: "dlg-actions" },
          h("button", { class: "btn", type: "button", text: "Cancel", onclick: () => { d.close(); resolve(null); } }),
          h("button", { class: "btn primary", type: "submit", text: yesLabel }))));
    d.querySelector("form").addEventListener("submit", (e) => { e.preventDefault(); d.close(); resolve(input.value.trim()); });
    d.addEventListener("cancel", () => resolve(null));
    d.addEventListener("close", () => d.remove());
    document.body.append(d);
    d.showModal();
    input.focus();
  });
}

/** Photos are shrunk in the browser (max 1600 px, JPEG) before upload, so they're usually 100–400 KB. */
async function prepareFile(file) {
  if (file.type === "application/pdf") {
    if (file.size > MAX_FILE) throw new Error("This PDF is too large (max 1.2 MB). Attach a photo or screenshot of the flyer instead.");
    return { name: file.name, blob: file };
  }
  if (!file.type.startsWith("image/")) throw new Error("Attach a photo (JPG, PNG, GIF, WebP) or a PDF.");
  if (file.size <= 300_000 && /^image\/(jpeg|png|gif|webp)$/.test(file.type)) return { name: file.name, blob: file };
  let bmp;
  try { bmp = await createImageBitmap(file); } catch { throw new Error("This photo format can't be read here. Try a JPG or PNG."); }
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  const g = c.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(bmp, 0, 0, c.width, c.height);
  const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.82));
  if (!blob || blob.size > MAX_FILE) throw new Error("This photo is too large even after shrinking it.");
  return { name: file.name.replace(/\.[^.]+$/, "") + ".jpg", blob };
}

/** data: URL → Blob, decoded in the page (the site's security policy doesn't allow fetch() on data: URLs). */
function dataUrlToBlob(dataUrl) {
  const [head, b64] = dataUrl.split(",");
  const type = /^data:([^;]+)/.exec(head)[1];
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

const toDataUrl = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(new Error("The file couldn't be read."));
  r.readAsDataURL(blob);
});

/* ---------- calendar file (.ics) for importing into Outlook or calendar.online ---------- */

const icsText = (s) => String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const fold = (line) => line.length <= 73 ? line : line.match(/.{1,73}/g).join("\r\n ");
const NY_TZ = ["BEGIN:VTIMEZONE", "TZID:America/New_York",
  "BEGIN:DAYLIGHT", "TZOFFSETFROM:-0500", "TZOFFSETTO:-0400", "TZNAME:EDT", "DTSTART:19700308T020000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU", "END:DAYLIGHT",
  "BEGIN:STANDARD", "TZOFFSETFROM:-0400", "TZOFFSETTO:-0500", "TZNAME:EST", "DTSTART:19701101T020000", "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU", "END:STANDARD",
  "END:VTIMEZONE"];

function suggestionIcs(s) {
  const d = s.date.replace(/-/g, "");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const desc = [s.details, s.host ? `Host: ${s.host}` : "", s.link].filter(Boolean).join("\n\n");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//SCSM Calendar//Suggestion//EN", "CALSCALE:GREGORIAN", ...NY_TZ, "BEGIN:VEVENT",
    `UID:suggestion-${s.id}-${s.createdAt}@scsm-calendar`, `DTSTAMP:${stamp}`];
  if (s.allDay) lines.push(`DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${addDays(s.date, 1).replace(/-/g, "")}`);
  else lines.push(`DTSTART;TZID=${TZ}:${d}T${s.startTime.replace(":", "")}00`, `DTEND;TZID=${TZ}:${d}T${s.endTime.replace(":", "")}00`);
  lines.push(`SUMMARY:${icsText(s.title)}`);
  if (s.location) lines.push(`LOCATION:${icsText(s.location)}`);
  if (desc) lines.push(`DESCRIPTION:${icsText(desc)}`);
  if (s.link) lines.push(`URL:${s.link}`);
  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

function download(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const detailsText = (s, calName) => [
  s.title, whenLabel(s), s.location && `Where: ${s.location}`, s.host && `Host: ${s.host}`, calName && `Calendar: ${calName}`,
  s.details, s.link,
].filter(Boolean).join("\n");

/* ---------- the view ---------- */

export function initSuggest(root, ctx) {
  const S = ctx.state;
  const calName = (id) => S.calendars.find((c) => c.id === id)?.name || "";

  function form() {
    const f = {
      title: h("input", { maxlength: 200, required: true, placeholder: "e.g. Math Department student panel" }),
      date: h("input", { type: "date", required: true, value: ymd(Date.now(), TZ) }),
      allDay: h("input", { type: "checkbox" }),
      start: h("input", { type: "time", step: 300, value: "15:00" }),
      end: h("input", { type: "time", step: 300, value: "16:00" }),
      location: h("input", { maxlength: 200, placeholder: "e.g. Hancock 2023" }),
      host: h("input", { maxlength: 120, placeholder: "e.g. Math Department, Computer Society, Prof. Kirtland" }),
      calendar: h("select", {}, h("option", { value: "", text: "Not sure — let the admins decide" }), S.calendars.map((c) => h("option", { value: c.id, text: c.name }))),
      details: h("textarea", { rows: 3, maxlength: 2000, placeholder: "What is it? Who is it for? Anything people should know." }),
      link: h("input", { type: "url", maxlength: 500, placeholder: "https://… (optional)" }),
      file: h("input", { type: "file", accept: "image/*,application/pdf" }),
    };
    const times = h("div", { class: "row2" }, h("div", {}, h("label", { text: "Starts" }), f.start), h("div", {}, h("label", { text: "Ends" }), f.end));
    f.allDay.addEventListener("change", () => { times.hidden = f.allDay.checked; });
    const fileNote = h("p", { class: "muted small", text: "Optional: a flyer photo or PDF. Photos are shrunk automatically; PDFs up to 1.2 MB." });
    let prepared = null;
    f.file.addEventListener("change", async () => {
      prepared = null;
      const file = f.file.files[0];
      if (!file) { fileNote.textContent = "Optional: a flyer photo or PDF."; return; }
      fileNote.textContent = "Preparing the file…";
      try {
        prepared = await prepareFile(file);
        fileNote.textContent = `Ready: ${prepared.name} (${Math.max(1, Math.round(prepared.blob.size / 1024))} KB)`;
      } catch (err) { f.file.value = ""; fileNote.textContent = err.message; }
    });
    const err = h("p", { class: "err", hidden: true });
    const send = h("button", { class: "btn primary", type: "submit", text: "Send suggestion" });
    const el = h("form", { class: "card panel suggest-form", novalidate: true },
      h("h2", { text: "Suggest an event" }),
      h("p", { class: "muted sub", text: "Something missing from the calendar? Tell the admins here. They'll add it and you'll see the result below." }),
      h("div", {}, h("label", { text: "Title" }), f.title),
      h("div", { class: "row2" }, h("div", {}, h("label", { text: "Date" }), f.date), h("label", { class: "check self-end" }, f.allDay, h("span", { text: "All day" }))),
      times,
      h("div", { class: "row2" }, h("div", {}, h("label", { text: "Location" }), f.location), h("div", {}, h("label", { text: "Host" }), f.host)),
      h("div", {}, h("label", { text: "Which calendar should it go on?" }), f.calendar),
      h("div", {}, h("label", { text: "Details" }), f.details),
      h("div", {}, h("label", { text: "Link" }), f.link),
      h("div", {}, h("label", { text: "Attachment" }), f.file, fileNote),
      err,
      h("div", { class: "dlg-actions" }, send));
    el.addEventListener("submit", async (e) => {
      e.preventDefault();
      setErr(err);
      if (!f.title.value.trim()) return setErr(err, "Give the event a title.");
      if (!f.allDay.checked && f.end.value <= f.start.value) return setErr(err, "The end time must be after the start time.");
      await busy(send, "Sending…", async () => {
        try {
          const body = {
            title: f.title.value.trim(), date: f.date.value, allDay: f.allDay.checked, startTime: f.start.value, endTime: f.end.value,
            location: f.location.value.trim(), host: f.host.value.trim(), details: f.details.value.trim(), link: f.link.value.trim(),
            calendarId: f.calendar.value ? Number(f.calendar.value) : null,
            file: prepared ? { name: prepared.name, data: await toDataUrl(prepared.blob) } : null,
          };
          await api("/api/suggestions", { method: "POST", body });
          toast("Thanks! Your suggestion was sent to the admins.");
          render();
        } catch (e2) { setErr(err, e2.message); }
      });
    });
    return el;
  }

  function mine(list) {
    const items = list.map((s) => {
      const badge = s.status === "pending" ? h("span", { class: "pill", text: "Waiting for review" })
        : s.status === "added" ? h("span", { class: "pill ok", text: "✓ Added" }) : h("span", { class: "pill no", text: "✗ Not added" });
      return h("li", { class: "sug-mine" },
        h("div", { class: "grow" }, h("b", { text: s.title }), h("div", { class: "muted small", text: whenLabel(s) }),
          s.note ? h("div", { class: "small", text: `Note: ${s.note}` }) : null),
        badge,
        h("button", { class: "btn small", type: "button", text: s.status === "pending" ? "Withdraw" : "Clear", onclick: async () => {
          try { await api(`/api/suggestions/${s.id}`, { method: "DELETE" }); render(); } catch (e) { toast(e.message); }
        } }));
    });
    return h("section", { class: "card panel" },
      h("h2", { text: "My suggestions" }),
      items.length ? h("ul", { class: "sug-list" }, items) : h("p", { class: "muted", text: "Nothing yet. Results stay here for 30 days." }));
  }

  function inboxCard(s, after) {
    const fileBox = h("div", { class: "sug-file" });
    if (s.file) {
      fileBox.append(h("button", { class: "btn small", type: "button", text: `📎 ${s.file.name} (${Math.max(1, Math.round(s.file.size / 1024))} KB)`, onclick: async (e) => {
        await busy(e.currentTarget, "Opening…", async () => {
          try {
            const f = await api(`/api/admin/suggestions/${s.id}/file`);
            const blob = dataUrlToBlob(f.data);
            if (f.type.startsWith("image/")) {
              const url = URL.createObjectURL(blob);
              fill(fileBox, h("img", { src: url, alt: `Attachment: ${f.name}`, class: "sug-img" }),
                h("button", { class: "link", type: "button", text: "Download", onclick: () => download(f.name, blob) }));
            } else download(f.name, blob);
          } catch (err) { toast(err.message); }
        });
      } }));
    }
    const decide = (decision) => async () => {
      const note = await askNote(decision === "added" ? "Mark as added?" : "Mark as not added?",
        decision === "added" ? "e.g. Added to SchoolCSM Events" : "e.g. Already on the calendar", decision === "added" ? "Added" : "Not added");
      if (note === null) return;
      try {
        await api(`/api/admin/suggestions/${s.id}/decide`, { method: "POST", body: { decision, note } });
        toast(decision === "added" ? "Marked as added. The details and file were deleted." : "Marked as not added. The details and file were deleted.");
        after();
      } catch (e) { toast(e.message); after(); }
    };
    return h("li", { class: "card sug-card" },
      h("div", { class: "sug-head" }, h("b", { class: "sug-title", text: s.title }),
        h("span", { class: "muted small", text: `from ${s.by.name || s.by.email} · ${fmtStamp(s.createdAt)}` })),
      h("div", { class: "sug-when", text: whenLabel(s) }),
      h("dl", { class: "kv" },
        s.location ? [h("dt", { text: "Where" }), h("dd", { text: s.location })] : null,
        s.host ? [h("dt", { text: "Host" }), h("dd", { text: s.host })] : null,
        h("dt", { text: "Calendar" }), h("dd", { text: calName(s.calendarId) || "Not sure" })),
      s.details ? (() => { const p = h("p", { class: "desc" }); linkify(p, s.details); return p; })() : null,
      s.link ? (() => { const p = h("p", { class: "small" }); linkify(p, s.link); return p; })() : null,
      fileBox,
      h("div", { class: "sug-actions" },
        h("button", { class: "btn small", type: "button", text: "Download for Outlook (.ics)", title: "Open this file to add the event to Outlook, or import it into calendar.online",
          onclick: () => download(`${s.title.replace(/[^\w\- ]+/g, "").slice(0, 40) || "event"}.ics`, new Blob([suggestionIcs(s)], { type: "text/calendar" })) }),
        h("button", { class: "btn small", type: "button", text: "Copy details", onclick: async () => {
          try { await navigator.clipboard.writeText(detailsText(s, calName(s.calendarId))); toast("Copied."); } catch { toast("Couldn't copy. Select the text by hand."); }
        } }),
        h("span", { class: "grow" }),
        h("button", { class: "btn small danger", type: "button", text: "Not added", onclick: decide("rejected") }),
        h("button", { class: "btn small primary", type: "button", text: "✓ Added", onclick: decide("added") })));
  }

  async function render() {
    const parts = [];
    if (S.me.isAdmin) {
      let inbox = [];
      try { inbox = (await api("/api/admin/suggestions")).suggestions; } catch (e) { toast(e.message); }
      ctx.setPending(inbox.length);
      parts.push(h("section", { class: "card panel" },
        h("h2", { text: inbox.length ? `Waiting for review (${inbox.length})` : "Waiting for review" }),
        h("p", { class: "muted sub", text: "Add each event to the right calendar (in Outlook or calendar.online — the .ics file imports in one step), then mark it Added. Marking it deletes the details and the file right away." }),
        inbox.length ? h("ul", { class: "sug-inbox" }, inbox.map((s) => inboxCard(s, render))) : h("p", { class: "muted", text: "All caught up — no suggestions waiting." })));
    }
    let list = [];
    try { list = (await api("/api/suggestions/mine")).suggestions; } catch (e) { toast(e.message); }
    parts.push(form(), mine(list));
    fill(root, ...parts);
  }

  return { show: render };
}
