// Batch add: paste titles → review matches in one list → add them all in one go.
//
// Flow: input step (textarea) → searching → review list (pick match, choose
// Watchlist / Watched / Skip, quick rating) → apply → done step, which can hand the
// watched ones to the app for an optional one-by-one detail pass.

import { searchMoviesOnce } from "./search.js";
import { newId } from "./storage.js";
import { h, icon, posterSlot, ratingInput, toast, kindBadge } from "./ui.js";

const MAX_LINES = 100;
const CONCURRENCY = 4;
const ACTIONS = [["watchlist", "Watchlist"], ["watched", "Watched"], ["skip", "Skip"]];

let app = null;       // { getMovie(id), getLists(), apply(items, { listId, newListName }) → summary, startReview(list) }
let listChoice = "";  // "" (none), a list id, or "__new"
let newListName = "";
let rows = [];
let draft = "";
let uid = 0;

const $ = (sel) => document.querySelector(sel);
const body = () => $("#batch-body");

export function initBatch(hooks) {
  app = hooks;
  $("#batch-dialog").addEventListener("close", () => { rows = []; });
}

export function openBatch() {
  renderInput();
  const dlg = $("#batch-dialog");
  if (!dlg.open) dlg.showModal();
  $("#batch-text")?.focus();
}

// ---------------------------------------------------------------- parsing

/** "Dune 2021", "Dune (2021)" → { title: "Dune", year: "2021" }. Years outside a sane range stay in the title. */
export function parseLine(line) {
  const m = /^(.*?)[\s,]*[([]?\s*((?:18|19|20)\d{2})\s*[)\]]?$/.exec(line);
  const maxYear = new Date().getFullYear() + 3;
  if (m && m[1].trim() && Number(m[2]) >= 1880 && Number(m[2]) <= maxYear) {
    return { title: m[1].trim(), year: m[2] };
  }
  return { title: line, year: null };
}

function parseInput(text) {
  const seen = new Set();
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim().slice(0, 200); // tolerate "1. Title" / "- Title"
    if (!line) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

// ---------------------------------------------------------------- step 1: input

function renderInput() {
  const text = h("textarea", {
    id: "batch-text", rows: 9, maxlength: 8000, spellcheck: "false",
    placeholder: "Avatar\nInterstellar\nInception\nDune 2021",
  });
  text.value = draft;
  const hint = h("p", { class: "hint", id: "batch-hint" });
  const count = () => {
    const n = parseInput(text.value).length;
    hint.textContent = n ? `${n} title${n === 1 ? "" : "s"}${n > MAX_LINES ? ` — only the first ${MAX_LINES} will be searched` : ""}.` : "One title per line. Add a year to pick the right one — e.g. Dune 2021.";
  };
  text.addEventListener("input", () => { draft = text.value; count(); });
  count();

  body().replaceChildren(
    h("span", { class: "micro", text: "Batch add" }),
    h("h2", { id: "batch-title", text: "Add several movies" }),
    h("p", { class: "modal-sub", text: "Paste or type titles, one per line. You'll review every match before anything is saved." }),
    h("label", { class: "field-label", for: "batch-text", text: "Titles" }),
    text,
    hint,
    h("div", { class: "modal-actions" },
      h("span", { class: "spacer" }),
      h("button", { type: "button", class: "btn btn-ghost", text: "Cancel", onclick: () => $("#batch-dialog").close() }),
      h("button", { type: "button", class: "btn btn-hero", onclick: () => startSearch(text.value) }, icon("search"), "Find movies")));
}

// ---------------------------------------------------------------- step 2: search

async function startSearch(text) {
  const lines = parseInput(text).slice(0, MAX_LINES);
  if (!lines.length) { toast("Type at least one title.", "error"); return; }
  rows = lines.map((line) => ({ id: ++uid, line, ...parseLine(line), state: "pending", results: [], pick: 0, action: "watchlist", rating: null, open: false, el: null }));

  const progress = h("p", { class: "batch-progress mono" });
  body().replaceChildren(
    h("span", { class: "micro", text: "Batch add" }),
    h("h2", { id: "batch-title", text: "Tuning in…" }),
    progress);

  let done = 0;
  const tick = () => { progress.textContent = `Searching ${done}/${rows.length}`; };
  tick();
  const queue = [...rows];
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    for (let row = queue.shift(); row; row = queue.shift()) {
      await lookup(row);
      done++; tick();
    }
  }));
  if (!$("#batch-dialog").open) return;
  renderReview();
}

