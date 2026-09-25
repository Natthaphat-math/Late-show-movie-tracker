// "Taste profile" on the Stats page: genres, rating by genre, decades, monthly activity.
//
// Every chart here is a single series, so all bars use one colour (the theme's hero) and
// identity is carried by the text label beside each bar, never by colour. Values are
// printed next to every bar and repeated in a hover title, so the chart doubles as a table.

import { h } from "./ui.js";

// TMDB's movie genre ids are fixed; hard-coding them saves a request per page load.
export const GENRES = {
  28: "Action", 12: "Adventure", 16: "Animation", 35: "Comedy", 80: "Crime",
  99: "Documentary", 18: "Drama", 10751: "Family", 14: "Fantasy", 36: "History",
  27: "Horror", 10402: "Music", 9648: "Mystery", 10749: "Romance", 878: "Science Fiction",
  10770: "TV Movie", 53: "Thriller", 10752: "War", 37: "Western",
};
export const genreName = (id) => GENRES[id] || "Other";

const SEGMENTS = 20;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * movies: all library movies. opts.onGenre(id) is called when a genre bar is tapped.
 * opts.pending: movies still waiting for genre data. opts.blocked: rules reject meta fields.
 */
export function tasteProfile(movies, { onGenre, pending = 0, blocked = false } = {}) {
  const watched = movies.filter((m) => m.watchLog.length > 0);
  const withMeta = watched.filter((m) => Array.isArray(m.genres));

  const panels = [
    genrePanel(withMeta, onGenre),
    ratingPanel(withMeta),
    decadePanel(watched),
    activityPanel(watched),
  ];

  const notes = [];
  if (blocked) notes.push(h("p", { class: "banner", text: "Genres can't be saved to the cloud yet — deploy the updated Firestore rules (see DEPLOY.md). Stats below use what this device has fetched." }));
  else if (pending) notes.push(h("p", { class: "muted taste-pending", text: `Fetching genres for ${pending} movie${pending === 1 ? "" : "s"}…` }));

  return h("section", { class: "taste", "aria-labelledby": "taste-title" },
    h("div", { class: "taste-head" },
      h("span", { class: "micro", text: "Taste profile" }),
      h("h2", { id: "taste-title", text: "What you watch" })),
    ...notes,
    h("div", { class: "taste-grid" }, panels));
}

// ---------------------------------------------------------------- panels

function genrePanel(movies, onGenre) {
  const counts = new Map();
  for (const m of movies) for (const g of m.genres) counts.set(g, (counts.get(g) || 0) + 1);
  const rows = [...counts].sort((a, b) => b[1] - a[1] || genreName(a[0]).localeCompare(genreName(b[0]))).slice(0, 10);
  const max = rows[0]?.[1] || 0;
  return panel("Genres", "Films watched per genre · a film can have several",
    rows.length
      ? h("ol", { class: "bars" }, rows.map(([id, n]) =>
          h("li", {},
            h("button", {
              type: "button", class: "bar-row bar-row-btn",
              title: `${genreName(id)}: ${n} film${n === 1 ? "" : "s"} — tap to see them`,
              onclick: () => onGenre?.(id),
            },
              h("span", { class: "bar-label", text: genreName(id) }),
              segBar(n, max),
              h("span", { class: "bar-value mono", text: String(n) })))))
      : empty("Log a few watches to see your genres."));
}

function ratingPanel(movies) {
  const sums = new Map();
  for (const m of movies) {
    const rated = m.watchLog.filter((e) => e.rating);
    if (!rated.length) continue;
    for (const g of m.genres) {
      const s = sums.get(g) || { total: 0, n: 0 };
      for (const e of rated) { s.total += e.rating; s.n++; }
      sums.set(g, s);
    }
  }
  // Genres with a single rating say little; require two.
  const rows = [...sums].filter(([, s]) => s.n >= 2)
    .map(([id, s]) => [id, s.total / s.n, s.n])
    .sort((a, b) => b[1] - a[1]).slice(0, 8);
  return panel("Ratings by genre", "Average of your 1–10 ratings · genres with 2+ ratings",
    rows.length
      ? h("ol", { class: "bars" }, rows.map(([id, avg, n]) =>
          h("li", { class: "bar-row", title: `${genreName(id)}: average ${avg.toFixed(1)} from ${n} rating${n === 1 ? "" : "s"}` },
            h("span", { class: "bar-label", text: genreName(id) }),
            ratingBar(avg),
            h("span", { class: "bar-value mono", text: avg.toFixed(1) }))))
      : empty("Rate a few watches to compare genres."));
}

