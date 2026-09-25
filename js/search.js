// TMDB search. Uses the v4 Read Access Token as a Bearer token.

const API = "https://api.themoviedb.org/3";
const POSTER_PATH_RE = /^\/[A-Za-z0-9_.-]{1,200}$/;

let token = null;
let inflight = null;

export function initSearch(readToken) {
  token = readToken && !readToken.startsWith("PASTE_") ? readToken : null;
  return Boolean(token);
}

/**
 * Searches TMDB movies. Cancels any previous in-flight search.
 * Returns [{ tmdbId, title, year, posterPath }], cleaned of anything unexpected.
 */
export async function searchMovies(query) {
  if (!token) throw new Error("TMDB token missing — see README.");
  inflight?.abort();
  inflight = new AbortController();
  const url = `${API}/search/movie?query=${encodeURIComponent(query)}&include_adult=false&page=1`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: inflight.signal,
  });
  if (res.status === 401) throw new Error("TMDB rejected the token (401). Check js/config.js.");
  if (!res.ok) throw new Error(`TMDB search failed (${res.status}).`);
  return cleanResults(await res.json());
}

/**
 * One-off search for batch add: no shared abort (many run in parallel), optional year.
 * Returns up to 8 cleaned results.
 */
export async function searchMoviesOnce(query, year = null) {
  if (!token) throw new Error("TMDB token missing — see README.");
  let url = `${API}/search/movie?query=${encodeURIComponent(query)}&include_adult=false&page=1`;
  if (year) url += `&year=${encodeURIComponent(year)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  if (res.status === 429) throw new Error("TMDB rate limit — try again in a moment.");
  if (!res.ok) throw new Error(`TMDB search failed (${res.status}).`);
  return cleanResults(await res.json()).slice(0, 8);
}

function cleanResults(data) {
  return (Array.isArray(data.results) ? data.results : [])
    .filter((r) => Number.isSafeInteger(r.id) && typeof r.title === "string")
    .map((r) => ({
      tmdbId: r.id,
      title: r.title.slice(0, 300),
      year: typeof r.release_date === "string" ? r.release_date.slice(0, 4) : "",
      posterPath: typeof r.poster_path === "string" && POSTER_PATH_RE.test(r.poster_path) ? r.poster_path : null,
    }));
}

export function isAbort(err) {
  return err && err.name === "AbortError";
}
