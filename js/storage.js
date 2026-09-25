// Storage layer: one interface, two adapters.
//
//   adapter.getMovies()            -> Promise<Movie[]>
//   adapter.addMovie(movie)        -> Promise<void>
//   adapter.updateMovie(movie)     -> Promise<void>   (full replace, keyed by tmdbId)
//   adapter.removeMovie(tmdbId)    -> Promise<void>
//
// The rest of the app only talks to this interface and never knows which backend is active.
// Every movie passes through normalizeMovie() before it is stored or used, so data from
// localStorage, Firestore and imported files is treated as untrusted in the same way.

export const LOCAL_KEY = "movieTracker.library.v1";

const LIMITS = { title: 300, notes: 2000, url: 2048, watchLog: 1000 };
const POSTER_PATH_RE = /^\/[A-Za-z0-9_.-]{1,200}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// ---------- small helpers ----------

export function todayISO() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function isValidDate(s) {
  if (typeof s !== "string") return false;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** Returns the URL string if it is a well-formed https URL, else null. */
export function httpsUrlOrNull(value) {
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (!s || s.length > LIMITS.url) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

export function posterUrl(movie, size = "w500") {
  if (movie.customPosterUrl) return movie.customPosterUrl;
  if (movie.posterPath) return `https://image.tmdb.org/t/p/${size}${movie.posterPath}`;
  return null;
}

// ---------- normalization / validation ----------

function normalizeEntry(e) {
  if (!e || typeof e !== "object") return null;
  // Date is optional (older watches you can't place); anything else must be a real date.
  let date = null;
  if (e.date !== null && e.date !== undefined && e.date !== "") {
    if (!isValidDate(e.date)) return null;
    date = e.date;
  }
  let rating = null;
  if (e.rating !== null && e.rating !== undefined && e.rating !== "") {
    const r = Number(e.rating);
    if (Number.isInteger(r) && r >= 1 && r <= 10) rating = r;
  }
  const notes = typeof e.notes === "string" ? e.notes.slice(0, LIMITS.notes) : "";
  return { date, rating, notes };
}

/** Returns a clean Movie object with exactly the model's fields, or null if unusable. */
export function normalizeMovie(raw) {
  if (!raw || typeof raw !== "object") return null;
  const tmdbId = Number(raw.tmdbId);
  if (!Number.isSafeInteger(tmdbId) || tmdbId <= 0) return null;
  const title = typeof raw.title === "string" ? raw.title.trim().slice(0, LIMITS.title) : "";
  if (!title) return null;
  const posterPath =
    typeof raw.posterPath === "string" && POSTER_PATH_RE.test(raw.posterPath) ? raw.posterPath : null;
  const watchLog = (Array.isArray(raw.watchLog) ? raw.watchLog : [])
    .map(normalizeEntry)
    .filter(Boolean)
    .slice(0, LIMITS.watchLog);
  sortLog(watchLog);
  return {
    tmdbId,
    title,
    posterPath,
    customPosterUrl: httpsUrlOrNull(raw.customPosterUrl),
    inWatchlist: raw.inWatchlist === true,
    addedDate: isValidDate(raw.addedDate) ? raw.addedDate : todayISO(),
    watchLog,
    ...normalizeMeta(raw),
  };
}

/**
 * Optional TMDB facts used by the stats page. null = not fetched yet (the app backfills it).
 * genres: TMDB genre ids · releaseYear: e.g. 2014 · runtime: minutes.
 */
export function normalizeMeta(raw) {
  const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);
  return {
    genres: Array.isArray(raw.genres) ? [...new Set(raw.genres.filter((g) => Number.isInteger(g) && g > 0))].slice(0, 12) : null,
    releaseYear: int(raw.releaseYear, 1870, 2100),
    runtime: int(raw.runtime, 0, 1000),
  };
}

export const META_KEYS = ["genres", "releaseYear", "runtime"];

export const hasMeta = (m) => Array.isArray(m.genres);

export function sortLog(log) {
  // Undated watches sort first (treated as the oldest); dated ones chronologically.
  const key = (e) => e.date || "";
  return log.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

// ---------- import / export / merge ----------

export function buildExport(movies) {
  return {
    app: "movie-tracker",
    version: 1,
    exportedAt: new Date().toISOString(),
    movies: movies.map(normalizeMovie).filter(Boolean),
  };
}

/** Accepts our export object or a bare array. Returns { movies, skipped }. */
export function parseImport(json) {
  const list = Array.isArray(json) ? json : json && Array.isArray(json.movies) ? json.movies : null;
  if (!list) throw new Error("File doesn't look like a movie-tracker export.");
  const seen = new Map();
  let skipped = 0;
  for (const raw of list) {
    const m = normalizeMovie(raw);
    if (!m) { skipped++; continue; }
    seen.set(m.tmdbId, seen.has(m.tmdbId) ? mergeMovie(seen.get(m.tmdbId), m) : m);
  }
  return { movies: [...seen.values()], skipped };
}

const entryKey = (e) => `${e.date}|${e.rating ?? ""}|${e.notes}`;

/** Merges two records for the same film without losing any watch or status. */
export function mergeMovie(a, b) {
  const log = [...a.watchLog];
  const keys = new Set(log.map(entryKey));
  for (const e of b.watchLog) if (!keys.has(entryKey(e))) { log.push(e); keys.add(entryKey(e)); }
  return {
    tmdbId: a.tmdbId,
    title: a.title || b.title,
    posterPath: a.posterPath || b.posterPath,
    customPosterUrl: a.customPosterUrl || b.customPosterUrl,
    inWatchlist: a.inWatchlist || b.inWatchlist,
    addedDate: a.addedDate < b.addedDate ? a.addedDate : b.addedDate,
    watchLog: sortLog(log).slice(0, LIMITS.watchLog),
    genres: a.genres ?? b.genres ?? null,
    releaseYear: a.releaseYear ?? b.releaseYear ?? null,
    runtime: a.runtime ?? b.runtime ?? null,
  };
}

/**
 * Applies incoming movies to an adapter. Used by JSON import AND the first-login
 * local→cloud merge, so both behave identically.
 * mode: "merge" (union with existing) or "replace" (wipe existing first).
 */
export async function applyImport(adapter, existing, incoming, mode = "merge") {
  const byId = new Map(existing.map((m) => [m.tmdbId, m]));
  if (mode === "replace") {
    await inChunks(existing, (m) => adapter.removeMovie(m.tmdbId));
    byId.clear();
  }
  let added = 0, merged = 0;
  await inChunks(incoming, async (m) => {
    const cur = byId.get(m.tmdbId);
    if (cur) {
      await adapter.updateMovie(mergeMovie(cur, m));
      merged++;
    } else {
      await adapter.addMovie(m);
      added++;
    }
  });
  return { added, merged };
}

async function inChunks(items, fn, size = 20) {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(fn));
  }
}

