// My streaming services: the subscriptions you have, and which library titles stream on them.
//
// Settings holds the chosen provider ids (synced). Everything else is a cache on this device:
//   catalog       every streaming service TMDB lists for your country (refreshed weekly)
//   availability  per title, the services it streams on in your country (refreshed every 3 days)
// Availability comes from TMDB's watch/providers (JustWatch data), the same as "Where to watch".

import { fetchServiceCatalog, fetchProviders } from "./search.js";

const CATALOG_KEY = "movieTracker.serviceCatalog.v1";
const AVAIL_KEY = "movieTracker.availability.v1";
const CATALOG_TTL = 7 * 86400000;
const AVAIL_TTL = 3 * 86400000;
const MAX_TITLES = 400;

function read(key) {
  try { return JSON.parse(localStorage.getItem(key) || "null"); } catch { return null; }
}
function write(key, v) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch {}
}

// ---------------------------------------------------------------- catalog

let catalogLoad = null;

/** The cached service list for a region, or null. */
export function catalogFor(region) {
  const c = read(CATALOG_KEY);
  return c && c.region === region && Array.isArray(c.list) ? c.list : null;
}

/** Loads (or refreshes) the service list for a region. Resolves to the list. */
export function loadCatalog(region) {
  const c = read(CATALOG_KEY);
  if (c && c.region === region && Array.isArray(c.list) && Date.now() - c.at < CATALOG_TTL) return Promise.resolve(c.list);
  if (catalogLoad?.region === region) return catalogLoad.p;
  const p = fetchServiceCatalog(region)
    .then((list) => { write(CATALOG_KEY, { region, at: Date.now(), list }); return list; })
    .finally(() => { if (catalogLoad?.p === p) catalogLoad = null; });
  catalogLoad = { region, p };
  return p;
}

// ---------------------------------------------------------------- availability

let avail = null;

function store(region) {
  if (!avail) avail = read(AVAIL_KEY);
  if (!avail || avail.region !== region || typeof avail.items !== "object" || !avail.items) avail = { region, items: {} };
  return avail;
}

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const s = avail;
    if (!s) return;
    const ids = Object.keys(s.items);
    if (ids.length > MAX_TITLES) {
      ids.sort((a, b) => s.items[a].at - s.items[b].at).slice(0, ids.length - MAX_TITLES).forEach((id) => delete s.items[id]);
    }
    write(AVAIL_KEY, s);
  }, 300);
}

/** Records a Where-to-watch result: the services a title streams on (free/ads count too). */
export function recordAvailability(id, region, data) {
  const s = store(region);
  s.items[id] = { at: Date.now(), s: (data?.stream || []).map((p) => ({ id: p.id, name: p.name, logo: p.logo })) };
  persist();
}

/** The services a title streams on in this region (cached), or undefined if unknown/stale. */
export function availabilityOf(id, region) {
  const it = store(region).items[id];
  return it && Date.now() - it.at < AVAIL_TTL ? it.s : undefined;
}

/** The subset of a title's services that you have. undefined = not checked yet. */
export function onMyServices(id, region, mine) {
  const list = availabilityOf(id, region);
  if (list === undefined) return undefined;
  const set = new Set(mine);
  return list.filter((p) => set.has(p.id));
}

let running = false;

/**
 * Checks titles whose availability is unknown or stale, 4 at a time, in the background.
 * Calls onDone() once if anything changed.
 */
export async function refreshAvailability(movies, region, onDone) {
  if (running || !region || (typeof navigator !== "undefined" && navigator.onLine === false)) return;
  const todo = movies.filter((m) => m.mediaType !== "custom" && m.tmdbId && availabilityOf(m.id, region) === undefined);
  if (!todo.length) return;
  running = true;
  let changed = false;
  try {
    const queue = [...todo];
    const worker = async () => {
      while (queue.length) {
        const m = queue.shift();
        try {
          recordAvailability(m.id, region, await fetchProviders(m, region));
          changed = true;
        } catch (err) {
          console.warn("Availability check failed", m.title, err);
        }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
  } finally {
    running = false;
  }
  if (changed) onDone?.();
}
