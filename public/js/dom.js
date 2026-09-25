// Small DOM helpers. All user-entered text goes in with textContent — never innerHTML.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** h("button", {class: "btn", onclick}, "Label", childNode) */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k === "style") for (const [p, val] of Object.entries(v)) el.style.setProperty(p, val);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== "string") el[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";
function svg(viewBox, parts) {
  const s = document.createElementNS(SVG_NS, "svg");
  s.setAttribute("viewBox", viewBox);
  s.setAttribute("aria-hidden", "true");
  for (const [tag, attrs] of parts) {
    const p = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) p.setAttribute(k, v);
    s.append(p);
  }
  return s;
}

const letter = (bg, ch) => svg("0 0 20 20", [
  ["rect", { x: 1, y: 1, width: 18, height: 18, rx: 5, fill: bg }],
  ["text", { x: 10, y: 14.2, "text-anchor": "middle", "font-size": 11.5, "font-weight": 700, "font-family": "Arial, sans-serif", fill: "#fff" }],
]);

export const SOURCES = {
  outlook: { label: "Outlook", from: "From Outlook" },
  google: { label: "Google Calendar", from: "From Google Calendar" },
  apple: { label: "Apple Calendar", from: "From Apple Calendar" },
  other: { label: "Other", from: "From a calendar link" },
  scsm: { label: "SCSM Calendar", from: "Added by you in SCSM Calendar" },
};

/** A small, neutral icon for where a calendar comes from (letter badges, not brand logos). */
export function sourceIcon(source) {
  const map = { outlook: ["#0F6CBD", "O"], google: ["#188038", "G"], apple: ["#6E6E73", "A"] };
  if (map[source]) {
    const s = letter(...map[source]);
    s.querySelector("text").textContent = map[source][1];
    return s;
  }
  if (source === "scsm") {
    return svg("0 0 20 20", [
      ["rect", { x: 1, y: 1, width: 18, height: 18, rx: 5, fill: "var(--accent)" }],
      ["path", { d: "M6 14l1-3 5.5-5.5 2 2L9 13z", fill: "none", stroke: "#fff", "stroke-width": 1.6, "stroke-linejoin": "round" }],
    ]);
  }
  return svg("0 0 20 20", [
    ["rect", { x: 1, y: 1, width: 18, height: 18, rx: 5, fill: "#7B8499" }],
    ["path", { d: "M8.5 11.5l3-3M9 7h4v4M7 9v4h4", fill: "none", stroke: "#fff", "stroke-width": 1.6, "stroke-linecap": "round" }],
  ]);
}

/* ---------- feedback ---------- */

let toastTimer;
export function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), Math.max(3500, String(msg).length * 60));
}

export function setErr(el, msg) {
  el.textContent = msg || "";
  el.hidden = !msg;
}

export function confirmDialog(title, text, yes = "Yes") {
  const d = $("#dlgConfirm");
  $("#cfTitle").textContent = title;
  $("#cfText").textContent = text;
  $("#cfYes").textContent = yes;
  d.showModal();
  return new Promise((resolve) => {
    const done = (v) => { d.close(); $("#cfYes").onclick = $("#cfNo").onclick = null; resolve(v); };
    $("#cfYes").onclick = () => done(true);
    $("#cfNo").onclick = () => done(false);
    d.addEventListener("cancel", () => resolve(false), { once: true });
  });
}

/** Run an async action with a button showing a busy label. */
export async function busy(btn, label, fn) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try { return await fn(); } finally { btn.disabled = false; btn.textContent = old; }
}

/* ---------- colors ---------- */

export const PALETTE = ["#2F5BD3", "#1B7F52", "#B07A00", "#983BAE", "#C2410C", "#0E7C86", "#BE185D", "#4B5563"];

export function colorPicker(container, current, onChange) {
  container.textContent = "";
  let value = current;
  const buttons = PALETTE.map((c) => h("button", {
    type: "button", "aria-label": `Color ${c}`, "aria-pressed": String(c === value), style: { "--c": c },
    onclick: () => { value = c; buttons.forEach((b) => b.setAttribute("aria-pressed", String(b.style.getPropertyValue("--c") === c))); custom.value = c; onChange && onChange(c); },
  }));
  const custom = h("input", { type: "color", value: current, title: "Pick any color", "aria-label": "Custom color", style: { width: "36px", height: "30px", padding: "0", border: "0", background: "none" } });
  custom.addEventListener("input", () => { value = custom.value.toUpperCase(); buttons.forEach((b) => b.setAttribute("aria-pressed", "false")); onChange && onChange(value); });
  container.append(...buttons, custom);
  return { get value() { return value; } };
}

/* ---------- dates ---------- */

export const fmtDate = (d, opts = { weekday: "long", month: "long", day: "numeric" }) => d.toLocaleDateString(undefined, opts);
export const fmtTime = (d) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
export const fmtStamp = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "—");

/** Plain text with https links made clickable, safely (no HTML parsing). */
export function linkify(el, text) {
  el.textContent = "";
  const parts = String(text || "").split(/(https:\/\/[^\s<>"]+)/g);
  for (const p of parts) {
    if (/^https:\/\//.test(p)) el.append(h("a", { href: p, target: "_blank", rel: "noopener noreferrer", text: p }));
    else if (p) el.append(document.createTextNode(p));
  }
}

/** Soft, tinted event chips: pale fill, colored left edge, dark text (readable on any color). */
export function eventColors(color) {
  const c = /^#[0-9a-f]{6}$/i.test(color) ? color : "#5B4FB3";
  return { backgroundColor: `${c}24`, borderColor: c, textColor: "#221E33" };
}