async function lookup(row) {
  row.state = "pending";
  try {
    let results = await searchMoviesOnce(row.title, row.year);
    // A trailing number may be part of the title ("Blade Runner 2049"): retry with the full line.
    if (!results.length && row.year) results = await searchMoviesOnce(row.line);
    row.results = results;
    row.pick = bestMatch(row.title, results);
    row.state = results.length ? "found" : "none";
  } catch (err) {
    row.results = [];
    row.state = "error";
    row.error = err.message;
  }
  const lib = row.state === "found" ? app.getMovie(current(row).id) : null;
  row.action = row.state !== "found" ? "skip" : lib ? "skip" : row.action === "skip" ? "watchlist" : row.action;
}

/** Prefer an exact (case/punctuation-insensitive) title match, else TMDB's top result. */
function bestMatch(title, results) {
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const i = results.findIndex((r) => norm(r.title) === norm(title));
  return i >= 0 ? i : 0;
}

// A row is addable once it has a TMDB match or was turned into a hand-made entry.
const pickable = (row) => row.state === "found" || row.state === "custom";
const current = (row) => (row.state === "custom" ? row.custom : row.results[row.pick]);

function makeCustom(row) {
  row.custom = {
    id: newId("m"), mediaType: "custom", tmdbId: null, title: row.title.slice(0, 300),
    year: row.year || "", posterPath: null, emoji: "🎬",
  };
  row.state = "custom";
  row.action = "watchlist";
}

// ---------------------------------------------------------------- step 2: review

function renderReview() {
  const found = rows.filter(pickable).length;
  const attention = rows.length - found;

  const setAll = h("div", { class: "batch-setall" },
    h("span", { class: "micro", text: "Set all" }),
    ...ACTIONS.map(([value, label]) => h("button", {
      type: "button", class: "btn btn-xs btn-ghost", text: label,
      onclick: () => {
        for (const r of rows) {
          if (!pickable(r)) continue;
          if (value === "watchlist" && app.getMovie(current(r).id)) continue; // already in library: leave as is
          r.action = value;
          redrawRow(r);
        }
        updateFooter();
      },
    })));

  const list = h("ol", { class: "batch-list" }, rows.map(rowEl));

  // Optional: drop everything that gets added into one list as well.
  const lists = app.getLists();
  const nameInput = h("input", { type: "text", maxlength: 80, placeholder: "New list name", value: newListName, "aria-label": "New list name", hidden: listChoice !== "__new" });
  nameInput.addEventListener("input", () => { newListName = nameInput.value; });
  const select = h("select", { "aria-label": "Also add to list" },
    h("option", { value: "", text: "No list" }),
    lists.map((l) => h("option", { value: l.id, text: `${l.emoji ? l.emoji + " " : ""}${l.name}` })),
    h("option", { value: "__new", text: "+ New list…" }));
  if (listChoice && listChoice !== "__new" && !lists.some((l) => l.id === listChoice)) listChoice = "";
  select.value = listChoice;
  select.addEventListener("change", () => { listChoice = select.value; nameInput.hidden = listChoice !== "__new"; if (!nameInput.hidden) nameInput.focus(); });
  const listPick = h("div", { class: "batch-listpick" }, h("span", { class: "micro", text: "Also add to list" }), select, nameInput);
  const footer = h("div", { class: "batch-footer" },
    h("p", { class: "batch-summary", id: "batch-summary" }),
    h("div", { class: "modal-actions" },
      h("button", { type: "button", class: "btn btn-ghost", text: "Back", onclick: renderInput }),
      h("span", { class: "spacer" }),
      h("button", { type: "button", class: "btn btn-hero", id: "batch-apply", onclick: applyRows })));

  body().replaceChildren(
    h("span", { class: "micro", text: "Batch add · review" }),
    h("h2", { id: "batch-title", text: `${found} match${found === 1 ? "" : "es"}` }),
    h("p", { class: "modal-sub", text: attention ? `${attention} line${attention === 1 ? "" : "s"} need${attention === 1 ? "s" : ""} attention — edit and search again, or leave skipped.` : "Check each match, choose where it goes, then add them all." }),
    setAll,
    listPick,
    list,
    footer);
  updateFooter();
}

