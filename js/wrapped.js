// Year in review: a story of slides built from one year's dated watches. No DOM outside the
// #wrapped-dialog, no storage, no network (posters come from the library's own URLs).
//
// What counts: every dated history entry in that year — film watches, rewatches, own entries
// and finished TV seasons. Undated entries can't be placed in a year, so they're left out
// (the first slide says how many).

import { posterUrl } from "./storage.js";
import { h, icon, posterSlot, miniMeter, toast } from "./ui.js";
import { genreName } from "./stats.js";

const MONTHS = Array.from({ length: 12 }, (_, i) => new Date(2000, i, 15).toLocaleDateString(undefined, { month: "short" }));
const monthLong = (i) => new Date(2000, i, 15).toLocaleDateString(undefined, { month: "long" });
const weekdayLong = (i) => new Date(2023, 0, 1 + i).toLocaleDateString(undefined, { weekday: "long" }); // 2023-01-01 was a Sunday
const niceDate = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "long" });
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/** Years that have at least one dated watch, newest first. */
export function reviewYears(movies) {
  const ys = new Set();
  for (const m of movies.values()) for (const e of m.watchLog) if (e.date) ys.add(Number(e.date.slice(0, 4)));
  return [...ys].sort((a, b) => b - a);
}

/** The year to show by default: last year in January and February (if it has data), else this year. */
export function defaultReviewYear(movies, today = new Date()) {
  const years = reviewYears(movies);
  const y = today.getFullYear();
  if (today.getMonth() < 2 && years.includes(y - 1)) return y - 1;
  return years.includes(y) ? y : years[0] ?? y;
}

const SEASON_RE = /^Season (\d+)/;

/** Everything the slides need for one year. */
export function yearInReview(movies, year) {
  const ys = String(year);
  const entries = [];
  let undated = 0;
  for (const m of movies.values()) {
    m.watchLog.forEach((e, i) => {
      if (!e.date) { undated++; return; }
      if (e.date.startsWith(ys)) entries.push({ ...e, movie: m, idx: i });
    });
  }
  entries.sort((a, b) => a.date.localeCompare(b.date));

  const titles = new Map(); // id → { movie, n, best, last }
  for (const e of entries) {
    const t = titles.get(e.movie.id) || { movie: e.movie, n: 0, best: null, last: null };
    t.n++;
    if (e.rating && (!t.best || e.rating >= t.best)) t.best = e.rating;
    t.last = e.date;
    titles.set(e.movie.id, t);
  }

  // "New to you": no dated watch before this year.
  let fresh = 0;
  for (const t of titles.values()) {
    const earlier = t.movie.watchLog.some((e) => e.date && e.date < `${ys}-01-01`);
    if (!earlier) fresh++;
  }

  const months = Array(12).fill(0);
  const weekdays = Array(7).fill(0);
  const days = new Map();
  for (const e of entries) {
    months[Number(e.date.slice(5, 7)) - 1]++;
    weekdays[new Date(`${e.date}T12:00:00`).getDay()]++;
    days.set(e.date, (days.get(e.date) || 0) + 1);
  }
  const busiestMonth = entries.length ? months.indexOf(Math.max(...months)) : null;
  const busiestWeekday = entries.length ? weekdays.indexOf(Math.max(...weekdays)) : null;
  const marathon = [...days].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];

  // Runtime: a film watch is its runtime; a finished season is its episodes × episode length.
  let minutes = 0;
  let seasons = 0;
  for (const e of entries) {
    const m = e.movie;
    if (m.mediaType === "tv") {
      const s = SEASON_RE.exec(e.notes || "");
      if (!s) continue;
      seasons++;
      if (m.runtime) minutes += m.runtime * ((m.seasons || []).find((x) => x.n === Number(s[1]))?.c || 0);
    } else if (m.runtime) {
      minutes += m.runtime;
    }
  }

  const rated = entries.filter((e) => e.rating);
  const avg = rated.length ? rated.reduce((s, e) => s + e.rating, 0) / rated.length : null;

  const top = [...titles.values()].filter((t) => t.best)
    .sort((a, b) => b.best - a.best || b.n - a.n || b.last.localeCompare(a.last)).slice(0, 5);
  const rewatched = [...titles.values()].filter((t) => t.n > 1 && t.movie.mediaType !== "tv")
    .sort((a, b) => b.n - a.n || (b.best || 0) - (a.best || 0))[0] || null;

  const genres = new Map();
  for (const e of entries) for (const g of e.movie.genres || []) genres.set(g, (genres.get(g) || 0) + 1);
  const topGenres = [...genres].sort((a, b) => b[1] - a[1] || genreName(a[0]).localeCompare(genreName(b[0]))).slice(0, 5);

  const decades = new Map();
  for (const t of titles.values()) {
    const y = t.movie.releaseYear;
    if (y) decades.set(Math.floor(y / 10) * 10, (decades.get(Math.floor(y / 10) * 10) || 0) + 1);
  }
  const topDecade = [...decades].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0] || null;
  const shows = [...titles.values()].filter((t) => t.movie.mediaType === "tv");

  const prevCount = [...movies.values()].reduce((s, m) => s + m.watchLog.filter((e) => e.date?.startsWith(String(year - 1))).length, 0);

  return {
    year, entries, undated, count: entries.length, titles: titles.size, fresh, rewatches: entries.length - fresh,
    hours: minutes / 60, seasons, shows, avg, top, rewatched, months, busiestMonth, weekdays, busiestWeekday,
    marathon: marathon && marathon[1] > 1 ? { date: marathon[0], n: marathon[1], titles: entries.filter((e) => e.date === marathon[0]).map((e) => e.movie.title) } : null,
    first: entries[0] || null, last: entries[entries.length - 1] || null,
    topGenres, topDecade, prevCount,
    posters: [...titles.values()].sort((a, b) => (b.best || 0) - (a.best || 0) || b.n - a.n).slice(0, 10).map((t) => t.movie),
  };
}