function decadePanel(movies) {
  const counts = new Map();
  for (const m of movies) {
    if (!m.releaseYear) continue;
    const d = Math.floor(m.releaseYear / 10) * 10;
    counts.set(d, (counts.get(d) || 0) + 1);
  }
  const rows = [...counts].sort((a, b) => a[0] - b[0]);
  const max = Math.max(0, ...rows.map((r) => r[1]));
  return panel("Decades", "Films watched by release decade",
    rows.length
      ? h("ol", { class: "bars" }, rows.map(([d, n]) =>
          h("li", { class: "bar-row", title: `${d}s: ${n} film${n === 1 ? "" : "s"}` },
            h("span", { class: "bar-label mono", text: `${d}s` }),
            segBar(n, max),
            h("span", { class: "bar-value mono", text: String(n) }))))
      : empty("Release years appear once genres are fetched."));
}

function activityPanel(movies) {
  // Last 12 calendar months, oldest → newest. Undated watches can't be placed.
  const now = new Date();
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({ key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`, label: MONTHS[d.getMonth()], year: d.getFullYear(), n: 0 });
  }
  const idx = new Map(months.map((m, i) => [m.key, i]));
  let undated = 0;
  for (const m of movies) for (const e of m.watchLog) {
    if (!e.date) { undated++; continue; }
    const i = idx.get(e.date.slice(0, 7));
    if (i !== undefined) months[i].n++;
  }
  const max = Math.max(0, ...months.map((m) => m.n));
  const total = months.reduce((s, m) => s + m.n, 0);
  const cols = h("ol", { class: "columns", "aria-label": "Watches per month, last 12 months" },
    months.map((m) => h("li", { class: "col", title: `${m.label} ${m.year}: ${m.n} watch${m.n === 1 ? "" : "es"}` },
      h("span", { class: "col-value mono", text: m.n ? String(m.n) : "" }),
      colBar(m.n, max),
      h("span", { class: "col-label mono", text: m.label.slice(0, 1) }))));
  return panel("Activity", `Watches per month · ${total} in the last 12 months${undated ? ` · ${undated} undated not shown` : ""}`,
    total ? cols : empty("Watches with a date will show up here."));
}

// ---------------------------------------------------------------- marks

function panel(title, sub, body) {
  return h("section", { class: "panel taste-panel" },
    h("span", { class: "micro panel-label", text: title }),
    h("p", { class: "taste-sub", text: sub }),
    body);
}

function empty(text) {
  return h("p", { class: "muted", text });
}

/** Horizontal LED-style bar: SEGMENTS cells, lit in proportion to value/max (at least one when > 0). */
function segBar(value, max) {
  const lit = value > 0 && max > 0 ? Math.max(1, Math.round((value / max) * SEGMENTS)) : 0;
  const bar = h("span", { class: "seg-bar", "aria-hidden": "true" });
  for (let i = 0; i < SEGMENTS; i++) bar.append(h("span", { class: i < lit ? "on" : "" }));
  return bar;
}

/** Ten segments = the 1–10 rating scale itself; the last one lights partially via a class. */
function ratingBar(avg) {
  const bar = h("span", { class: "seg-bar seg-bar-10", "aria-hidden": "true" });
  const full = Math.floor(avg);
  const frac = avg - full;
  for (let i = 0; i < 10; i++) {
    bar.append(h("span", { class: i < full ? "on" : i === full && frac >= 0.5 ? "on half" : "" }));
  }
  return bar;
}

/** Vertical column of 8 cells for the monthly activity strip. */
function colBar(value, max) {
  const cells = 8;
  const lit = value > 0 && max > 0 ? Math.max(1, Math.round((value / max) * cells)) : 0;
  const bar = h("span", { class: "col-bar", "aria-hidden": "true" });
  for (let i = cells - 1; i >= 0; i--) bar.append(h("span", { class: i < lit ? "on" : "" }));
  return bar;
}
