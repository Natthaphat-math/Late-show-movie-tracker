// Discover: personal picks + browse rows, built from TMDB lists and scored on the device.
//
// No machine learning — a transparent score:
//   1. seeds   = up to 8 library titles that say most about your taste (rating, recency, rewatches)
//   2. sources = each seed's TMDB recommendations, plus trending / upcoming / hidden gems
//   3. score   = Σ over seeds of  seedWeight / √(position in that seed's list + 1)
//                + a small bonus for genres you rate above your average
//   4. drop    = anything in your library, marked Not interested, or weakly rated on TMDB
//   5. spread  = no more than 3 picks in a row explained by the same seed
// Raw TMDB lists are cached on the phone for the day; scoring re-runs on every render, so
// adding or hiding a title updates the rows instantly without new requests.

import { fetchRecommendations, fetchTrending, fetchUpcoming, fetchHiddenGems, userRegion } from "./search.js";
import { h, icon, posterSlot, emptyState } from "./ui.js";
import { episodesWatched, totals } from "./tv.js";
import { todayISO } from "./storage.js";
import { genreName } from "./stats.js";

const CACHE_KEY = "movieTracker.discover.v1";
const MAX_SEEDS = 8;
const MIN_SEEDS = 3;

// TV-only genre ids; others are shared or movie-only.
const TV_GENRES = new Set([10759, 10762, 10763, 10764, 10765, 10766, 10767, 10768]);

// ---------------------------------------------------------------- seeds

function latestRating(m) {
  for (let i = m.watchLog.length - 1; i >= 0; i--) if (m.watchLog[i].rating) return m.watchLog[i].rating;
  return null;
}

function lastActivity(m) {
  return [m.lastWatched, ...m.watchLog.map((e) => e.date)].filter(Boolean).sort().pop() || null;
}

function daysSince(iso) {
  return iso ? (Date.now() - new Date(`${iso}T12:00:00`).getTime()) / 86400000 : Infinity;
}

/** Library titles ranked by how strongly they signal your taste. */
export function pickSeeds(movies) {
  const seeds = [];
  for (const m of movies.values()) {
    if (m.mediaType === "custom" || !m.tmdbId) continue;
    const rating = latestRating(m);
    const eps = m.mediaType === "tv" ? episodesWatched(m) : 0;
    let w;
    if (rating !== null) {
      if (rating <= 5) continue;
      w = (rating - 5) / 5;                       // 10 → 1.0 · 7 → 0.4 · 6 → 0.2
    } else if (m.watchLog.length) {
      w = 0.3;                                    // watched, not rated
    } else if (eps) {
      const { aired } = totals(m);
      w = 0.2 + 0.3 * Math.min(1, eps / Math.max(1, aired)); // further into a show = stronger
    } else {
      continue;
    }
    const age = daysSince(lastActivity(m));
    if (age < 90) w *= 1.3; else if (age < 365) w *= 1.1;
    const times = m.mediaType === "tv" ? (m.cycle || 1) : m.watchLog.length;
    if (times > 1) w *= 1.3;
    seeds.push({ id: m.id, mediaType: m.mediaType, tmdbId: m.tmdbId, title: m.title, rating, weight: w });
  }
  return seeds.sort((a, b) => b.weight - a.weight).slice(0, MAX_SEEDS);
}

/** Your average rating per genre minus your overall average (positive = genres you rate higher). */
function genreAffinity(movies) {
  const sum = new Map(); let total = 0, n = 0;
  for (const m of movies.values()) {
    const r = latestRating(m);
    if (!r || !Array.isArray(m.genres)) continue;
    total += r; n++;
    for (const g of m.genres) { const s = sum.get(g) || [0, 0]; s[0] += r; s[1]++; sum.set(g, s); }
  }
  const avg = n ? total / n : 0;
  const aff = new Map();
  for (const [g, [t, c]] of sum) if (c >= 2) aff.set(g, t / c - avg);
  return aff;
}

/** The genre you rate highest (2+ ratings), else the one you watch most. */
function topGenre(movies) {
  const aff = genreAffinity(movies);
  const best = [...aff].sort((a, b) => b[1] - a[1])[0];
  if (best) return best[0];
  const counts = new Map();
  for (const m of movies.values()) {
    if (!(m.watchLog.length || episodesWatched(m)) || !Array.isArray(m.genres)) continue;
    for (const g of m.genres) counts.set(g, (counts.get(g) || 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

// ---------------------------------------------------------------- fetching + cache

function readCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || "null"); } catch { return null; }
}

function writeCache(data) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch {}
}