// ---------------------------------------------------------------- story

/**
 * Opens the story. years: every year with data, for the picker on the last slide.
 * onOpenTitle(id) opens a title's drawer (closing the story).
 */
export function openYearReview(movies, year, { years = [], onOpenTitle = null } = {}) {
  const dlg = document.getElementById("wrapped-dialog");
  const data = yearInReview(movies, year);
  const slides = buildSlides(data, { years, movies, onOpenTitle, reopen: (y) => openYearReview(movies, y, { years, onOpenTitle }) });
  let at = 0;

  const bars = h("div", { class: "wr-progress", "aria-hidden": "true" }, slides.map(() => h("span", {}, h("i"))));
  const stage = h("div", { class: "wr-stage", "aria-live": "polite" });
  const prevBtn = h("button", { type: "button", class: "icon-btn wr-nav", "aria-label": "Previous" }, icon("chev-up", "wr-left"));
  const nextBtn = h("button", { type: "button", class: "icon-btn wr-nav", "aria-label": "Next" }, icon("chev-up", "wr-right"));
  const close = h("button", { type: "button", class: "icon-btn wr-close", "aria-label": "Close year in review", onclick: () => dlg.close() }, icon("x"));

  const show = (i) => {
    at = Math.max(0, Math.min(slides.length - 1, i));
    const s = slides[at];
    dlg.dataset.tone = s.tone;
    stage.replaceChildren(h("div", { class: "wr-slide" }, s.body));
    [...bars.children].forEach((b, j) => b.classList.toggle("done", j <= at));
    prevBtn.disabled = at === 0;
    nextBtn.disabled = at === slides.length - 1;
  };
  // Tap anywhere on the slide: left third goes back, the rest goes forward.
  stage.addEventListener("click", (e) => {
    if (e.target.closest("button, select, a")) return;
    const r = stage.getBoundingClientRect();
    show(at + (e.clientX - r.left < r.width / 3 ? -1 : 1));
  });
  prevBtn.addEventListener("click", () => show(at - 1));
  nextBtn.addEventListener("click", () => show(at + 1));

  dlg.onkeydown = (e) => {
    if (e.key === "ArrowRight") { e.preventDefault(); show(at + 1); }
    if (e.key === "ArrowLeft") { e.preventDefault(); show(at - 1); }
  };
  // Swipe left/right.
  let x0 = null;
  dlg.ontouchstart = (e) => { x0 = e.touches[0].clientX; };
  dlg.ontouchend = (e) => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0;
    x0 = null;
    if (Math.abs(dx) > 50) show(at + (dx < 0 ? 1 : -1));
  };

  dlg.replaceChildren(h("div", { class: "wr-frame" },
    h("div", { class: "wr-top" }, bars, close),
    stage,
    h("div", { class: "wr-bottom" }, prevBtn, nextBtn)));
  show(0);
  if (!dlg.open) dlg.showModal();
  close.focus();
}

