// TV episode progress: pure helpers over a normalized TV entry. No DOM, no storage.
//
// m.seasons   [{ n: season number, c: episode count, d: season air date }] (from TMDB)
// m.progress  { "1": "1101", ... } — char i is episode i+1, "1" = watched
// m.nextAirSeason / nextAirEpisode / nextAirDate — the next episode TMDB knows about
// m.cycle     watch-through number (2 = first rewatch)

import { todayISO } from "./storage.js";

export const seasonsOf = (m) => (m.seasons || []).filter((s) => s.n > 0).sort((a, b) => a.n - b.n);

export function isWatched(m, season, ep) {
  return (m.progress?.[String(season)] || "")[ep - 1] === "1";
}

/** Has this episode aired? Everything before TMDB's "next episode" counts as aired. */
export function isAired(m, season, ep, today = todayISO()) {
  const s = (m.seasons || []).find((x) => x.n === season);
  if (s?.d && s.d > today) return false;
  if (m.nextAirSeason !== null && m.nextAirEpisode !== null && m.nextAirDate && m.nextAirDate > today) {
    if (season > m.nextAirSeason) return false;
    if (season === m.nextAirSeason && ep >= m.nextAirEpisode) return false;
  }
  if (m.tvStatus === "planned" && !(m.releaseDate && m.releaseDate <= today)) return false;
  return true;
}

/** Aired episodes in a season (count). */
export function airedIn(m, season, today = todayISO()) {
  const s = (m.seasons || []).find((x) => x.n === season);
  if (!s) return 0;
  let n = 0;
  for (let e = 1; e <= s.c; e++) if (isAired(m, season, e, today)) n++;
  return n;
}

export function watchedIn(m, season) {
  return [...(m.progress?.[String(season)] || "")].filter((c) => c === "1").length;
}

export function episodesWatched(m) {
  return Object.values(m.progress || {}).reduce((sum, v) => sum + [...v].filter((c) => c === "1").length, 0);
}

export function totals(m, today = todayISO()) {
  let aired = 0, watched = 0, total = 0;
  for (const s of seasonsOf(m)) {
    total += s.c;
    for (let e = 1; e <= s.c; e++) {
      const a = isAired(m, s.n, e, today);
      if (a) aired++;
      if (a && isWatched(m, s.n, e)) watched++;
    }
  }
  return { aired, watched, total };
}

/** First aired episode not yet watched, in order: { season, ep } or null. */
export function upNext(m, today = todayISO()) {
  for (const s of seasonsOf(m)) {
    for (let e = 1; e <= s.c; e++) {
      if (!isAired(m, s.n, e, today)) return null;
      if (!isWatched(m, s.n, e)) return { season: s.n, ep: e };
    }
  }
  return null;
}

/**
 * "notstarted" | "watching" | "caughtup" | "finished" | "unknown" (no season data yet).
 */
export function tvState(m, today = todayISO()) {
  if (!Array.isArray(m.seasons)) return "unknown";
  const { aired, watched } = totals(m, today);
  if (!watched) return "notstarted";
  if (watched < aired) return "watching";
  return m.tvStatus === "ended" ? "finished" : "caughtup";
}

export const epLabel = (season, ep) => `S${season} · E${ep}`;

// ---------------------------------------------------------------- changes (return new entries)

function setBit(str, i, on) {
  const arr = [...(str || "")];
  while (arr.length <= i) arr.push("0");
  arr[i] = on ? "1" : "0";
  return arr.join("").replace(/0+$/, "");
}

/**
 * Marks/unmarks one episode. If that completes the season, a history entry is added
 * ("Season 2", or "Season 2 · rewatch 1" on later watch-throughs) dated `date`.
 */
export function setEpisode(m, season, ep, on, date = todayISO()) {
  const progress = { ...(m.progress || {}) };
  const v = setBit(progress[String(season)], ep - 1, on);
  if (v) progress[String(season)] = v; else delete progress[String(season)];
  let next = { ...m, progress, lastWatched: on ? (date || m.lastWatched) : m.lastWatched };
  if (on) next = logSeasonIfComplete(next, season, date);
  return next;
}

/** Marks every aired episode of a season (on=true) or clears the season (on=false). */
export function setSeason(m, season, on, date = null) {
  const progress = { ...(m.progress || {}) };
  if (!on) {
    delete progress[String(season)];
    return { ...m, progress };
  }
  const s = (m.seasons || []).find((x) => x.n === season);
  let v = progress[String(season)] || "";
  for (let e = 1; e <= (s?.c || 0); e++) if (isAired(m, season, e)) v = setBit(v, e - 1, true);
  if (v) progress[String(season)] = v;
  return logSeasonIfComplete({ ...m, progress, lastWatched: date || m.lastWatched }, season, date);
}

/** Marks every aired episode of the show. Bulk marks are usually backlog, so undated. */
export function setAllAired(m, rating = null) {
  let next = m;
  const seasons = seasonsOf(m);
  seasons.forEach((s, i) => {
    next = setSeason(next, s.n, true, null);
    if (rating && i === seasons.length - 1) {
      const log = [...next.watchLog];
      const idx = log.map((e) => e.notes).lastIndexOf(seasonNote(next, s.n));
      if (idx >= 0) log[idx] = { ...log[idx], rating };
      next = { ...next, watchLog: log };
    }
  });
  return next;
}

/** Clears all progress and bumps the watch-through counter. History stays. */
export function startRewatch(m) {
  return { ...m, progress: {}, cycle: (m.cycle || 1) + 1 };
}

export const seasonNote = (m, season) => ((m.cycle || 1) > 1 ? `Season ${season} · rewatch ${m.cycle - 1}` : `Season ${season}`);

function logSeasonIfComplete(m, season, date) {
  const s = (m.seasons || []).find((x) => x.n === season);
  if (!s) return m;
  const aired = airedIn(m, season);
  // Only a fully released season counts as "finished"; a season still airing doesn't.
  if (!aired || aired < s.c || watchedIn(m, season) < s.c) return m;
  const note = seasonNote(m, season);
  if (m.watchLog.some((e) => e.notes === note)) return m;
  return { ...m, watchLog: [...m.watchLog, { date: date || null, rating: null, notes: note }] };
}
