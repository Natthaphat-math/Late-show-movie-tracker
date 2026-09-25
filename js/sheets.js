// Small form dialogs rendered into #sheet-dialog: new/edit list, pick lists for a title,
// and "add it yourself" entries. Each returns a Promise that resolves with the result
// (or null when cancelled), so app.js stays in charge of saving.

import { h, icon, posterSlot } from "./ui.js";
import { cleanEmoji } from "./storage.js";

export const EMOJI_PICKS = ["🎬", "🍿", "📺", "🕵️", "👻", "🚀", "💔", "😂", "🤠", "🎄", "🧸", "🐉", "⚔️", "🎵", "🌊", "🔥"];

const $ = (sel) => document.querySelector(sel);

function open(content, { onClose } = {}) {
  const dlg = $("#sheet-dialog");
  $("#sheet-body").replaceChildren(...content);
  dlg.returnValue = "";
  if (!dlg.open) dlg.showModal();
  if (onClose) dlg.addEventListener("close", onClose, { once: true });
  dlg.querySelector("input:not([type=checkbox]), textarea")?.focus();
  return dlg;
}

function close() {
  const dlg = $("#sheet-dialog");
  if (dlg.open) dlg.close();
}

/** Emoji field with a row of quick picks. Returns { el, get value() }. */
function emojiField(id, initial) {
  const input = h("input", { type: "text", id, value: initial || "", maxlength: 16, class: "emoji-input", placeholder: "🎬", "aria-label": "Emoji" });
  const picks = h("div", { class: "emoji-picks", role: "group", "aria-label": "Quick emoji" },
    EMOJI_PICKS.map((e) => h("button", { type: "button", class: "emoji-pick", text: e, "aria-label": e, onclick: () => { input.value = e; input.dispatchEvent(new Event("input")); } })));
  return { el: h("div", { class: "emoji-field" }, input, picks), input, get value() { return cleanEmoji(input.value); } };
}

// ---------------------------------------------------------------- list form

/** New or edit list. Resolves { name, emoji, description, ranked } or null. */
export function listForm(list = null) {
  return new Promise((resolve) => {
    let result = null;
    const name = h("input", { type: "text", id: "lf-name", maxlength: 80, required: true, value: list?.name || "", placeholder: "e.g. Christmas movies" });
    const emoji = emojiField("lf-emoji", list?.emoji || "📼");
    const desc = h("textarea", { id: "lf-desc", rows: 2, maxlength: 300, placeholder: "Optional" });
    desc.value = list?.description || "";
    const ranked = h("input", { type: "checkbox", id: "lf-ranked", checked: list?.ranked || false });
    const form = h("form", { class: "sheet-form", onsubmit: (e) => {
      e.preventDefault();
      if (!name.value.trim()) { name.focus(); return; }
      result = { name: name.value.trim(), emoji: emoji.value, description: desc.value.trim(), ranked: ranked.checked };
      close();
    } },
      h("span", { class: "micro", text: list ? "Edit list" : "New list" }),
      h("h2", { text: list ? list.name : "New list" }),
      h("label", { class: "field-label", for: "lf-name", text: "Name" }), name,
      h("label", { class: "field-label", for: "lf-emoji", text: "Emoji" }), emoji.el,
      h("label", { class: "field-label", for: "lf-desc", text: "Description" }), desc,
      h("label", { class: "check-row", for: "lf-ranked" }, ranked,
        h("span", {}, h("strong", { text: "Ranked list" }), h("span", { class: "hint", text: " — numbered, reorder with ▲▼" }))),
      h("div", { class: "modal-actions" },
        h("span", { class: "spacer" }),
        h("button", { type: "button", class: "btn btn-ghost", text: "Cancel", onclick: close }),
        h("button", { type: "submit", class: "btn btn-hero", text: list ? "Save" : "Create list" })));
    open([form], { onClose: () => resolve(result) });
  });
}

// ---------------------------------------------------------------- list picker

/**
 * Tick which lists a title belongs to. Resolves { selected: Set<listId>, newList: {name, emoji}|null } or null.
 */