function rowEl(row) {
  const li = h("li", { class: `batch-row is-${row.state}`, dataset: { action: row.action } });
  row.el = li;

  if (!pickable(row)) {
    const input = h("input", { type: "search", value: row.line, maxlength: 200, "aria-label": `Search again for ${row.line}` });
    const retry = async () => {
      const line = input.value.trim();
      if (!line) return;
      Object.assign(row, { line, ...parseLine(line), action: "watchlist" });
      li.classList.add("is-busy");
      await lookup(row);
      redrawRow(row);
      updateFooter();
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); retry(); } });
    li.append(
      h("div", { class: "batch-thumb" }, posterSlot(null)),
      h("div", { class: "batch-info" },
        h("span", { class: "batch-none", text: row.state === "error" ? `Search failed: ${row.error}` : `No match for “${row.line}”` }),
        h("div", { class: "batch-retry" }, input, h("button", { type: "button", class: "btn btn-xs", text: "Search", onclick: retry })),
        h("button", { type: "button", class: "link batch-change", text: "Not on TMDB? Add it as your own entry", onclick: () => { makeCustom(row); redrawRow(row); updateFooter(); } })));
    return li;
  }

  const m = current(row);
  const owned = app.getMovie(m.id);
  const isCustom = row.state === "custom";
  const seg = h("div", { class: "segmented batch-seg", role: "radiogroup", "aria-label": `Where to add ${m.title}` },
    ACTIONS.map(([value, label]) => h("button", {
      type: "button", role: "radio", class: "seg-btn", "aria-checked": String(row.action === value), text: label,
      onclick: () => { row.action = value; redrawRow(row); updateFooter(); },
    })));

  const emojiInput = isCustom ? h("input", { type: "text", class: "batch-emoji", value: m.emoji || "", maxlength: 8, "aria-label": `Emoji poster for ${m.title}`, title: "Emoji poster" }) : null;
  emojiInput?.addEventListener("change", () => { row.custom.emoji = emojiInput.value.trim() || null; redrawRow(row); });

  const info = h("div", { class: "batch-info" },
    h("h3", { class: "batch-title", text: m.title }),
    h("span", { class: "micro", text: [isCustom ? "Your own entry" : m.mediaType === "tv" ? "TV" : null, m.year || (isCustom ? null : "Year n/a"), owned ? "In library" : null].filter(Boolean).join(" · ") }),
    !isCustom && row.title.toLowerCase() !== m.title.toLowerCase() ? h("span", { class: "batch-from", text: `from “${row.line}”` }) : null,
    isCustom ? h("label", { class: "batch-emoji-row" }, h("span", { class: "micro", text: "Emoji" }), emojiInput) : null,
    isCustom
      ? h("button", { type: "button", class: "link batch-change", text: "Undo — search again instead", onclick: () => { row.state = "none"; row.action = "skip"; redrawRow(row); updateFooter(); } })
      : row.results.length > 1
      ? h("button", { type: "button", class: "link batch-change", "aria-expanded": String(row.open), text: row.open ? "Hide other matches" : `Not this one? ${row.results.length - 1} other match${row.results.length === 2 ? "" : "es"}`, onclick: () => { row.open = !row.open; redrawRow(row); } })
      : null);

  li.append(
    h("div", { class: "batch-thumb" }, posterSlot(m.posterPath ? `https://image.tmdb.org/t/p/w92${m.posterPath}` : null, { emoji: m.emoji }), kindBadge(m.mediaType) || ""),
    info,
    h("div", { class: "batch-controls" },
      seg,
      row.action === "watched"
        ? h("div", { class: "batch-rating" }, h("span", { class: "micro", text: "Rating" }), ratingInput(`batch-${row.id}`, row.rating, (v) => { row.rating = v; }).el)
        : null,
      owned && row.action === "watched" ? h("span", { class: "hint", text: "Adds another watch to the one in your library." }) : null));

  if (row.open) {
    li.append(h("ul", { class: "batch-alts" }, row.results.map((r, i) => i === row.pick ? null : h("li", {},
      h("button", {
        type: "button", class: "batch-alt",
        onclick: () => { row.pick = i; row.open = false; if (app.getMovie(r.id) && row.action === "watchlist") row.action = "skip"; redrawRow(row); updateFooter(); },
      },
        h("span", { class: "batch-alt-thumb" }, posterSlot(r.posterPath ? `https://image.tmdb.org/t/p/w92${r.posterPath}` : null)),
        h("span", { class: "batch-alt-title", text: r.title }),
        h("span", { class: "micro", text: r.year || "—" }))))));
  }
  return li;
}

