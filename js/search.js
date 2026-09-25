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

/** Genres, release year and runtime for one library entry (used by the stats page). */
export async function fetchMovieMeta(movie) {
  if (!token) throw new Error("TMDB token missing.");
  const tv = movie.mediaType === "tv";
  const res = await fetch(`${API}/${tv ? "tv" : "movie"}/${encodeURIComponent(movie.tmdbId)}`, { headers: headers() });
  if (res.status === 404) return { genres: [], releaseYear: null, runtime: null };
  if (!res.ok) throw new Error(`TMDB details failed (${res.status}).`);
  const d = await res.json();
  const year = Number.parseInt(String((tv ? d.first_air_date : d.release_date) || "").slice(0, 4), 10);
  return {
    genres: (Array.isArray(d.genres) ? d.genres : []).map((g) => g && g.id).filter((id) => Number.isInteger(id) && id > 0),
    releaseYear: Number.isInteger(year) ? year : null,
    // A show's total length isn't reliable on TMDB, so TV stays out of "hours watched".
    runtime: !tv && Number.isInteger(d.runtime) && d.runtime > 0 ? d.runtime : null,
  };
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
