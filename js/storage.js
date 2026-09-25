// Storage layer: one interface, two adapters.
//
//   adapter.getMovies()            -> Promise<Movie[]>
//   adapter.addMovie(movie)        -> Promise<void>
//   adapter.updateMovie(movie)     -> Promise<void>   (full replace, keyed by movie.id)
//   adapter.removeMovie(id)        -> Promise<void>
//   adapter.getLists()             -> Promise<List[]>
//   adapter.saveList(list)         -> Promise<void>   (create or full replace, keyed by list.id)
//   adapter.removeList(id)         -> Promise<void>
//
// The rest of the app only talks to this interface and never knows which backend is active.
// Everything passes through normalizeMovie() / normalizeList() before it is stored or used,
// so data from localStorage, Firestore and imported files is treated as untrusted alike.
//
// Movie ids (also the Firestore document id):
//   "603"        a TMDB movie (unchanged from v1, so existing data keeps working)
//   "tv-19885"   a TMDB TV show
//   "m-k3v9x2p1" an entry the user added by hand (mediaType "custom")

export const LOCAL_KEY = "movieTracker.library.v1";
export const LOCAL_LISTS_KEY = "movieTracker.lists.v1";

const LIMITS = { title: 300, notes: 2000, url: 2048, watchLog: 1000, emoji: 16, listName: 80, listDesc: 300, listItems: 500 };
const POSTER_PATH_RE = /^\/[A-Za-z0-9_.-]{1,200}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
export const MOVIE_ID_RE = /^(?:\d{1,12}|tv-\d{1,12}|m-[a-z0-9]{6,20})$/;
export const LIST_ID_RE = /^l-[a-z0-9]{6,20}$/;
const MEDIA_TYPES = ["movie", "tv", "custom"];

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

/** Random id like "m-k3v9x2p1q7". */
export function newId(prefix) {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return `${prefix}-${[...bytes].map((b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("")}`;
}

export function idFor(mediaType, tmdbId) {
  return mediaType === "tv" ? `tv-${tmdbId}` : String(tmdbId);
}

/** Keeps the first emoji-ish grapheme cluster (or short text) the user typed; null when empty. */
export function cleanEmoji(value) {
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (!s) return null;
  let first = s;
  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    first = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)][0]?.segment || s;
  }
  return first.slice(0, LIMITS.emoji) || null;
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
  const mediaType = MEDIA_TYPES.includes(raw.mediaType) ? raw.mediaType : "movie";

  let tmdbId = null;
  let id;
  if (mediaType === "custom") {
    id = typeof raw.id === "string" && /^m-[a-z0-9]{6,20}$/.test(raw.id) ? raw.id : null;
    if (!id) return null;
  } else {
    tmdbId = Number(raw.tmdbId);
    if (!Number.isSafeInteger(tmdbId) || tmdbId <= 0) return null;
    id = idFor(mediaType, tmdbId);
  }

  const title = typeof raw.title === "string" ? raw.title.trim().slice(0, LIMITS.title) : "";
  if (!title) return null;
  const posterPath =
    mediaType !== "custom" && typeof raw.posterPath === "string" && POSTER_PATH_RE.test(raw.posterPath) ? raw.posterPath : null;
  const watchLog = (Array.isArray(raw.watchLog) ? raw.watchLog : [])
    .map(normalizeEntry)
    .filter(Boolean)
    .slice(0, LIMITS.watchLog);
  sortLog(watchLog);
  const meta = normalizeMeta(raw);
  // Hand-made entries have nothing to fetch; mark their meta as settled.
  if (mediaType === "custom" && meta.genres === null) meta.genres = [];
  return {
    id,
    mediaType,
    tmdbId,
    title,
    posterPath,
    customPosterUrl: httpsUrlOrNull(raw.customPosterUrl),
    emoji: cleanEmoji(raw.emoji),
    inWatchlist: raw.inWatchlist === true,
    addedDate: isValidDate(raw.addedDate) ? raw.addedDate : todayISO(),
    watchLog,
    ...meta,
  };
}