function redrawRow(row) {
  if (row.el?.isConnected) row.el.replaceWith(rowEl(row));
}

function chosen() {
  // Two lines can resolve to the same film; keep the first choice.
  const seen = new Set();
  return rows.filter((r) => {
    if (!pickable(r) || r.action === "skip") return false;
    const id = current(r).id;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function updateFooter() {
  const list = chosen();
  const wl = list.filter((r) => r.action === "watchlist").length;
  const wd = list.length - wl;
  const skipped = rows.length - list.length;
  const summary = $("#batch-summary");
  if (summary) summary.textContent = `${wl} to watchlist · ${wd} watched · ${skipped} skipped`;
  const btn = $("#batch-apply");
  if (btn) {
    btn.replaceChildren(icon("plus"), list.length ? `Add ${list.length} movie${list.length === 1 ? "" : "s"}` : "Nothing to add");
    btn.disabled = !list.length;
  }
}

// ---------------------------------------------------------------- step 3: apply + done

async function applyRows() {
  const list = chosen();
  if (!list.length) return;
  const btn = $("#batch-apply");
  btn.disabled = true;
  btn.textContent = "Adding…";
  const items = list.map((r) => ({ ...current(r), action: r.action, rating: r.action === "watched" ? r.rating : null }));
  const target = listChoice === "__new" ? { newListName: newListName.trim() } : listChoice ? { listId: listChoice } : {};
  const result = await app.apply(items, target);
  listChoice = ""; newListName = "";
  renderDone(result);
}

function renderDone({ added, updated, failed, review, listName }) {
  draft = "";
  const parts = [`${added} added`];
  if (updated) parts.push(`${updated} updated`);
  if (failed) parts.push(`${failed} failed`);
  if (listName) parts.push(`all in “${listName}”`);
  body().replaceChildren(
    h("span", { class: "micro", text: "Batch add · done" }),
    h("h2", { id: "batch-title", text: "Library updated" }),
    h("p", { class: "modal-sub", text: `${parts.join(" · ")}.` }),
    review.length
      ? h("p", { class: "muted", text: `${review.length} watched movie${review.length === 1 ? " was" : "s were"} logged without a date or notes. You can add details now, one by one — or later from each movie.` })
      : null,
    h("div", { class: "modal-actions" },
      h("span", { class: "spacer" }),
      h("button", { type: "button", class: review.length ? "btn btn-ghost" : "btn btn-hero", text: "Done", onclick: () => $("#batch-dialog").close() }),
      review.length
        ? h("button", { type: "button", class: "btn btn-hero", onclick: () => { $("#batch-dialog").close(); app.startReview(review); } }, icon("eye"), "Review watched one by one")
        : null));
}