/** True when the cached lists are from today, for this region and these seeds. */
export function cacheIsFresh(movies) {
  const c = readCache();
  if (!c || c.date !== todayISO() || c.region !== userRegion()) return false;
  const want = pickSeeds(movies).map((s) => s.id).join(",");
  return c.seedKey === want;
}

export function cachedSources() {
  return readCache();
}

/** Fetches every source (≈12 requests). Failures of single sources don't fail the rest. */
export async function refreshSources(movies) {
  const seeds = pickSeeds(movies);
  const region = userRegion();
  const genre = topGenre(movies);
  const safe = (p, fallback) => p.catch((err) => { console.warn("Discover source failed", err); return fallback; });
  const [recLists, trending, upcoming, gems] = await Promise.all([
    Promise.all(seeds.map((s) => safe(fetchRecommendations(s), []))),
    safe(fetchTrending(), []),
    safe(fetchUpcoming(region), { movies: [], tv: [] }),
    genre !== null ? safe(fetchHiddenGems(genre, TV_GENRES.has(genre) ? "tv" : "movie"), []) : Promise.resolve([]),
  ]);
  const data = {
    date: todayISO(), region, seedKey: seeds.map((s) => s.id).join(","),
    seeds, recLists, trending, upcoming, gems, gemsGenre: genre,
  };
  writeCache(data);
  return data;
}

// ---------------------------------------------------------------- scoring

const goodEnough = (r) => r.voteAvg === null || r.voteCount === null || (r.voteAvg >= 6 && r.voteCount >= 50);

/** Ranked personal picks with reasons. */
export function scorePicks(data, movies, hidden, kind) {
  const aff = genreAffinity(movies);
  const cands = new Map();
  data.seeds.forEach((seed, si) => {
    (data.recLists[si] || []).forEach((r, pos) => {
      const c = cands.get(r.id) || { r, score: 0, by: [] };
      const add = seed.weight / Math.sqrt(pos + 1);
      c.score += add;
      c.by.push({ seed, add });
      cands.set(r.id, c);
    });
  });
  const out = [];
  for (const c of cands.values()) {
    const r = c.r;
    if (movies.has(r.id) || hidden.has(r.id) || !goodEnough(r)) continue;
    if (kind !== "all" && r.mediaType !== kind) continue;
    const gs = r.genreIds.filter((g) => aff.has(g));
    if (gs.length) c.score += 0.1 * gs.reduce((s, g) => s + Math.max(-2, Math.min(2, aff.get(g))), 0) / gs.length;
    c.by.sort((a, b) => b.add - a.add);
    out.push(c);
  }
  out.sort((a, b) => b.score - a.score);
  return spread(out).slice(0, 20);
}

/** Reorders so no more than 3 consecutive picks share their main reason. */
function spread(list) {
  const result = [];
  const pending = [...list];
  while (pending.length) {
    const lastSeeds = result.slice(-3).map((c) => c.by[0].seed.id);
    const blocked = lastSeeds.length === 3 && lastSeeds.every((x) => x === lastSeeds[0]) ? lastSeeds[0] : null;
    const i = pending.findIndex((c) => c.by[0].seed.id !== blocked);
    result.push(pending.splice(i < 0 ? 0 : i, 1)[0]);
  }
  return result;
}

function reason(c) {
  const names = c.by.slice(0, 2).map((b) => b.seed.title);
  const verb = c.by[0].seed.rating ? "liked" : "watched";
  return names.length > 1 ? `Because you ${verb} ${names[0]} & ${names[1]}` : `Because you ${verb} ${names[0]}`;
}

// ---------------------------------------------------------------- rendering

/**
 * hooks: { open(r), add(r), hide(r), refresh(), loading, error }
 * kind: "all" | "movie" | "tv"
 */
