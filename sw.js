// Service worker: lets the app open and run without a connection.
//
//   page (navigation)            network first (3 s), saved copy when offline → updates arrive at once
//   app files on this site        saved copy at once, refreshed in the background
//   fonts, Firebase SDK           saved copy (they're versioned and never change)
//   TMDB posters                  saved copy, up to 400 images
//   everything else               not touched (Firestore, Auth and TMDB API go straight to the network)
//
// The deploy workflow replaces __BUILD__ with the commit, so each release starts clean caches.

const VERSION = "__BUILD__";
const APP_CACHE = `late-show-app-${VERSION}`;
const IMG_CACHE = "late-show-posters-v1";
const MAX_IMAGES = 400;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(APP_CACHE).then((c) => c.addAll(["./", "./index.html", "./manifest.webmanifest"]).catch(() => {})));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith("late-show-app-") && key !== APP_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (req.mode === "navigate") {
    event.respondWith(networkFirst(req, APP_CACHE, 3000));
  } else if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(req, APP_CACHE));
  } else if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com"
    || (url.hostname === "www.gstatic.com" && url.pathname.startsWith("/firebasejs/"))) {
    event.respondWith(cacheFirst(req, APP_CACHE));
  } else if (url.hostname === "image.tmdb.org") {
    event.respondWith(posterCache(req));
  }
});

async function networkFirst(req, cacheName, timeoutMs) {
  const cache = await caches.open(cacheName);
  try {
    const res = await Promise.race([
      fetch(req),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
    ]);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    return (await cache.match(req, { ignoreSearch: true })) || (await cache.match("./index.html")) || Response.error();
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const fresh = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
  return cached || (await fresh) || Response.error();
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res.ok || res.type === "opaque") cache.put(req, res.clone());
  return res;
}

async function posterCache(req) {
  const cache = await caches.open(IMG_CACHE);
  const cached = await cache.match(req.url);
  if (cached) return cached;
  let res;
  try {
    // CORS fetch so the stored copy isn't an opaque (oversized) response.
    res = await fetch(req.url, { mode: "cors", credentials: "omit" });
  } catch {
    try { res = await fetch(req); } catch { return Response.error(); }
  }
  if (res.ok) {
    await cache.put(req.url, res.clone());
    trim(cache);
  }
  return res;
}

async function trim(cache) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX_IMAGES; i++) await cache.delete(keys[i]);
}