function buildSlides(d, { years, onOpenTitle, reopen }) {
  const big = (text, cls = "") => h("div", { class: `wr-big ${cls}`.trim(), text });
  const kicker = (text) => h("p", { class: "wr-kicker micro", text });
  const line = (text) => h("p", { class: "wr-line", text });
  const out = [];

  if (!d.count) {
    out.push({ tone: "hero", body: [
      kicker(`Year in review · ${d.year}`),
      big(String(d.year), "wr-year"),
      line("No dated watches this year yet."),
      d.undated ? h("p", { class: "wr-small", text: `${plural(d.undated, "watch", "watches")} in your history ${d.undated === 1 ? "has" : "have"} no date, so ${d.undated === 1 ? "it isn't" : "they aren't"} counted. Add dates in a title's history to include them.` }) : null,
      yearPicker(d.year, years, reopen),
    ] });
    return out;
  }

  // 1 — title card
  const vsLast = !d.prevCount ? null
    : d.count === d.prevCount ? `same as ${d.year - 1}`
    : `${d.count > d.prevCount ? "up" : "down"} from ${d.prevCount} in ${d.year - 1}`;
  out.push({ tone: "hero", body: [
    kicker("Late Show presents"),
    big(String(d.year), "wr-year"),
    h("p", { class: "wr-line wr-lead", text: "Your year in review" }),
    h("p", { class: "wr-small", text: `${plural(d.count, "watch", "watches")} · ${plural(d.titles, "title")}${vsLast ? ` · ${vsLast}` : ""}` }),
    d.undated ? h("p", { class: "wr-small wr-dim", text: `${d.undated} undated ${d.undated === 1 ? "watch isn't" : "watches aren't"} counted.` }) : null,
    h("p", { class: "wr-hint micro", text: "Tap or swipe to continue" }),
  ] });

  // 2 — totals
  out.push({ tone: "surface", body: [
    kicker("On the screen"),
    h("div", { class: "wr-stats" },
      stat(d.count, d.count === 1 ? "watch" : "watches"),
      stat(d.titles, d.titles === 1 ? "title" : "titles"),
      stat(d.hours >= 1 ? `${Math.round(d.hours)}` : "—", "hours", d.hours >= 1 ? null : "Runtimes still loading"),
      stat(d.fresh, "new to you"),
      stat(Math.max(0, d.rewatches), d.rewatches === 1 ? "rewatch" : "rewatches"),
      stat(d.avg ? d.avg.toFixed(1) : "—", "avg rating")),
    d.hours >= 24 ? line(`That's ${(d.hours / 24).toFixed(1)} days of screen time.`) : null,
  ] });

  // 3 — months
  const max = Math.max(...d.months, 1);
  out.push({ tone: "accent", body: [
    kicker("Your busiest month"),
    big(monthLong(d.busiestMonth)),
    line(`${plural(d.months[d.busiestMonth], "watch", "watches")}.`),
    h("div", { class: "wr-months", role: "img", "aria-label": d.months.map((n, i) => `${MONTHS[i]} ${n}`).join(", ") },
      d.months.map((n, i) => h("div", { class: `wr-month${i === d.busiestMonth ? " on" : ""}` },
        vbar("wr-bar", n / max),
        h("span", { class: "wr-mlabel mono", text: MONTHS[i].slice(0, 1) })))),
  ] });

  // 4 — top rated
  if (d.top.length) {
    const [first, ...rest] = d.top;
    out.push({ tone: "surface", body: [
      kicker("Your top rated"),
      h("button", { type: "button", class: "wr-top1", onclick: () => onOpenTitle?.(first.movie.id) },
        posterSlot(posterUrl(first.movie, "w342"), { emoji: first.movie.emoji, lazy: false }),
        h("span", { class: "wr-top1-text" },
          h("span", { class: "wr-rank mono", text: "#1" }),
          h("span", { class: "wr-title", text: first.movie.title }),
          h("span", { class: "wr-score mono", text: `${first.best}/10` }))),
      rest.length ? h("ol", { class: "wr-toplist", start: 2 }, rest.map((t) => h("li", {},
        h("button", { type: "button", class: "wr-toprow", onclick: () => onOpenTitle?.(t.movie.id) },
          h("span", { class: "wr-title", text: t.movie.title }), miniMeter(t.best))))) : null,
    ] });
  }

  // 5 — taste
  if (d.topGenres.length || d.topDecade) {
    const gmax = d.topGenres[0]?.[1] || 1;
    out.push({ tone: "second", body: [
      kicker("You were into"),
      d.topGenres.length ? big(genreName(d.topGenres[0][0]), "wr-genre") : null,
      d.topGenres.length > 1 ? h("ul", { class: "wr-genres" }, d.topGenres.map(([g, n]) => h("li", {},
        h("span", { class: "wr-gname", text: genreName(g) }),
        vbar("wr-gbar", n / gmax),
        h("span", { class: "mono", text: String(n) })))) : null,
      d.topDecade ? line(`Favourite era: the ${d.topDecade[0]}s (${plural(d.topDecade[1], "title")}).`) : null,
    ] });
  }

  // 6 — habits
  out.push({ tone: "hero", body: [
    kicker("Your habits"),
    big(`${weekdayLong(d.busiestWeekday)}s`),
    line("were your movie night."),
    d.marathon ? h("p", { class: "wr-small", text: `Marathon day: ${niceDate(d.marathon.date)} — ${plural(d.marathon.n, "watch", "watches")} (${d.marathon.titles.slice(0, 3).join(", ")}${d.marathon.titles.length > 3 ? "…" : ""}).` }) : null,
    h("p", { class: "wr-small", text: `First of the year: ${d.first.movie.title} on ${niceDate(d.first.date)}.` }),
    d.last !== d.first ? h("p", { class: "wr-small", text: `Latest: ${d.last.movie.title} on ${niceDate(d.last.date)}.` }) : null,
  ] });

  // 7 — TV and rewatches
  if (d.shows.length || d.rewatched) {
    out.push({ tone: "surface", body: [
      d.shows.length ? kicker("On TV") : null,
      d.shows.length ? big(plural(d.seasons || d.shows.length, d.seasons ? "season" : "show")) : null,
      d.shows.length ? line(`finished across ${plural(d.shows.length, "show")}: ${d.shows.slice(0, 3).map((t) => t.movie.title).join(", ")}${d.shows.length > 3 ? "…" : ""}.`) : null,
      d.rewatched ? kicker("Couldn't stop watching") : null,
      d.rewatched ? h("button", { type: "button", class: "wr-top1 wr-rewatch", onclick: () => onOpenTitle?.(d.rewatched.movie.id) },
        posterSlot(posterUrl(d.rewatched.movie, "w342"), { emoji: d.rewatched.movie.emoji, lazy: false }),
        h("span", { class: "wr-top1-text" },
          h("span", { class: "wr-title", text: d.rewatched.movie.title }),
          h("span", { class: "wr-score mono", text: `×${d.rewatched.n} this year` }))) : null,
    ] });
  }

  // 8 — summary card (screenshot-friendly) + share
  out.push({ tone: "summary", body: [
    h("div", { class: "wr-card" },
      h("div", { class: "wr-card-head" },
        h("span", { class: "micro", text: "Late Show · year in review" }),
        h("span", { class: "wr-card-year", text: String(d.year) })),
      h("div", { class: "wr-collage" }, d.posters.map((m) => posterSlot(posterUrl(m, "w185"), { emoji: m.emoji, lazy: false }))),
      h("dl", { class: "wr-card-stats" },
        pair("Watches", d.count), pair("Titles", d.titles), pair("Hours", d.hours >= 1 ? Math.round(d.hours) : "—"),
        pair("Top rated", d.top[0]?.movie.title || "—", true),
        pair("Top genre", d.topGenres[0] ? genreName(d.topGenres[0][0]) : "—", true))),
    h("div", { class: "wr-actions" },
      h("button", { type: "button", class: "btn btn-hero", onclick: () => share(d) }, icon("share"), "Share"),
      yearPicker(d.year, years, reopen)),
    h("p", { class: "wr-small wr-dim", text: "Tip: take a screenshot of the card to share it as a picture." }),
  ] });
  return out;
}

