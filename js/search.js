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
let regionOverride = null;   // from Settings; null = automatic
let thaiOriginals = false;   // Settings → Language: show Thai-language titles in Thai

export function setRegionOverride(code) { regionOverride = code || null; }
export function setThaiOriginals(on) { thaiOriginals = Boolean(on); }

/** Region used for release dates and where to watch: Settings choice, else the phone's guess. */
export function userRegion() {
  return regionOverride || autoRegion();
}

export function autoRegion() {
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
  const origLang = typeof d.original_language === "string" && /^[a-z]{2}$/.test(d.original_language) ? d.original_language : "xx";
  // Thai-language originals: title + poster follow Settings → Language.
  const naming = origLang === "th" ? await thaiNaming(movie, d, tv) : {};

  if (!tv) {
    const releaseDate = regionalRelease(d.release_dates, userRegion()) || dateOnly(d.release_date);
    return {
      genres,
      releaseYear: releaseDate ? Number(releaseDate.slice(0, 4)) : null,
      runtime: Number.isInteger(d.runtime) && d.runtime > 0 ? d.runtime : null,
      releaseDate,
      metaDate: today,
      origLang,
      ...naming,
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
    origLang,
    ...naming,
  };
}

/**
 * Title and poster for a Thai-language original. With the Thai option on: the original Thai
 * title and a Thai-language poster when TMDB has one. Off: the English title and default poster.
 */
async function thaiNaming(movie, d, tv) {
  const english = tv ? d.name : d.title;
  const thai = tv ? d.original_name : d.original_title;
  const out = {};
  const pick = thaiOriginals ? thai || english : english || thai;
  if (typeof pick === "string" && pick.trim()) out.title = pick.trim().slice(0, 300);
  let poster = typeof d.poster_path === "string" && POSTER_PATH_RE.test(d.poster_path) ? d.poster_path : null;
  if (thaiOriginals) {
    try {
      const res = await fetch(`${API}/${tv ? "tv" : "movie"}/${encodeURIComponent(movie.tmdbId)}/images?include_image_language=th`, { headers: headers() });
      if (res.ok) {
        const imgs = await res.json();
        const th = (imgs.posters || []).filter((p) => p.iso_639_1 === "th" && POSTER_PATH_RE.test(p.file_path || ""))
          .sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0))[0];
        if (th) poster = th.file_path;
      }
    } catch {
      // keep the default poster
    }
  }
  if (poster) out.posterPath = poster;
  return out;
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

/**
 * Related titles for the detail page: the franchise/collection a movie belongs to (in release
 * order) and TMDB's recommendations, falling back to "similar" when there are none.
 * Returns { collection: { name, parts } | null, more: [...] } using the same shape as search results.
 */
export async function fetchRelated(movie) {
  if (!token) throw new Error("TMDB token missing.");
  const tv = movie.mediaType === "tv";
  const kind = tv ? "tv" : "movie";
  const res = await fetch(`${API}/${kind}/${encodeURIComponent(movie.tmdbId)}?append_to_response=recommendations,similar`, { headers: headers() });
  if (!res.ok) throw new Error(`TMDB related failed (${res.status}).`);
  const d = await res.json();
  const tag = (list) => (Array.isArray(list) ? list : []).filter((r) => !r.adult).map((r) => ({ ...r, media_type: r.media_type || kind }));
  const recs = tag(d.recommendations?.results);
  const more = cleanResults({ results: recs.length ? recs : tag(d.similar?.results) })
    .filter((r) => r.tmdbId !== movie.tmdbId)
    .slice(0, 12);

  let collection = null;
  const c = d.belongs_to_collection;
  if (!tv && c && Number.isInteger(c.id)) {
    try {
      const cr = await fetch(`${API}/collection/${encodeURIComponent(c.id)}`, { headers: headers() });
      if (cr.ok) {
        const cd = await cr.json();
        const parts = cleanResults({ results: tag(cd.parts).map((p) => ({ ...p, media_type: "movie" })) })
          .sort((a, b) => (a.year || "9999").localeCompare(b.year || "9999"));
        if (parts.length > 1) collection = { name: typeof cd.name === "string" ? cd.name.slice(0, 200) : "Collection", parts };
      }
    } catch {
      // The collection row is a bonus; recommendations still show.
    }
  }
  // Don't repeat collection films in "More like this".
  const inCollection = new Set((collection?.parts || []).map((p) => p.id));
  return { collection, more: more.filter((r) => !inCollection.has(r.id)) };
}

function cleanResults(data) {
  return (Array.isArray(data.results) ? data.results : [])
    .filter((r) => (r.media_type === "movie" || r.media_type === "tv") && Number.isSafeInteger(r.id) && r.id > 0)
    .map((r) => {
      const tv = r.media_type === "tv";
      const original = tv ? r.original_name : r.original_title;
      const title = thaiOriginals && r.original_language === "th" && typeof original === "string" && original.trim() ? original : tv ? r.name : r.title;
      const date = tv ? r.first_air_date : r.release_date;
      return {
        id: tv ? `tv-${r.id}` : String(r.id),
        mediaType: tv ? "tv" : "movie",
        tmdbId: r.id,
        title: typeof title === "string" ? title.slice(0, 300) : "",
        year: typeof date === "string" ? date.slice(0, 4) : "",
        posterPath: typeof r.poster_path === "string" && POSTER_PATH_RE.test(r.poster_path) ? r.poster_path : null,
        // Used by Discover's scoring; ignored elsewhere.
        date: dateOnly(date),
        voteAvg: typeof r.vote_average === "number" ? r.vote_average : null,
        voteCount: Number.isInteger(r.vote_count) ? r.vote_count : null,
        genreIds: Array.isArray(r.genre_ids) ? r.genre_ids.filter(Number.isInteger) : [],
      };
    })
    .filter((r) => r.title);
}