// ---------- adapter: localStorage ----------

function readLocal() {
  try {
    const parsed = JSON.parse(localStorage.getItem(LOCAL_KEY) || "null");
    const list = parsed && typeof parsed.movies === "object" ? Object.values(parsed.movies) : [];
    return list.map(normalizeMovie).filter(Boolean);
  } catch {
    return [];
  }
}

function writeLocal(movies) {
  const out = { version: 1, movies: {} };
  for (const m of movies) out.movies[m.tmdbId] = m;
  localStorage.setItem(LOCAL_KEY, JSON.stringify(out));
}

export const localStorageAdapter = {
  name: "local",
  async getMovies() {
    return readLocal();
  },
  async addMovie(movie) {
    const m = normalizeMovie(movie);
    if (!m) throw new Error("Invalid movie");
    writeLocal([...readLocal().filter((x) => x.tmdbId !== m.tmdbId), m]);
  },
  async updateMovie(movie) {
    return this.addMovie(movie);
  },
  async removeMovie(tmdbId) {
    writeLocal(readLocal().filter((x) => x.tmdbId !== tmdbId));
  },
};

export function localLibraryCount() {
  return readLocal().length;
}

// ---------- adapter: Firestore (users/{uid}/movies/{movieId}) ----------

/**
 * fb = { db, collection, doc, getDocs, setDoc, deleteDoc } from firebase-init.js.
 * The SDK is passed in so this module never imports Firebase itself.
 */
export function createFirestoreAdapter(fb, uid) {
  const col = () => fb.collection(fb.db, "users", uid, "movies");
  const ref = (id) => fb.doc(fb.db, "users", uid, "movies", String(id));
  // Unset meta fields are left out of the document, so older security rules (without the
  // meta fields) keep accepting every write that doesn't carry any.
  const toDoc = (m, withMeta) => {
    const d = { ...m };
    for (const k of META_KEYS) if (!withMeta || d[k] === null) delete d[k];
    return d;
  };
  return {
    name: "firestore",
    metaBlocked: false, // true once the rules have rejected meta fields: stop sending them
    async getMovies() {
      const snap = await fb.getDocs(col());
      return snap.docs.map((d) => normalizeMovie(d.data())).filter(Boolean);
    },
    async addMovie(movie) {
      const m = normalizeMovie(movie);
      if (!m) throw new Error("Invalid movie");
      const hasAnyMeta = META_KEYS.some((k) => m[k] !== null);
      if (!hasAnyMeta || this.metaBlocked) return fb.setDoc(ref(m.tmdbId), toDoc(m, false));
      try {
        await fb.setDoc(ref(m.tmdbId), toDoc(m, true));
      } catch (err) {
        if (err?.code !== "permission-denied") throw err;
        // Rules predate the stats fields: save without them and remember.
        this.metaBlocked = true;
        await fb.setDoc(ref(m.tmdbId), toDoc(m, false));
      }
    },
    async updateMovie(movie) {
      return this.addMovie(movie);
    },
    async removeMovie(tmdbId) {
      await fb.deleteDoc(ref(tmdbId));
    },
  };
}