/** A bar whose length comes from --v (0–1). Set through CSSOM: the CSP blocks inline style attributes. */
function vbar(cls, v) {
  const el = h("span", { class: cls });
  el.style.setProperty("--v", String(Math.max(0, Math.min(1, v))));
  return el;
}

function stat(value, label, title = null) {
  return h("div", { class: "wr-stat", title }, h("span", { class: "wr-num", text: String(value) }), h("span", { class: "micro", text: label }));
}

function pair(label, value, wide = false) {
  return h("div", { class: wide ? "wide" : "" }, h("dt", { class: "micro", text: label }), h("dd", { text: String(value) }));
}

function yearPicker(year, years, reopen) {
  if (years.length < 2) return null;
  const sel = h("select", { class: "wr-year-pick", "aria-label": "Show another year" },
    years.map((y) => h("option", { value: String(y), text: String(y), selected: y === year })));
  sel.addEventListener("change", () => reopen(Number(sel.value)));
  return sel;
}

async function share(d) {
  const lines = [
    `My ${d.year} on Late Show 📺`,
    `${plural(d.count, "watch", "watches")} · ${plural(d.titles, "title")}${d.hours >= 1 ? ` · ${Math.round(d.hours)} hours` : ""}`,
    d.top.length ? `Top rated: ${d.top.slice(0, 3).map((t) => `${t.movie.title} (${t.best}/10)`).join(", ")}` : null,
    d.topGenres.length ? `Top genre: ${genreName(d.topGenres[0][0])}` : null,
    d.busiestMonth !== null ? `Busiest month: ${monthLong(d.busiestMonth)}` : null,
  ].filter(Boolean);
  const text = lines.join("\n");
  try {
    if (navigator.share) { await navigator.share({ text }); return; }
    await navigator.clipboard.writeText(text);
    toast("Copied — paste it anywhere");
  } catch (err) {
    if (err?.name !== "AbortError") toast("Couldn't share from this browser.", "error");
  }
}