export function renderDiscover(data, movies, hidden, kind, hooks) {
  const keep = (r) => !movies.has(r.id) && !hidden.has(r.id) && (kind === "all" || r.mediaType === kind);
  const toolbar = h("div", { class: "disc-toolbar" },
    h("span", { class: "micro", text: data ? `Updated ${data.date === todayISO() ? "today" : data.date} · ${data.region || "worldwide"}` : "" }),
    h("button", { type: "button", class: "btn btn-sm btn-ghost", disabled: hooks.loading, onclick: hooks.refresh }, hooks.loading ? "Refreshing…" : "↻ Refresh"));

  if (!data) {
    return h("div", {}, toolbar,
      hooks.error ? emptyState("No signal", hooks.error) : h("p", { class: "loading micro", text: "Tuning in…" }));
  }

  const rows = [];
  const personal = data.seeds.length >= MIN_SEEDS;
  if (personal) {
    const picks = scorePicks(data, movies, hidden, kind);
    if (picks.length) rows.push(row("Picked for you", "Scored from your ratings", picks.map((c) => ({ r: c.r, note: reason(c) })), hooks));
    data.seeds.slice(0, 3).forEach((seed, si) => {
      const items = (data.recLists[si] || []).filter(keep).filter(goodEnough).slice(0, 12);
      if (items.length < 3) return;
      const head = seed.rating ? `Because you rated ${seed.title} ${seed.rating}/10` : `Because you watched ${seed.title}`;
      rows.push(row(head, null, items.map((r) => ({ r })), hooks));
    });
  } else {
    rows.push(h("div", { class: "disc-cold panel" },
      h("span", { class: "micro panel-label", text: "Picked for you" }),
      h("p", { text: `Rate or watch a few more titles to get personal picks — ${data.seeds.length} of ${MIN_SEEDS} so far.` })));
  }

  const trending = data.trending.filter(keep).slice(0, 20);
  if (trending.length) rows.push(row("Trending this week", null, trending.map((r) => ({ r })), hooks));

  const today = todayISO();
  const soonMovies = (kind === "tv" ? [] : data.upcoming.movies.filter((r) => keep(r) && r.date && r.date > today))
    .sort((a, b) => a.date.localeCompare(b.date)).slice(0, 15).map((r) => ({ r, tag: shortDate(r.date) }));
  const onAir = (kind === "movie" ? [] : data.upcoming.tv.filter(keep)).slice(0, 10).map((r) => ({ r, tag: "On air" }));
  const soon = [...soonMovies, ...onAir];
  if (soon.length) rows.push(row(`Coming soon${data.region ? ` in ${regionName(data.region)}` : ""}`, "New films and shows airing this week", soon, hooks));

  const gems = data.gems.filter(keep).filter(goodEnough).slice(0, 15);
  if (gems.length && data.gemsGenre !== null) rows.push(row(`Hidden gems in ${genreName(data.gemsGenre)}`, "Well rated, less famous", gems.map((r) => ({ r })), hooks));

  return h("div", { class: "discover" }, toolbar, rows.length ? rows : emptyState("Nothing new", "Everything here is already in your library. Try ↻ Refresh tomorrow."));
}

function row(title, sub, items, hooks) {
  return h("section", { class: "disc-row" },
    h("div", { class: "rel-head" },
      h("h2", { class: "disc-title", text: title }),
      sub ? h("span", { class: "micro", text: sub }) : null),
    h("ol", { class: "rel-strip disc-strip" }, items.map((it) => tile(it, hooks))));
}

function tile({ r, note = null, tag = null }, hooks) {
  return h("li", { class: "rel-tile disc-tile" },
    h("button", { type: "button", class: "rel-open", onclick: () => hooks.open(r), "aria-label": `${r.title}${r.year ? ` (${r.year})` : ""}${note ? `. ${note}` : ""}` },
      posterSlot(r.posterPath ? `https://image.tmdb.org/t/p/w185${r.posterPath}` : null),
      r.mediaType === "tv" ? h("span", { class: "kind-badge", text: "TV" }) : null,
      h("span", { class: "rel-title", text: r.title }),
      h("span", { class: "rel-year mono", text: tag || r.year || "TBA" }),
      note ? h("span", { class: "disc-note", text: note }) : null),
    h("button", { type: "button", class: "icon-btn rel-add", "aria-label": `Add ${r.title} to watchlist`, title: "Add to watchlist", onclick: (e) => { e.stopPropagation(); hooks.add(r); } }, icon("plus")),
    h("button", { type: "button", class: "icon-btn disc-hide", "aria-label": `Not interested in ${r.title}`, title: "Not interested", onclick: (e) => { e.stopPropagation(); hooks.hide(r); } }, icon("x")));
}

function shortDate(iso) {
  return new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function regionName(code) {
  try { return new Intl.DisplayNames(undefined, { type: "region" }).of(code) || code; } catch { return code; }
}