export function listPicker(title, lists, memberOf) {
  return new Promise((resolve) => {
    let result = null;
    const boxes = lists.map((l) => {
      const cb = h("input", { type: "checkbox", value: l.id, checked: memberOf.has(l.id) });
      return { l, cb, row: h("label", { class: "check-row pick-row" }, cb, h("span", { class: "pick-emoji", text: l.emoji || "📼" }), h("span", { class: "pick-name", text: l.name }), h("span", { class: "micro", text: String(l.items.length) })) };
    });
    const newName = h("input", { type: "text", maxlength: 80, placeholder: "New list name…", "aria-label": "New list name" });
    const form = h("form", { class: "sheet-form", onsubmit: (e) => {
      e.preventDefault();
      result = {
        selected: new Set(boxes.filter((b) => b.cb.checked).map((b) => b.l.id)),
        newList: newName.value.trim() ? { name: newName.value.trim(), emoji: "📼" } : null,
      };
      close();
    } },
      h("span", { class: "micro", text: "Add to list" }),
      h("h2", { text: title }),
      boxes.length ? h("div", { class: "pick-list" }, boxes.map((b) => b.row)) : h("p", { class: "muted", text: "No lists yet — name one below." }),
      h("label", { class: "field-label", text: "Or start a new list" }), newName,
      h("div", { class: "modal-actions" },
        h("span", { class: "spacer" }),
        h("button", { type: "button", class: "btn btn-ghost", text: "Cancel", onclick: close }),
        h("button", { type: "submit", class: "btn btn-hero", text: "Done" })));
    open([form], { onClose: () => resolve(result) });
  });
}

// ---------------------------------------------------------------- add it yourself

/**
 * For titles TMDB doesn't have. Resolves { title, year, emoji, action: "watchlist"|"watched"|"save" } or null.
 */
export function customForm(prefillTitle = "") {
  return new Promise((resolve) => {
    let result = null;
    const title = h("input", { type: "text", id: "cf-title", maxlength: 300, required: true, value: prefillTitle, placeholder: "Title" });
    const year = h("input", { type: "text", id: "cf-year", inputmode: "numeric", maxlength: 4, placeholder: "e.g. 2019", pattern: "[0-9]{4}" });
    const previewWrap = h("div", { class: "cf-preview-wrap" }, posterSlot(null, { emoji: "🎬", cls: "cf-preview" }));
    const emoji = emojiField("cf-emoji", "🎬");
    emoji.input.addEventListener("input", () => {
      previewWrap.replaceChildren(posterSlot(null, { emoji: emoji.value || "🎬", cls: "cf-preview" }));
    });
    let action = "watchlist";
    const form = h("form", { class: "sheet-form", onsubmit: (e) => {
      e.preventDefault();
      const t = title.value.trim();
      if (!t) { title.focus(); return; }
      const y = /^\d{4}$/.test(year.value.trim()) ? Number(year.value.trim()) : null;
      result = { title: t, year: y, emoji: emoji.value || "🎬", action };
      close();
    } },
      h("span", { class: "micro", text: "Add it yourself" }),
      h("h2", { text: "Not on TMDB?" }),
      h("p", { class: "modal-sub", text: "Add any title by hand. Pick an emoji as its poster — you can paste a poster link later from its page." }),
      h("div", { class: "cf-grid" },
        previewWrap,
        h("div", { class: "cf-fields" },
          h("label", { class: "field-label", for: "cf-title", text: "Title" }), title,
          h("label", { class: "field-label", for: "cf-year", text: "Year" }), year)),
      h("label", { class: "field-label", for: "cf-emoji", text: "Emoji poster" }), emoji.el,
      h("div", { class: "modal-actions cf-actions" },
        h("button", { type: "button", class: "btn btn-ghost", text: "Cancel", onclick: close }),
        h("button", { type: "submit", class: "btn", onclick: () => { action = "watched"; } }, icon("eye"), "Watched"),
        h("button", { type: "submit", class: "btn btn-hero", onclick: () => { action = "watchlist"; } }, icon("plus"), "Watchlist")));
    open([form], { onClose: () => resolve(result) });
  });
}