// ---------------------------------------------------------------- where to watch

/**
 * Streaming / rent / buy availability in one region (TMDB's watch providers, data by JustWatch).
 * Returns { link, stream: [...], rent: [...], buy: [...] } — each { id, name, logo } — or null
 * when TMDB has nothing for that region.
 */
export async function fetchProviders(movie, region) {
  if (!token) throw new Error("TMDB token missing.");
  const kind = movie.mediaType === "tv" ? "tv" : "movie";
  const res = await fetch(`${API}/${kind}/${encodeURIComponent(movie.tmdbId)}/watch/providers`, { headers: headers() });
  if (!res.ok) throw new Error(`TMDB providers failed (${res.status}).`);
  const d = await res.json();
  const r = d.results?.[region];
  if (!r) return null;
  const clean = (list) => (Array.isArray(list) ? list : [])
    .filter((p) => Number.isInteger(p.provider_id) && typeof p.provider_name === "string")
    .sort((a, b) => (a.display_priority ?? 99) - (b.display_priority ?? 99))
    .map((p) => ({
      id: p.provider_id,
      name: p.provider_name.slice(0, 80),
      logo: typeof p.logo_path === "string" && POSTER_PATH_RE.test(p.logo_path) ? p.logo_path : null,
    }));
  const dedupe = (list) => list.filter((p, i) => list.findIndex((q) => q.id === p.id) === i);
  let link = null;
  try { const u = new URL(r.link); if (u.protocol === "https:" && u.hostname.endsWith("themoviedb.org")) link = u.href; } catch {}
  return {
    link,
    stream: dedupe([...clean(r.flatrate), ...clean(r.free), ...clean(r.ads)]),
    rent: clean(r.rent),
    buy: clean(r.buy),
  };
}

/**
 * Every streaming service TMDB knows in a region (films + TV merged), most popular first:
 * [{ id, name, logo }].
 */
export async function fetchServiceCatalog(region) {
  if (!token) throw new Error("TMDB token missing.");
  const get = async (kind) => {
    const res = await fetch(`${API}/watch/providers/${kind}?watch_region=${encodeURIComponent(region)}`, { headers: headers() });
    if (!res.ok) throw new Error(`TMDB service list failed (${res.status}).`);
    const d = await res.json();
    return Array.isArray(d.results) ? d.results : [];
  };
  const [movie, tv] = await Promise.all([get("movie"), get("tv").catch(() => [])]);
  const byId = new Map();
  for (const p of [...movie, ...tv]) {
    if (!Number.isInteger(p.provider_id) || typeof p.provider_name !== "string") continue;
    const prio = p.display_priorities?.[region] ?? p.display_priority ?? 999;
    const cur = byId.get(p.provider_id);
    if (!cur || prio < cur.prio) {
      byId.set(p.provider_id, {
        id: p.provider_id,
        name: p.provider_name.slice(0, 80),
        logo: typeof p.logo_path === "string" && POSTER_PATH_RE.test(p.logo_path) ? p.logo_path : null,
        prio,
      });
    }
  }
  return [...byId.values()].sort((a, b) => a.prio - b.prio || a.name.localeCompare(b.name)).map(({ prio, ...p }) => p);
}

/** Popular titles streaming on any of the given services in a region (subscription, free or with ads). */
export function fetchOnServices(kind, serviceIds, region) {
  const ids = encodeURIComponent(serviceIds.join("|"));
  const types = encodeURIComponent("flatrate|free|ads");
  return getList(`/discover/${kind}?with_watch_providers=${ids}&watch_region=${encodeURIComponent(region)}&with_watch_monetization_types=${types}&sort_by=popularity.desc&vote_count.gte=50&include_adult=false&page=1`, kind);
}

// ---------------------------------------------------------------- Discover sources

async function getList(path, kind = null) {
  if (!token) throw new Error("TMDB token missing.");
  const res = await fetch(`${API}${path}`, { headers: headers() });
  if (!res.ok) throw new Error(`TMDB ${path.split("?")[0]} failed (${res.status}).`);
  const d = await res.json();
  const list = (Array.isArray(d.results) ? d.results : []).filter((r) => !r.adult).map((r) => ({ ...r, media_type: r.media_type || kind }));
  return cleanResults({ results: list });
}

/** TMDB's recommendations for one title (about 20). */
export function fetchRecommendations(item) {
  const kind = item.mediaType === "tv" ? "tv" : "movie";
  return getList(`/${kind}/${encodeURIComponent(item.tmdbId)}/recommendations?page=1`, kind);
}

export function fetchTrending() {
  return getList("/trending/all/week");
}

/** Upcoming films in a region, plus shows with episodes airing this week. */
export async function fetchUpcoming(region) {
  const r = region ? `&region=${encodeURIComponent(region)}` : "";
  const [movies, tv] = await Promise.all([
    getList(`/movie/upcoming?page=1${r}`, "movie"),
    getList("/tv/on_the_air?page=1", "tv").catch(() => []),
  ]);
  return { movies, tv };
}

/** Well-rated but not hugely famous titles in one genre. */
export function fetchHiddenGems(genreId, kind = "movie") {
  return getList(`/discover/${kind}?with_genres=${encodeURIComponent(genreId)}&sort_by=vote_average.desc&vote_average.gte=7.3&vote_count.gte=150&vote_count.lte=4000&include_adult=false&page=1`, kind);
}

export function isAbort(err) {
  return err && err.name === "AbortError";
}
