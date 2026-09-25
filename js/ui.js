// DOM building blocks. Everything is built with createElement + textContent —
// no innerHTML with data — so titles, notes and URLs from TMDB, Firestore,
// localStorage or imported files can never inject markup.

import { posterUrl } from "./storage.js";

const SVG_NS = "http://www.w3.org/2000/svg";

/** h("div", { class: "x", onclick: fn, dataset: {...} }, child, "text", ...) */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "text") el.textContent = v;
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function icon(name, cls = "") {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("aria-hidden", "true");
  if (cls) svg.setAttribute("class", cls);
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

// ---------- poster slot (image + fallback) ----------

/**
 * A poster "slotted into the device". If the URL is missing or fails to load,
 * a flat placeholder icon shows instead of a broken image.
 */
export function posterSlot(url, { alt = "", cls = "", lazy = true } = {}) {
  const slot = h("div", { class: `poster-slot ${cls}`.trim() });
  const fallback = h("div", { class: "poster-fallback", "aria-hidden": "true" }, icon("film"));
  slot.append(fallback);
  setSlotImage(slot, url, alt, lazy);
  return slot;
}

export function setSlotImage(slot, url, alt = "", lazy = true) {
  slot.querySelector("img")?.remove();
  slot.classList.remove("is-loaded", "is-broken");
  if (!url) { slot.classList.add("is-broken"); return; }
  const img = h("img", { alt, decoding: "async", loading: lazy ? "lazy" : "eager", referrerpolicy: "no-referrer" });
  img.addEventListener("load", () => slot.classList.add("is-loaded"));
  img.addEventListener("error", () => { slot.classList.add("is-broken"); img.remove(); });
  img.src = url;
  slot.prepend(img);
}

// ---------- LEDs / status ----------

export function statusLeds(movie) {
  const n = movie.watchLog.length;
  const wrap = h("div", { class: "status" });
  const leds = h("span", { class: "leds", "aria-hidden": "true" });
  if (n === 0) {
    leds.append(h("span", { class: "led led-hollow" }));
    wrap.append(leds, h("span", { class: "micro status-text", text: "On watchlist" }));
  } else {
    for (let i = 0; i < Math.min(n, 5); i++) leds.append(h("span", { class: "led led-on" }));
    wrap.append(leds, h("span", { class: "micro status-text", text: `Watched ${n}×` }));
    if (movie.inWatchlist) wrap.append(h("span", { class: "led led-hollow", title: "Also on watchlist", "aria-label": "Also on watchlist", role: "img" }));
  }
  return wrap;
}

// ---------- segmented rating meter ----------

/** Read-only 10-segment meter. */
export function miniMeter(rating) {
  const m = h("span", { class: "meter meter-mini", role: "img", "aria-label": rating ? `Rated ${rating} of 10` : "No rating" });
  for (let i = 1; i <= 10; i++) m.append(h("span", { class: `seg${rating && i <= rating ? " on" : ""}` }));
  return m;
}

/**
 * Interactive meter built on native radio inputs (keyboard + screen-reader friendly).
 * Returns { el, get value() }.
 */
export function ratingInput(name, initial = null, onChange = null) {
  let value = initial;
  const readout = h("span", { class: "meter-readout" });
  const segs = h("div", { class: "meter meter-input", role: "radiogroup", "aria-label": "Rating, 1 to 10" });
  const radios = [];
  for (let i = 1; i <= 10; i++) {
    const input = h("input", { type: "radio", name, value: i, id: `${name}-${i}`, class: "sr-only" });
    input.addEventListener("change", () => { value = i; paint(); onChange?.(value); });
    radios.push(input);
    segs.append(input, h("label", { for: `${name}-${i}`, class: "seg", title: `${i}/10` }, h("span", { class: "sr-only", text: `${i} out of 10` })));
  }
  const clear = h("button", { type: "button", class: "btn btn-xs btn-ghost", text: "Clear", onclick: () => { value = null; radios.forEach((r) => (r.checked = false)); paint(); onChange?.(value); } });
  function paint() {
    segs.querySelectorAll("label.seg").forEach((l, idx) => l.classList.toggle("on", value !== null && idx < value));
    readout.textContent = value ? `${value}/10` : "—/10";
    if (value) radios[value - 1].checked = true;
  }
  paint();
  const el = h("div", { class: "meter-wrap" }, segs, readout, clear);
  return { el, get value() { return value; } };
}

// ---------- cards ----------

export function libraryCard(movie) {
  const card = h("article", { class: "card", dataset: { id: movie.tmdbId } });
  const open = h("button", { type: "button", class: "card-open", dataset: { action: "open", id: movie.tmdbId }, "aria-label": `Open ${movie.title}` });
  card.append(
    posterSlot(posterUrl(movie), { alt: "" }),
    h("div", { class: "card-meta" }, h("h3", { class: "card-title", text: movie.title }), statusLeds(movie)),
    open,
  );
  return card;
}

export function searchCard(result, libMovie) {
  const card = h("article", { class: "card card-search" });
  const actions = h("div", { class: "card-actions" });
  if (!libMovie) {
    actions.append(
      h("button", { type: "button", class: "btn btn-xs btn-hero", dataset: { action: "add-watchlist", id: result.tmdbId } }, icon("plus"), "Watchlist"),
      h("button", { type: "button", class: "btn btn-xs", dataset: { action: "log-new", id: result.tmdbId } }, icon("eye"), "Watched"),
    );
  } else {
    actions.append(h("button", { type: "button", class: "btn btn-xs", dataset: { action: "open", id: result.tmdbId } }, "In library · open"));
  }
  card.append(
    posterSlot(result.posterPath ? `https://image.tmdb.org/t/p/w342${result.posterPath}` : null, { alt: "" }),
    h("div", { class: "card-meta" },
      h("h3", { class: "card-title", text: result.title }),
      h("span", { class: "micro", text: result.year || "Year n/a" }),
      libMovie ? statusLeds(libMovie) : null,
      actions),
  );
  return card;
}

export function emptyState(title, text, action) {
  return h("div", { class: "empty panel" },
    h("div", { class: "empty-icon", "aria-hidden": "true" }, icon("film")),
    h("h2", { text: title }),
    h("p", { text }),
    action || null);
}

// ---------- CRT TV hero (Stats view) ----------

export function crtTv(stats) {
  const screen = h("div", { class: "tv-screen" },
    h("div", { class: "tv-scan", "aria-hidden": "true" }),
    h("div", { class: "tv-grid" },
      ...stats.map(([label, value, wide]) =>
        h("div", { class: `tv-stat${wide ? " wide" : ""}` },
          h("span", { class: "tv-label", text: label }),
          h("span", { class: "tv-value", text: value })))));
  return h("figure", { class: "tv", "aria-label": "Library stats" },
    h("div", { class: "tv-antenna", "aria-hidden": "true" }, h("span"), h("span")),
    h("div", { class: "tv-body" },
      h("div", { class: "tv-bezel" }, screen),
      h("div", { class: "tv-controls", "aria-hidden": "true" },
        h("span", { class: "micro", text: "CH" }),
        h("span", { class: "knob" }),
        h("span", { class: "knob knob-sm" }),
        h("span", { class: "tv-grille" }, h("span"), h("span"), h("span"), h("span")),
        h("span", { class: "led led-on led-power" }))),
    h("div", { class: "tv-feet", "aria-hidden": "true" }, h("span"), h("span")));
}

// ---------- toasts / confirm ----------

export function toast(message, kind = "info") {
  const box = document.getElementById("toasts");
  while (box.children.length >= 3) box.firstElementChild.remove();
  const t = h("div", { class: `toast toast-${kind}`, text: message });
  box.append(t);
  setTimeout(() => t.classList.add("out"), 3600);
  setTimeout(() => t.remove(), 4000);
}

/**
 * Shows the confirm dialog with custom buttons.
 * buttons: [{ label, value, kind }] → resolves with the clicked value (or null on Esc).
 */
export function choose({ kicker = "Confirm", title, text, buttons }) {
  const dlg = document.getElementById("confirm-dialog");
  document.getElementById("confirm-kicker").textContent = kicker;
  document.getElementById("confirm-title").textContent = title;
  document.getElementById("confirm-text").textContent = text;
  const actions = document.getElementById("confirm-actions");
  actions.replaceChildren(h("span", { class: "spacer" }));
  for (const b of buttons) {
    actions.append(h("button", { type: "submit", value: b.value, class: `btn ${b.kind === "hero" ? "btn-hero" : b.kind === "danger" ? "btn-danger" : "btn-ghost"}`, text: b.label }));
  }
  dlg.returnValue = "";
  dlg.showModal();
  return new Promise((resolve) => {
    dlg.addEventListener("close", () => resolve(dlg.returnValue || null), { once: true });
  });
}
