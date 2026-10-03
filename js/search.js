// TMDB search (movies + TV). Uses the v4 Read Access Token as a Bearer token.

const API = "https://api.themoviedb.org/3";
const POSTER_PATH_RE = /^\/[A-Za-z0-9_.-]{1,200}$/;

let token = null;
let inflight = null;

export function initSearch(readToken) {
  token = readToken && !readToken.startsWith("PASTE_") ? readToken : null;
  return Boolean(token);
}

const headers = () => ({ Authorization: `Bearer ${token}`, Accept: "application/json" });

async function multi(query, signal) {
  if (!token) throw new Error("TMDB token missing — see README.");
  const url = `${API}/search/multi?query=${encodeURIComponent(query)}&include_adult=false&page=1`;
  const res = await fetch(url, { headers: headers(), signal });
  if (res.status === 401) throw new Error("TMDB rejected the token (401). Check your TMDB_READ_TOKEN secret.");
  if (res.status === 429) throw new Error("TMDB rate limit — try again in a moment.");
  if (!res.ok) throw new Error(`TMDB search failed (${res.status}).`);
  return cleanResults(await res.json());
}

/**
 * Searches TMDB movies and TV shows together. Cancels any previous in-flight search.
 * Returns [{ id, mediaType, tmdbId, title, year, posterPath }], cleaned of anything unexpected.
 */
export async function searchMovies(query) {
  inflight?.abort();
  inflight = new AbortController();
  return multi(query, inflight.signal);
}

/**
 * One-off search for batch add: no shared abort (many run in parallel). /search/multi has no
 * year filter, so a given year ranks results instead. Returns up to 8 results.
 */
export async function searchMoviesOnce(query, year = null) {
  const results = await multi(query);
  if (year) {
    // Stable sort: matching-year results first, TMDB's relevance order otherwise kept.
    results.sort((a, b) => (b.year === String(year)) - (a.year === String(year)));
  }
  return results.slice(0, 8);
}

/**
 * The phone's region (e.g. "TH") for release dates: the first preferred language that names a
 * region, else the likely region for the language. null if the browser can't tell.
 */
export function userRegion() {
  try {
    for (const tag of navigator.languages || [navigator.language]) {
      const r = new Intl.Locale(tag).region;
      if (r) return r.toUpperCase();
    }
    return new Intl.Locale(navigator.language).maximize().region || null;
  } catch {
    return null;
  }
}

const dateOnly = (s) => (typeof s === "string" && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null);

/** Release date in `region`: earliest theatrical, else earliest digital/physical/TV, else null. */
function regionalRelease(releaseDates, region) {
  const r = (releaseDates?.results || []).find((x) => x.iso_3166_1 === region);
  if (!r) return null;
  const pick = (types) => r.release_dates.filter((d) => types.includes(d.type)).map((d) => dateOnly(d.release_date)).filter(Boolean).sort()[0] || null;
  return pick([2, 3]) || pick([4, 5, 6]);
}

/**
 * Facts for one library entry, used by stats, Coming soon and TV progress.
 * Movies: genres, year, runtime, release date (your region when TMDB has it).
 * TV: genres, first-air date, typical episode length, status, next episode, season list.
 */
export async function fetchMovieMeta(movie) {
  if (!token) throw new Error("TMDB token missing.");
  const tv = movie.mediaType === "tv";
  const url = `${API}/${tv ? "tv" : "movie"}/${encodeURIComponent(movie.tmdbId)}${tv ? "" : "?append_to_response=release_dates"}`;
  const res = await fetch(url, { headers: headers() });
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  if (res.status === 404) return { genres: [], releaseYear: null, runtime: null, seasons: tv ? [] : null, metaDate: today };
  if (!res.ok) throw new Error(`TMDB details failed (${res.status}).`);
  const d = await res.json();
  const genres = (Array.isArray(d.genres) ? d.genres : []).map((g) => g && g.id).filter((id) => Number.isInteger(id) && id > 0);

  if (!tv) {
    const releaseDate = regionalRelease(d.release_dates, userRegion()) || dateOnly(d.release_date);
    return {
      genres,
      releaseYear: releaseDate ? Number(releaseDate.slice(0, 4)) : null,
      runtime: Number.isInteger(d.runtime) && d.runtime > 0 ? d.runtime : null,
      releaseDate,
      metaDate: today,
    };
  }

  const first = dateOnly(d.first_air_date);
  const next = d.next_episode_to_air;
  const epRuntime = [...(Array.isArray(d.episode_run_time) ? d.episode_run_time : []), d.last_episode_to_air?.runtime, next?.runtime]
    .find((x) => Number.isInteger(x) && x > 0) || null;
  const status = d.status === "Ended" || d.status === "Canceled" ? "ended"
    : d.status === "Returning Series" ? "returning"
    : d.status ? "planned" : null;
  return {
    genres,
    releaseYear: first ? Number(first.slice(0, 4)) : null,
    runtime: epRuntime,
    releaseDate: first,
    tvStatus: status,
    nextAirDate: dateOnly(next?.air_date),
    nextAirSeason: Number.isInteger(next?.season_number) ? next.season_number : null,
    nextAirEpisode: Number.isInteger(next?.episode_number) ? next.episode_number : null,
    // Season 0 is "Specials" — left out of progress.
    seasons: (Array.isArray(d.seasons) ? d.seasons : [])
      .filter((x) => Number.isInteger(x.season_number) && x.season_number > 0 && Number.isInteger(x.episode_count))
      .map((x) => ({ n: x.season_number, c: x.episode_count, d: dateOnly(x.air_date) })),
    metaDate: today,
  };
}

/** Episode list for one season (names, air dates) — fetched on demand, not stored. */
export async function fetchSeason(tmdbId, season) {
  if (!token) throw new Error("TMDB token missing.");
  const res = await fetch(`${API}/tv/${encodeURIComponent(tmdbId)}/season/${encodeURIComponent(season)}`, { headers: headers() });
  if (!res.ok) throw new Error(`TMDB season failed (${res.status}).`);
  const d = await res.json();
  return (Array.isArray(d.episodes) ? d.episodes : [])
    .filter((e) => Number.isInteger(e.episode_number))
    .map((e) => ({ e: e.episode_number, name: typeof e.name === "string" ? e.name.slice(0, 200) : "", airDate: dateOnly(e.air_date) }));
}

function cleanResults(data) {
  return (Array.isArray(data.results) ? data.results : [])
    .filter((r) => (r.media_type === "movie" || r.media_type === "tv") && Number.isSafeInteger(r.id) && r.id > 0)
    .map((r) => {
      const tv = r.media_type === "tv";
      const title = tv ? r.name : r.title;
      const date = tv ? r.first_air_date : r.release_date;
      return {
        id: tv ? `tv-${r.id}` : String(r.id),
        mediaType: tv ? "tv" : "movie",
        tmdbId: r.id,
        title: typeof title === "string" ? title.slice(0, 300) : "",
        year: typeof date === "string" ? date.slice(0, 4) : "",
        posterPath: typeof r.poster_path === "string" && POSTER_PATH_RE.test(r.poster_path) ? r.poster_path : null,
      };
    })
    .filter((r) => r.title);
}

export function isAbort(err) {
  return err && err.name === "AbortError";
}