/**
 * Optional facts used by the stats page. null = not fetched yet (the app backfills it).
 * genres: TMDB genre ids · releaseYear: e.g. 2014 · runtime: minutes (movies only).
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

/** Clean List object, or null. Items are movie ids, in order, deduplicated. */
export function normalizeList(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.id !== "string" || !LIST_ID_RE.test(raw.id)) return null;
  const name = typeof raw.name === "string" ? raw.name.trim().slice(0, LIMITS.listName) : "";
  if (!name) return null;
  const items = [...new Set((Array.isArray(raw.items) ? raw.items : []).filter((x) => typeof x === "string" && MOVIE_ID_RE.test(x)))]
    .slice(0, LIMITS.listItems);
  return {
    id: raw.id,
    name,
    emoji: cleanEmoji(raw.emoji),
    description: typeof raw.description === "string" ? raw.description.trim().slice(0, LIMITS.listDesc) : "",
    ranked: raw.ranked === true,
    items,
    createdDate: isValidDate(raw.createdDate) ? raw.createdDate : todayISO(),
  };
}

// ---------- import / export / merge ----------

export function buildExport(movies, lists = []) {
  return {
    app: "movie-tracker",
    version: 2,
    exportedAt: new Date().toISOString(),
    movies: movies.map(normalizeMovie).filter(Boolean),
    lists: lists.map(normalizeList).filter(Boolean),
  };
}

/** Accepts our export object (v1 or v2) or a bare array of movies. Returns { movies, lists, skipped }. */
export function parseImport(json) {
  const list = Array.isArray(json) ? json : json && Array.isArray(json.movies) ? json.movies : null;
  if (!list) throw new Error("File doesn't look like a movie-tracker export.");
  const seen = new Map();
  let skipped = 0;
  for (const raw of list) {
    const m = normalizeMovie(raw);
    if (!m) { skipped++; continue; }
    seen.set(m.id, seen.has(m.id) ? mergeMovie(seen.get(m.id), m) : m);
  }
  const lists = (json && Array.isArray(json.lists) ? json.lists : []).map(normalizeList).filter(Boolean);
  return { movies: [...seen.values()], lists, skipped };
}

const entryKey = (e) => `${e.date}|${e.rating ?? ""}|${e.notes}`;

/** Merges two records for the same title without losing any watch or status. */
export function mergeMovie(a, b) {
  const log = [...a.watchLog];
  const keys = new Set(log.map(entryKey));
  for (const e of b.watchLog) if (!keys.has(entryKey(e))) { log.push(e); keys.add(entryKey(e)); }
  return {
    ...a,
    title: a.title || b.title,
    posterPath: a.posterPath || b.posterPath,
    customPosterUrl: a.customPosterUrl || b.customPosterUrl,
    emoji: a.emoji || b.emoji,
    inWatchlist: a.inWatchlist || b.inWatchlist,
    addedDate: a.addedDate < b.addedDate ? a.addedDate : b.addedDate,
    watchLog: sortLog(log).slice(0, LIMITS.watchLog),
    genres: a.genres ?? b.genres ?? null,
    releaseYear: a.releaseYear ?? b.releaseYear ?? null,
    runtime: a.runtime ?? b.runtime ?? null,
  };
}

function mergeList(a, b) {
  return { ...a, items: [...new Set([...a.items, ...b.items])].slice(0, LIMITS.listItems) };
}

/**
 * Applies incoming movies (and lists) to an adapter. Used by JSON import AND the first-login
 * local→cloud merge, so both behave identically.
 * mode: "merge" (union with existing) or "replace" (wipe existing first).
 */
export async function applyImport(adapter, existing, incoming, mode = "merge", existingLists = [], incomingLists = []) {
  const byId = new Map(existing.map((m) => [m.id, m]));
  const listsById = new Map(existingLists.map((l) => [l.id, l]));
  if (mode === "replace") {
    await inChunks(existing, (m) => adapter.removeMovie(m.id));
    await inChunks(existingLists, (l) => adapter.removeList(l.id));
    byId.clear();
    listsById.clear();
  }
  let added = 0, merged = 0;
  await inChunks(incoming, async (m) => {
    const cur = byId.get(m.id);
    if (cur) {
      await adapter.updateMovie(mergeMovie(cur, m));
      merged++;
    } else {
      await adapter.addMovie(m);
      added++;
    }
  });
  await inChunks(incomingLists, async (l) => {
    const cur = listsById.get(l.id);
    await adapter.saveList(cur ? mergeList(cur, l) : l);
  });
  return { added, merged, lists: incomingLists.length };
}

async function inChunks(items, fn, size = 20) {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(fn));
  }
}

// ---------- adapter: localStorage ----------

function readJSON(key) {
  try { return JSON.parse(localStorage.getItem(key) || "null"); } catch { return null; }
}

function readLocal() {
  const parsed = readJSON(LOCAL_KEY);
  const list = parsed && typeof parsed.movies === "object" ? Object.values(parsed.movies) : [];
  return list.map(normalizeMovie).filter(Boolean);
}

function writeLocal(movies) {
  const out = { version: 2, movies: {} };
  for (const m of movies) out.movies[m.id] = m;
  localStorage.setItem(LOCAL_KEY, JSON.stringify(out));
}

function readLocalLists() {
  const parsed = readJSON(LOCAL_LISTS_KEY);
  return (parsed && Array.isArray(parsed.lists) ? parsed.lists : []).map(normalizeList).filter(Boolean);
}

function writeLocalLists(lists) {
  localStorage.setItem(LOCAL_LISTS_KEY, JSON.stringify({ version: 1, lists }));
}

export const localStorageAdapter = {
  name: "local",
  async getMovies() {
    return readLocal();
  },
  async addMovie(movie) {
    const m = normalizeMovie(movie);
    if (!m) throw new Error("Invalid movie");
    writeLocal([...readLocal().filter((x) => x.id !== m.id), m]);
  },
  async updateMovie(movie) {
    return this.addMovie(movie);
  },
  async removeMovie(id) {
    writeLocal(readLocal().filter((x) => x.id !== id));
  },
  async getLists() {
    return readLocalLists();
  },
  async saveList(list) {
    const l = normalizeList(list);
    if (!l) throw new Error("Invalid list");
    const all = readLocalLists();
    const i = all.findIndex((x) => x.id === l.id);
    if (i >= 0) all[i] = l; else all.push(l);
    writeLocalLists(all);
  },
  async removeList(id) {
    writeLocalLists(readLocalLists().filter((x) => x.id !== id));
  },
};

export function localLibraryCount() {
  return readLocal().length;
}

// ---------- adapter: Firestore (users/{uid}/movies/{id}, users/{uid}/lists/{id}) ----------

/**
 * fb = { db, collection, doc, getDocs, setDoc, deleteDoc } from firebase-init.js.
 * The SDK is passed in so this module never imports Firebase itself.
 */
export function createFirestoreAdapter(fb, uid) {
  const col = (name) => fb.collection(fb.db, "users", uid, name);
  const ref = (name, id) => fb.doc(fb.db, "users", uid, name, String(id));

  // The document id is the movie id, so `id` isn't stored. Optional fields are left out while
  // empty, so a plain movie document keeps exactly its original v1 shape.
  const toDoc = (m, withMeta) => {
    const d = { ...m };
    delete d.id;
    if (d.mediaType === "movie") delete d.mediaType;
    if (d.tmdbId === null) delete d.tmdbId;
    if (d.emoji === null) delete d.emoji;
    for (const k of META_KEYS) if (!withMeta || d[k] === null) delete d[k];
    return d;
  };

  return {
    name: "firestore",
    metaBlocked: false, // true once the rules have rejected meta fields: stop sending them
    async getMovies() {
      const snap = await fb.getDocs(col("movies"));
      return snap.docs.map((d) => normalizeMovie({ ...d.data(), id: d.id })).filter(Boolean);
    },
    async addMovie(movie) {
      const m = normalizeMovie(movie);
      if (!m) throw new Error("Invalid movie");
      const hasAnyMeta = META_KEYS.some((k) => m[k] !== null && !(k === "genres" && m.mediaType === "custom"));
      if (!hasAnyMeta || this.metaBlocked) return fb.setDoc(ref("movies", m.id), toDoc(m, false));
      try {
        await fb.setDoc(ref("movies", m.id), toDoc(m, true));
      } catch (err) {
        if (err?.code !== "permission-denied" || m.mediaType !== "movie") throw err;
        // Rules predate the stats fields: save without them and remember.
        this.metaBlocked = true;
        await fb.setDoc(ref("movies", m.id), toDoc(m, false));
      }
    },
    async updateMovie(movie) {
      return this.addMovie(movie);
    },
    async removeMovie(id) {
      await fb.deleteDoc(ref("movies", id));
    },
    async getLists() {
      try {
        const snap = await fb.getDocs(col("lists"));
        return snap.docs.map((d) => normalizeList({ ...d.data(), id: d.id })).filter(Boolean);
      } catch (err) {
        if (err?.code === "permission-denied") { this.listsBlocked = true; return []; }
        throw err;
      }
    },
    async saveList(list) {
      const l = normalizeList(list);
      if (!l) throw new Error("Invalid list");
      const d = { ...l };
      delete d.id;
      if (d.emoji === null) delete d.emoji;
      await fb.setDoc(ref("lists", l.id), d);
    },
    async removeList(id) {
      await fb.deleteDoc(ref("lists", id));
    },
  };
}
