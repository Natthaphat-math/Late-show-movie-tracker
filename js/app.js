// App entry: state, rendering and event wiring.

import {
  localStorageAdapter, createFirestoreAdapter, normalizeMovie, posterUrl, todayISO,
  isValidDate, httpsUrlOrNull, buildExport, parseImport, applyImport, localLibraryCount, hasMeta,
  newId, normalizeList, cleanEmoji,
} from "./storage.js";
import { listShelf, listDetail } from "./lists.js";
import { listForm, listPicker, customForm } from "./sheets.js";
import { initSearch, searchMovies, isAbort, fetchMovieMeta } from "./search.js";
import { tasteProfile, genreName } from "./stats.js";
import {
  h, icon, posterSlot, setSlotImage, libraryCard, searchCard, emptyState, statusLeds,
  miniMeter, ratingInput, crtTv, toast, choose,
} from "./ui.js";
import * as fire from "./firebase-init.js";
import { initBatch, openBatch } from "./batch.js";

const $ = (sel) => document.querySelector(sel);
const THEME_KEY = "movieTracker.theme";
const MERGED_KEY = (uid) => `movieTracker.mergedLocal.${uid}`;
const THEMES = ["marquee", "matinee", "arcade", "drivein"];

const state = {
  config: { TMDB_READ_TOKEN: null, OWNER_EMAIL: null, FIREBASE_CONFIG: null },
  adapter: localStorageAdapter,
  movies: new Map(),
  view: "watchlist",
  sort: { watchlist: "added", watched: "recent" },
  search: { query: "", results: [], loading: false, error: null },
  drawer: null, // { id } or { pending: movie }
  posterEditId: null,
  owner: null,  // signed-in owner user
  review: null, // { queue: [{ id, rating }], i } — one-by-one detail pass after batch add
  editing: null, // { id, idx } — watch entry being edited in the drawer
  genre: null,   // TMDB genre id filtering the Watched grid (set from the Stats page)
  lists: [],     // custom lists, in creation order
  listId: null,  // list open in the Lists view (null = the shelf)
  busy: false,
};

// ---------------------------------------------------------------- boot

boot();

async function boot() {
  applyTheme(readPref(THEME_KEY) || "marquee");
  try {
    state.config = { ...state.config, ...(await import("./config.js")) };
  } catch {
    showBanner("No js/config.js found — copy js/config.example.js to js/config.js and add your TMDB token. Library features still work.");
  }
  tmdbReady = initSearch(state.config.TMDB_READ_TOKEN);
  if (!tmdbReady) {
    $("#q").placeholder = "Add a TMDB token in js/config.js to search";
  }
  wireEvents();
  initBatch({ getMovie: (id) => state.movies.get(id), getLists: () => state.lists, apply: applyBatch, startReview });
  await useAdapter(localStorageAdapter);

  if (ownerModeAvailable()) {
    $("#owner-btn").hidden = false;
    if (fire.shouldAutoLoadFirebase()) startFirebase().catch(firebaseFailed);
  }
}

function ownerModeAvailable() {
  const { FIREBASE_CONFIG, OWNER_EMAIL } = state.config;
  return Boolean(FIREBASE_CONFIG && OWNER_EMAIL && OWNER_EMAIL.includes("@"));
}

// ---- cloud save indicator: counts Firestore writes still waiting for the server.
let pendingWrites = 0;

function track(promise) {
  pendingWrites++;
  renderSync();
  return promise.finally(() => { pendingWrites--; renderSync(); });
}

/** Wraps the Firestore adapter so every write shows on the owner pill until the server confirms it. */
function withSyncTracking(adapter) {
  if (adapter.name !== "firestore" || adapter.tracked) return adapter;
  return {
    name: adapter.name,
    tracked: true,
    get metaBlocked() { return adapter.metaBlocked; },
    getMovies: () => adapter.getMovies(),
    addMovie: (m) => track(adapter.addMovie(m)),
    updateMovie: (m) => track(adapter.updateMovie(m)),
    removeMovie: (id) => track(adapter.removeMovie(id)),
    getLists: () => adapter.getLists(),
    saveList: (l) => track(adapter.saveList(l)),
    removeList: (id) => track(adapter.removeList(id)),
    get listsBlocked() { return adapter.listsBlocked; },
  };
}

function renderSync() {
  const btn = $("#owner-btn");
  if (btn.dataset.mode !== "on") return;
  const busy = pendingWrites > 0;
  btn.dataset.sync = busy ? "busy" : "idle";
  btn.querySelector(".owner-label").textContent = busy ? "Saving…" : "Owner";
  btn.title = busy ? "Saving to the cloud — keep the app open" : `Signed in as ${state.owner?.email || "owner"} · all changes saved`;
}

async function useAdapter(adapter) {
  adapter = withSyncTracking(adapter);
  state.adapter = adapter;
  const list = await adapter.getMovies();
  state.movies = new Map(list.map((m) => [m.id, m]));
  state.lists = await adapter.getLists().catch((err) => { console.warn("Couldn't load lists", err); return []; });
  if (state.listId && !state.lists.some((l) => l.id === state.listId)) state.listId = null;
  $("#storage-note").textContent = adapter.name === "firestore" ? "Synced to owner cloud" : "Saved in this browser";
  metaTried.clear();
  render();
  backfillMeta();
}

// ---- genres / year / runtime for the stats page, fetched quietly in the background.
const metaTried = new Set();
let backfilling = false;
let tmdbReady = false;

function metaPending() {
  return [...state.movies.values()].filter((m) => !hasMeta(m) && !metaTried.has(m.id)).length;
}

async function backfillMeta() {
  if (backfilling || !tmdbReady) return;
  backfilling = true;
  try {
    for (;;) {
      const todo = [...state.movies.values()].filter((m) => !hasMeta(m) && !metaTried.has(m.id)).slice(0, 3);
      if (!todo.length) break;
      await Promise.all(todo.map(async (m) => {
        metaTried.add(m.id);
        try {
          const meta = await fetchMovieMeta(m);
          const cur = state.movies.get(m.id);
          if (!cur) return;
          const next = normalizeMovie({ ...cur, ...meta });
          await state.adapter.updateMovie(next);
          state.movies.set(next.id, next);
        } catch (err) {
          console.warn("Couldn't fetch details for", m.id, err);
        }
      }));
      if (state.view === "stats" && !state.search.query) render({ drawer: false });
    }
  } finally {
    backfilling = false;
    if (state.view === "stats" && !state.search.query) render({ drawer: false });
  }
}

// ---------------------------------------------------------------- owner / Firebase

let firebaseStarted = null;

function startFirebase() {
  if (firebaseStarted) return firebaseStarted;
  setOwnerButton("loading");
  firebaseStarted = (async () => {
    await fire.loadFirebase(state.config.FIREBASE_CONFIG);
    fire.onOwnerAuth(handleAuth);
    await fire.completeLinkSignIn(askEmailForLink).catch((err) => {
      toast(`Sign-in link failed: ${friendlyAuthError(err)}`, "error");
    });
  })();
  return firebaseStarted;
}

function firebaseFailed(err) {
  console.error(err);
  firebaseStarted = null;
  setOwnerButton("off");
  toast("Couldn't reach Firebase. Staying in local mode.", "error");
}

async function handleAuth(user) {
  const ownerEmail = state.config.OWNER_EMAIL.toLowerCase();
  if (user && (user.email || "").toLowerCase() === ownerEmail && user.emailVerified) {
    state.owner = user;
    fire.markOwnerDevice(true);
    setOwnerButton("on");
    if ($("#signin-dialog").open) $("#signin-dialog").close();
    const fb = await fire.loadFirebase(state.config.FIREBASE_CONFIG);
    try {
      await useAdapter(createFirestoreAdapter(fb, user.uid));
    } catch (err) {
      console.error(err);
      toast("Firestore refused access — check your security rules.", "error");
      return;
    }
    await offerLocalMerge(user.uid);
  } else {
    if (user) {
      // Someone signed in with a non-owner email. Rules would block them anyway.
      await fire.signOutOwner();
      toast("That account isn't the owner. Staying in local mode.", "error");
    }
    const wasOwner = Boolean(state.owner);
    state.owner = null;
    fire.markOwnerDevice(false);
    setOwnerButton("off");
    if (wasOwner || state.adapter.name !== "local") await useAdapter(localStorageAdapter);
  }
}

async function offerLocalMerge(uid) {
  if (readPref(MERGED_KEY(uid))) return;
  const count = localLibraryCount();
  if (!count) { writePref(MERGED_KEY(uid), "1"); return; }
  const choice = await choose({
    kicker: "First sign-in",
    title: `Merge ${count} local movie${count === 1 ? "" : "s"} into your cloud library?`,
    text: "This browser has a library saved locally. Merging combines it with your Firestore library — watch histories are joined, nothing is deleted. The local copy stays untouched.",
    buttons: [{ label: "Keep separate", value: "skip" }, { label: "Merge into cloud", value: "merge", kind: "hero" }],
  });
  if (!choice) return; // Esc: ask again next time
  writePref(MERGED_KEY(uid), "1");
  if (choice !== "merge") return;
  const local = await localStorageAdapter.getMovies();
  await runImport(local, "merge", await localStorageAdapter.getLists());
}

function setOwnerButton(mode) {
  const btn = $("#owner-btn");
  btn.dataset.mode = mode;
  const label = btn.querySelector(".owner-label");
  label.textContent = mode === "on" ? "Owner" : mode === "loading" ? "Linking…" : "Local";
  btn.setAttribute("aria-label", mode === "on" ? "Signed in as owner — sign out" : "Local mode — owner sign-in");
  btn.title = mode === "on" ? `Signed in as ${state.owner?.email || "owner"}` : "Data saved in this browser. Owner? Sign in.";
  if (mode === "on") renderSync(); else delete btn.dataset.sync;
}

async function onOwnerButton() {
  if (state.owner) {
    const c = await choose({
      kicker: "Owner",
      title: "Sign out?",
      text: "You'll switch back to this browser's local library. Your cloud library stays safe in Firestore.",
      buttons: [{ label: "Cancel", value: "no" }, { label: "Sign out", value: "yes", kind: "hero" }],
    });
    if (c === "yes") await fire.signOutOwner();
    return;
  }
  try {
    await startFirebase();
  } catch (err) {
    firebaseFailed(err);
    return;
  }
  $("#signin-hint").textContent = "We'll email a one-time sign-in link. No password.";
  $("#signin-hint").className = "hint";
  if (!$("#signin-email").value) $("#signin-email").value = fire.storedSignInEmail();
  $("#paste-url").value = "";
  $("#paste-hint").hidden = true;
  if (!fire.isStandaloneApp()) {
    $("#paste-form .micro").textContent = "Link opened somewhere else?";
    $("#paste-help").textContent = "If you opened the email on another device or browser, copy the sign-in link from it and paste it here to sign in on this one.";
  }
  $("#signin-dialog").showModal();
}

async function onPasteSubmit(e) {
  e.preventDefault();
  const hint = $("#paste-hint");
  const say = (text, kind) => { hint.textContent = text; hint.className = `hint hint-${kind}`; hint.hidden = false; };
  const email = $("#signin-email").value.trim();
  const link = $("#paste-url").value.trim();
  if (email.toLowerCase() !== state.config.OWNER_EMAIL.toLowerCase()) { say("Enter the owner email in the field above first.", "warn"); return; }
  let url = null;
  try { url = new URL(link); } catch {}
  if (!url || url.protocol !== "https:") { say("Paste the full https:// link from the email.", "warn"); return; }
  const btn = $("#paste-go");
  btn.disabled = true;
  try {
    await startFirebase();
    await fire.signInWithPastedLink(email, url.href);
    say("Signed in.", "ok");
  } catch (err) {
    say(`Couldn't sign in: ${friendlyAuthError(err)}`, "warn");
  } finally {
    btn.disabled = false;
  }
}

async function onSignInSubmit(e) {
  e.preventDefault();
  const email = $("#signin-email").value.trim();
  const hint = $("#signin-hint");
  if (email.toLowerCase() !== state.config.OWNER_EMAIL.toLowerCase()) {
    hint.textContent = "Owner sign-in only. There's no public sign-up — your library is saved in this browser.";
    hint.className = "hint hint-warn";
    return;
  }
  const btn = $("#signin-send");
  btn.disabled = true;
  try {
    await fire.sendOwnerLink(email);
    hint.textContent = "Link sent. Open it on this device to finish signing in.";
    hint.className = "hint hint-ok";
  } catch (err) {
    hint.textContent = `Couldn't send link: ${friendlyAuthError(err)}`;
    hint.className = "hint hint-warn";
  } finally {
    btn.disabled = false;
  }
}

function askEmailForLink() {
  // Link opened on a different device/browser than the one that requested it.
  return Promise.resolve(window.prompt("Confirm your owner email to finish signing in:") || null);
}

function friendlyAuthError(err) {
  const code = err?.code || "";
  if (code === "app/not-a-signin-link") return err.message;
  if (code.includes("are-blocked")) return "your Firebase API key's API restrictions block this. In Google Cloud → Credentials, allow Identity Toolkit API and Token Service API.";
  if (code.includes("referer") || code.includes("referrer")) return "your Firebase API key doesn't allow this website. Add it under Website restrictions in Google Cloud → Credentials.";
  if (code.includes("invalid-action-code")) return "the link is expired or already used.";
  if (code.includes("unauthorized-continue-uri") || code.includes("unauthorized-domain")) return "this domain isn't in Firebase Auth → Authorized domains.";
  if (code.includes("operation-not-allowed")) return "Email link sign-in isn't enabled in Firebase Auth.";
  if (code.includes("invalid-email")) return "email mismatch.";
  return err?.message || "unknown error";
}

// ---------------------------------------------------------------- data mutations

async function saveMovie(movie, { isNew = false } = {}) {
  const m = normalizeMovie(movie);
  if (!m) throw new Error("Invalid movie data");
  try {
    if (isNew) await state.adapter.addMovie(m);
    else await state.adapter.updateMovie(m);
  } catch (err) {
    console.error(err);
    toast(state.adapter.name === "firestore" ? "Cloud save failed — check your connection or rules." : "Couldn't save (browser storage full or blocked).", "error");
    throw err;
  }
  state.movies.set(m.id, m);
  render();
  if (!hasMeta(m)) backfillMeta();
  return m;
}

async function deleteMovie(id) {
  try {
    await state.adapter.removeMovie(id);
  } catch (err) {
    toast("Couldn't remove movie.", "error");
    throw err;
  }
  state.movies.delete(id);
  // Drop it from any list that referenced it.
  for (const l of state.lists.filter((x) => x.items.includes(id))) {
    await saveList({ ...l, items: l.items.filter((x) => x !== id) }).catch(() => {});
  }
  render();
}

/** A fresh library entry from a TMDB search result. */
function fromResult(r, extra = {}) {
  return normalizeMovie({
    mediaType: r.mediaType, tmdbId: r.tmdbId, title: r.title, posterPath: r.posterPath,
    customPosterUrl: null, inWatchlist: false, addedDate: todayISO(), watchLog: [], ...extra,
  });
}

function resultById(id) {
  return state.search.results.find((r) => r.id === id);
}

async function addToWatchlist(id) {
  const existing = state.movies.get(id);
  if (existing) {
    await saveMovie({ ...existing, inWatchlist: true });
  } else {
    const r = resultById(id);
    if (!r) return;
    await saveMovie(fromResult(r, { inWatchlist: true }), { isNew: true });
  }
  toast("Added to watchlist");
}

// ---------------------------------------------------------------- rendering

const VIEW_META = {
  watchlist: { kicker: "Channel 01", title: "Watchlist" },
  watched: { kicker: "Channel 02", title: "Watched" },
  stats: { kicker: "Channel 03", title: "Stats" },
  lists: { kicker: "Channel 04", title: "Lists" },
};

const SORTS = {
  watchlist: [["added", "Newest"], ["title", "A–Z"]],
  watched: [["recent", "Recent"], ["count", "Most watched"], ["rating", "Rating"], ["title", "A–Z"]],
};

function lastEntry(m) { return m.watchLog[m.watchLog.length - 1]; }
function latestRating(m) {
  for (let i = m.watchLog.length - 1; i >= 0; i--) if (m.watchLog[i].rating) return m.watchLog[i].rating;
  return 0;
}

function listFor(view) {
  const all = [...state.movies.values()];
  const byTitle = (a, b) => a.title.localeCompare(b.title);
  if (view === "watchlist") {
    const list = all.filter((m) => m.inWatchlist);
    return state.sort.watchlist === "title" ? list.sort(byTitle)
      : list.sort((a, b) => b.addedDate.localeCompare(a.addedDate) || byTitle(a, b));
  }
  const list = all.filter((m) => m.watchLog.length > 0);
  switch (state.sort.watched) {
    case "title": return list.sort(byTitle);
    case "count": return list.sort((a, b) => b.watchLog.length - a.watchLog.length || byTitle(a, b));
    case "rating": return list.sort((a, b) => latestRating(b) - latestRating(a) || byTitle(a, b));
    default: return list.sort((a, b) => (lastEntry(b).date || "").localeCompare(lastEntry(a).date || "") || byTitle(a, b));
  }
}

/** Re-renders the current view. { drawer: false } leaves an open drawer untouched (background updates). */
function render({ drawer = true } = {}) {
  const inSearch = Boolean(state.search.query);
  const counts = { watchlist: listFor("watchlist").length, watched: listFor("watched").length };
  document.querySelectorAll("[data-count]").forEach((el) => (el.textContent = counts[el.dataset.count]));
  document.querySelectorAll(".rail-btn").forEach((b) => {
    const active = !inSearch && b.dataset.view === state.view;
    b.classList.toggle("active", active);
    if (active) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  });

  const view = $("#view");
  const sortEl = $("#sort-control");

  if (inSearch) {
    $("#view-kicker").textContent = "Tuning · TMDB";
    $("#view-title").textContent = `“${state.search.query}”`;
    sortEl.hidden = true;
    view.replaceChildren(renderSearch());
  } else {
    const meta = VIEW_META[state.view];
    const openList = state.view === "lists" && state.listId ? state.lists.find((l) => l.id === state.listId) : null;
    $("#view-kicker").textContent = openList ? `${meta.kicker} · ${openList.ranked ? "Ranked list" : "List"}` : meta.kicker;
    $("#view-title").textContent = openList ? `${openList.emoji ? openList.emoji + " " : ""}${openList.name}` : meta.title;
    renderSort(sortEl);
    view.replaceChildren(
      state.view === "stats" ? renderStats()
        : state.view === "lists" ? (openList ? listDetail(openList, state.movies) : listShelf(state.lists, state.movies))
        : renderGrid(state.view));
  }
  if (drawer && state.drawer) renderDrawer();
}

function renderSort(el) {
  const opts = SORTS[state.view];
  el.hidden = !opts;
  if (!opts) return;
  el.replaceChildren(...opts.map(([value, label]) =>
    h("button", { type: "button", role: "radio", class: "seg-btn", "aria-checked": String(state.sort[state.view] === value), dataset: { sort: value }, text: label })));
}

function renderGrid(view) {
  let list = listFor(view);
  let chip = null;
  if (view === "watched" && state.genre) {
    list = list.filter((m) => m.genres?.includes(state.genre));
    chip = h("div", { class: "filter-row" },
      h("button", { type: "button", class: "filter-chip", "aria-label": `Remove ${genreName(state.genre)} filter`, onclick: () => { state.genre = null; render(); } },
        `${genreName(state.genre)} · ${list.length}`, icon("x")));
    if (!list.length) return h("div", {}, chip, emptyState("Nothing here", `No watched films tagged ${genreName(state.genre)}.`));
    return h("div", {}, chip, h("div", { class: "grid" }, list.map(libraryCard)));
  }
  if (!list.length) {
    return view === "watchlist"
      ? emptyState("Nothing queued", "Search TMDB above and add films to your watchlist.", focusSearchButton())
      : emptyState("No watches logged", "Mark a watchlist film as watched, or log one straight from search.", focusSearchButton());
  }
  return h("div", { class: "grid" }, list.map(libraryCard));
}

function focusSearchButton() {
  return h("button", { type: "button", class: "btn btn-hero", onclick: () => $("#q").focus() }, icon("search"), "Search films");
}

function renderSearch() {
  const s = state.search;
  if (s.error) return emptyState("No signal", s.error);
  if (s.loading && !s.results.length) return h("p", { class: "loading micro", text: "Tuning…" });
  const addOwn = h("button", { type: "button", class: "btn", dataset: { action: "custom-add" } }, icon("plus"), "Add it yourself");
  if (!s.results.length) return emptyState("No matches", "Try a different spelling — or add it yourself if TMDB doesn't have it.", addOwn);
  return h("div", {},
    h("div", { class: "grid" }, s.results.map((r) => searchCard(r, state.movies.get(r.id)))),
    h("div", { class: "search-foot" }, h("span", { class: "muted", text: "Can't find it?" }), addOwn));
}

function renderStats() {
  const all = [...state.movies.values()];
  const entries = all.flatMap((m) => m.watchLog.map((e) => ({ ...e, movie: m })));
  const watchedTitles = all.filter((m) => m.watchLog.length).length;
  const year = todayISO().slice(0, 4);
  const rated = entries.filter((e) => e.rating);
  const avg = rated.length ? (rated.reduce((s, e) => s + e.rating, 0) / rated.length).toFixed(1) : "—";
  const top = all.filter((m) => m.watchLog.length > 1).sort((a, b) => b.watchLog.length - a.watchLog.length)[0];
  const pad = (n) => String(n).padStart(2, "0");

  const tv = crtTv([
    ["Watchlist", pad(all.filter((m) => m.inWatchlist).length)],
    ["Films seen", pad(watchedTitles)],
    ["Total watches", pad(entries.length)],
    ["Rewatches", pad(entries.length - watchedTitles)],
    [`In ${year}`, pad(entries.filter((e) => (e.date || "").startsWith(year)).length)],
    ["Avg rating", avg],
    ["Hours watched", formatHours(all)],
    ["Most rewatched", top ? `${top.title} ×${top.watchLog.length}` : "—", true],
  ]);

  const recent = entries.sort((a, b) => (b.date || "").localeCompare(a.date || "")).slice(0, 6);
  const recentPanel = h("section", { class: "panel recent" },
    h("span", { class: "micro panel-label", text: "Recent watches" }),
    recent.length
      ? h("ol", { class: "recent-list" }, recent.map((e) =>
          h("li", {},
            h("button", { type: "button", class: "recent-item", dataset: { action: "open", id: e.movie.id } },
              h("span", { class: "mono", text: e.date || "—" }),
              h("span", { class: "recent-title", text: e.movie.title }),
              miniMeter(e.rating)))))
      : h("p", { class: "muted", text: "Nothing logged yet." }));

  const dataPanel = h("section", { class: "panel data-panel" },
    h("span", { class: "micro panel-label", text: "Library data" }),
    h("p", { class: "muted", text: state.adapter.name === "firestore" ? "Owner mode: synced to Firestore." : "Local mode: saved only in this browser. Export regularly to keep a backup." }),
    h("div", { class: "row" },
      h("button", { type: "button", class: "btn", dataset: { action: "export" } }, icon("down"), "Export JSON"),
      h("button", { type: "button", class: "btn", dataset: { action: "import" } }, icon("up"), "Import JSON")));

  const taste = tasteProfile(all, {
    pending: tmdbReady ? metaPending() : 0,
    blocked: Boolean(state.adapter.metaBlocked),
    onGenre: (id) => {
      state.genre = id;
      state.view = "watched";
      render();
      window.scrollTo({ top: 0 });
    },
  });

  return h("div", {},
    h("div", { class: "stats" }, h("div", { class: "stats-hero" }, tv), h("div", { class: "stats-side" }, recentPanel, dataPanel)),
    taste);
}

/** Runtime × watches, rewatches included. Films without a runtime yet are left out. */
function formatHours(movies) {
  const minutes = movies.reduce((sum, m) => sum + (m.runtime || 0) * m.watchLog.length, 0);
  if (!minutes) return "—";
  const hours = minutes / 60;
  return hours < 10 ? `${hours.toFixed(1)} h` : `${Math.round(hours)} h`;
}

// ---------------------------------------------------------------- batch add

/**
 * Saves batch-add choices. items: [{ id, mediaType, tmdbId, title, posterPath, action: "watchlist"|"watched", rating }].
 * Watched ones get an undated entry; they're returned in `review` for the optional detail pass.
 */
async function applyBatch(items, target = {}) {
  let added = 0, updated = 0, failed = 0;
  const review = [];
  document.body.classList.add("busy");
  for (const it of items) {
    const cur = state.movies.get(it.id);
    const base = cur || {
      id: it.id, mediaType: it.mediaType, tmdbId: it.tmdbId, title: it.title, posterPath: it.posterPath, emoji: it.emoji || null,
      releaseYear: it.mediaType === "custom" && /^\d{4}$/.test(it.year || "") ? Number(it.year) : null,
      customPosterUrl: null, inWatchlist: false, addedDate: todayISO(), watchLog: [],
    };
    const next = it.action === "watchlist"
      ? { ...base, inWatchlist: true }
      : { ...base, inWatchlist: false, watchLog: [...base.watchLog, { date: null, rating: it.rating ?? null, notes: "" }] };
    const m = normalizeMovie(next);
    try {
      if (!m) throw new Error("invalid");
      if (cur) await state.adapter.updateMovie(m); else await state.adapter.addMovie(m);
      state.movies.set(m.id, m);
      if (cur) updated++; else added++;
      if (it.action === "watched") review.push({ id: m.id, rating: it.rating ?? null });
    } catch (err) {
      console.error(err);
      failed++;
    }
  }
  document.body.classList.remove("busy");
  let listName = null;
  const savedIds = items.map((it) => it.id).filter((id) => state.movies.has(id));
  if (savedIds.length && (target.listId || target.newListName)) {
    try {
      const list = target.listId ? state.lists.find((l) => l.id === target.listId) : await createList({ name: target.newListName, emoji: "📼" });
      if (list) { await addToList(list.id, savedIds); listName = list.name; }
    } catch (err) {
      console.error(err);
      toast("Movies saved, but adding them to the list failed.", "error");
    }
  }
  render();
  backfillMeta();
  if (failed) toast(`${failed} movie${failed === 1 ? "" : "s"} couldn't be saved.`, "error");
  return { added, updated, failed, review, listName };
}

function startReview(queue) {
  if (!queue.length) return;
  state.review = { queue, i: 0 };
  openDrawer({ id: queue[0].id });
}

function reviewItem(movie) {
  const r = state.review;
  return r && r.queue[r.i]?.id === movie.id ? r.queue[r.i] : null;
}

function nextReview() {
  const r = state.review;
  r.i++;
  if (r.i >= r.queue.length) {
    state.review = null;
    $("#drawer").close();
    toast("Review done");
    return;
  }
  state.drawer = { id: r.queue[r.i].id };
  renderDrawer();
  $("#drawer").scrollTop = 0;
}

/** Replaces the undated entry batch add created with the details entered now. */
async function saveReviewEntry(movie, item, date, rating, notes) {
  if (date && !isValidDate(date)) { toast("That date isn't valid.", "error"); return; }
  const cur = state.movies.get(movie.id);
  const log = [...cur.watchLog];
  let idx = -1;
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i];
    if (e.date === null && e.notes === "" && (e.rating ?? null) === (item.rating ?? null)) { idx = i; break; }
  }
  const entry = { date: date || null, rating: rating ?? null, notes: (notes || "").trim() };
  if (idx >= 0) log[idx] = entry; else log.push(entry);
  await saveMovie({ ...cur, watchLog: log });
  nextReview();
}

// ---------------------------------------------------------------- drawer

function openDrawer(target) {
  state.drawer = target;
  renderDrawer();
  const dlg = $("#drawer");
  if (!dlg.open) dlg.showModal();
}

function drawerMovie() {
  if (!state.drawer) return null;
  if (state.drawer.pending) return state.movies.get(state.drawer.pending.id) || state.drawer.pending;
  return state.movies.get(state.drawer.id) || null;
}

function renderDrawer() {
  const movie = drawerMovie();
  const body = $("#drawer-body");
  if (!movie) { $("#drawer").close(); return; }
  const inLib = state.movies.has(movie.id);
  const n = movie.watchLog.length;
  const logId = `log-${movie.id}`;

  const ed = inLib && state.editing?.id === movie.id ? movie.watchLog[state.editing.idx] || null : null;
  const rv = inLib && !ed ? reviewItem(movie) : null;
  const rating = ratingInput(`${logId}-rating`, ed ? ed.rating : rv ? rv.rating : null);
  // Blank by default: the date is often unknown for older watches, and the picker opens on today anyway.
  const dateInput = h("input", { type: "date", id: `${logId}-date`, max: "2100-12-31" });
  if (ed?.date) dateInput.value = ed.date;
  const notes = h("textarea", { id: `${logId}-notes`, rows: 3, maxlength: 2000, placeholder: "Where, with whom, what stuck with you…" });
  if (ed) notes.value = ed.notes;

  const submit = (e) => {
    e.preventDefault();
    if (ed) saveEditedEntry(movie, state.editing.idx, dateInput.value, rating.value, notes.value).catch(() => {});
    else if (rv) saveReviewEntry(movie, rv, dateInput.value, rating.value, notes.value).catch(() => {});
    else logWatch(movie, dateInput.value, rating.value, notes.value);
  };
  const formLabel = ed ? "Edit watch" : rv ? `Add details · ${state.review.i + 1} of ${state.review.queue.length}` : n ? "Log a rewatch" : "Log a watch";
  const logForm = h("form", { class: `panel log-form${ed ? " is-editing" : ""}`, onsubmit: submit },
    h("span", { class: "micro panel-label", text: formLabel }),
    h("label", { class: "field-label", for: dateInput.id, text: "Date" }), dateInput,
    h("span", { class: "field-label", text: "Rating" }), rating.el,
    h("label", { class: "field-label", for: notes.id, text: "Notes" }), notes,
    ed
      ? h("div", { class: "review-actions" },
          h("button", { type: "button", class: "btn btn-ghost", text: "Cancel", onclick: () => { state.editing = null; renderDrawer(); } }),
          h("button", { type: "submit", class: "btn btn-hero", text: "Save changes" }))
      : rv
      ? h("div", { class: "review-actions" },
          h("button", { type: "button", class: "btn btn-ghost", text: "Skip", onclick: nextReview }),
          h("button", { type: "submit", class: "btn btn-hero" }, state.review.i + 1 < state.review.queue.length ? "Save & next →" : "Save & finish"))
      : h("button", { type: "submit", class: "btn btn-hero btn-block" }, icon("eye"), n ? "Watch again" : "Mark watched"));

  const history = h("section", { class: "screen history" },
    h("div", { class: "screen-head" },
      h("span", { class: "screen-label", text: "Watch history" }),
      h("span", { class: "screen-count", text: `×${String(n).padStart(2, "0")}` })),
    n
      ? h("ol", { class: "history-list" }, [...movie.watchLog].reverse().map((e, i) => {
          const idx = n - 1 - i;
          const when = e.date || "unknown date";
          return h("li", { class: `history-item${state.editing?.id === movie.id && state.editing.idx === idx ? " is-editing" : ""}` },
            h("div", { class: "history-row" },
              h("span", { class: "mono", text: e.date || "Date unknown" }),
              h("span", { class: "screen-tag", text: idx === 0 ? "First watch" : `Rewatch #${idx}` }),
              miniMeter(e.rating),
              h("span", { class: "history-btns" },
                h("button", { type: "button", class: "icon-btn icon-btn-screen", "aria-label": `Edit watch on ${when}`, title: "Edit", onclick: () => startEditEntry(movie, idx) }, icon("pencil")),
                h("button", { type: "button", class: "icon-btn icon-btn-screen", "aria-label": `Delete watch on ${when}`, title: "Delete", onclick: () => deleteEntry(movie, idx) }, icon("trash")))),
            e.notes ? h("p", { class: "history-notes", text: e.notes }) : null);
        }))
      : h("p", { class: "screen-empty", text: "No signal yet — log your first watch." }));

  const tmdbLink = movie.tmdbId
    ? h("a", { href: `https://www.themoviedb.org/${movie.mediaType === "tv" ? "tv" : "movie"}/${movie.tmdbId}`, target: "_blank", rel: "noopener noreferrer", class: "micro link", text: "View on TMDB ↗" })
    : h("span", { class: "micro", text: movie.releaseYear ? `Added by hand · ${movie.releaseYear}` : "Added by hand" });

  const actions = h("div", { class: "drawer-actions" });
  if (inLib) {
    actions.append(
      movie.inWatchlist
        ? h("button", { type: "button", class: "btn btn-sm", onclick: () => removeFromWatchlist(movie) }, icon("x"), "Remove from watchlist")
        : h("button", { type: "button", class: "btn btn-sm", onclick: () => addToWatchlist(movie.id) }, icon("plus"), n ? "Queue a rewatch" : "Add to watchlist"),
      h("button", { type: "button", class: "btn btn-sm btn-danger", onclick: () => removeMovie(movie) }, icon("trash"), "Remove from library"));
  }

  body.replaceChildren(...[
    h("div", { class: "drawer-head" },
      h("span", { class: "micro", text: inLib ? "Now showing" : "Not in library yet" }),
      h("button", { type: "button", class: "icon-btn", "aria-label": "Close", onclick: () => $("#drawer").close() }, icon("x"))),
    h("div", { class: "drawer-hero" },
      h("div", { class: "drawer-poster" },
        posterSlot(posterUrl(movie), { alt: `Poster for ${movie.title}`, lazy: false }),
        inLib ? h("button", { type: "button", class: "icon-btn card-edit", "aria-label": "Edit poster", title: "Edit poster", onclick: () => openPosterEditor(movie.id) }, icon("pencil")) : null),
      h("div", { class: "drawer-title-block" },
        h("h2", { id: "drawer-title", text: movie.title }),
        inLib ? statusLeds(movie) : null,
        inLib ? h("span", { class: "micro", text: `Added ${movie.addedDate}` }) : null,
        tmdbLink)),
    logForm,
    inLib ? history : null,
    listsSection(movie),
    actions].filter(Boolean));
}

function startEditEntry(movie, idx) {
  state.review = null;
  state.editing = { id: movie.id, idx };
  renderDrawer();
  $("#drawer .log-form")?.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}

async function saveEditedEntry(movie, idx, date, rating, notes) {
  if (date && !isValidDate(date)) { toast("That date isn't valid.", "error"); return; }
  const cur = state.movies.get(movie.id);
  if (!cur?.watchLog[idx]) { state.editing = null; renderDrawer(); return; }
  const watchLog = cur.watchLog.map((e, i) => i === idx ? { date: date || null, rating: rating ?? null, notes: (notes || "").trim() } : e);
  state.editing = null;
  await saveMovie({ ...cur, watchLog });
  toast("Watch updated");
}

async function logWatch(movie, date, rating, notes) {
  if (date && !isValidDate(date)) { toast("That date isn't valid.", "error"); return; }
  const isNew = !state.movies.has(movie.id);
  const base = isNew ? movie : state.movies.get(movie.id);
  const next = {
    ...base,
    inWatchlist: false,
    watchLog: [...base.watchLog, { date: date || null, rating: rating ?? null, notes: (notes || "").trim() }],
  };
  await saveMovie(next, { isNew });
  if (isNew) state.drawer = { id: movie.id };
  renderDrawer();
  toast(next.watchLog.length > 1 ? `Logged rewatch — watched ${next.watchLog.length}×` : "Marked as watched");
}

async function deleteEntry(movie, idx) {
  const cur = state.movies.get(movie.id);
  const e = cur.watchLog[idx];
  const c = await choose({
    kicker: "Watch history", title: "Delete this watch?", text: e.date ? `The entry from ${e.date} will be removed from the history.` : "This undated entry will be removed from the history.",
    buttons: [{ label: "Cancel", value: "no" }, { label: "Delete", value: "yes", kind: "danger" }],
  });
  if (c !== "yes") return;
  const watchLog = cur.watchLog.filter((_, i) => i !== idx);
  state.editing = null;
  // A film with no watches and not on the watchlist would vanish from both views, so keep it queued.
  await saveMovie({ ...cur, watchLog, inWatchlist: cur.inWatchlist || watchLog.length === 0 });
}

async function removeFromWatchlist(movie) {
  const inAList = state.lists.some((l) => l.items.includes(movie.id));
  if (movie.watchLog.length === 0 && !inAList) return removeMovie(movie);
  await saveMovie({ ...movie, inWatchlist: false });
}

async function removeMovie(movie) {
  const c = await choose({
    kicker: "Library", title: `Remove “${movie.title}”?`,
    text: movie.watchLog.length ? `This deletes it, its ${movie.watchLog.length} logged watch${movie.watchLog.length === 1 ? "" : "es"}, and removes it from any lists.` : "It will be removed from your library and any lists.",
    buttons: [{ label: "Cancel", value: "no" }, { label: "Remove", value: "yes", kind: "danger" }],
  });
  if (c !== "yes") return;
  await deleteMovie(movie.id);
  if ($("#drawer").open) $("#drawer").close();
  toast("Removed");
}

// ---------------------------------------------------------------- lists

async function saveList(list) {
  const l = normalizeList(list);
  if (!l) throw new Error("Invalid list");
  try {
    await state.adapter.saveList(l);
  } catch (err) {
    console.error(err);
    toast(err?.code === "permission-denied" ? "Lists need the updated Firestore rules — see DEPLOY.md." : "Couldn't save the list.", "error");
    throw err;
  }
  const i = state.lists.findIndex((x) => x.id === l.id);
  if (i >= 0) state.lists[i] = l; else state.lists.push(l);
  return l;
}

async function createList(fields) {
  return saveList({ id: newId("l"), items: [], createdDate: todayISO(), ...fields });
}

async function newListFlow() {
  const f = await listForm();
  if (!f) return null;
  const l = await createList(f);
  toast(`Created “${l.name}”`);
  return l;
}

async function editListFlow(id) {
  const cur = state.lists.find((l) => l.id === id);
  if (!cur) return;
  const f = await listForm(cur);
  if (!f) return;
  await saveList({ ...cur, ...f });
  render();
}

async function deleteListFlow(id) {
  const cur = state.lists.find((l) => l.id === id);
  if (!cur) return;
  const c = await choose({
    kicker: "Lists", title: `Delete “${cur.name}”?`,
    text: "Only the list is deleted — the titles stay in your library.",
    buttons: [{ label: "Cancel", value: "no" }, { label: "Delete list", value: "yes", kind: "danger" }],
  });
  if (c !== "yes") return;
  await state.adapter.removeList(id);
  state.lists = state.lists.filter((l) => l.id !== id);
  state.listId = null;
  render();
  toast("List deleted");
}

async function addToList(listId, ids) {
  const cur = state.lists.find((l) => l.id === listId);
  if (!cur) return;
  await saveList({ ...cur, items: [...cur.items, ...ids.filter((id) => !cur.items.includes(id))] });
}

async function removeFromList(listId, movieId) {
  const cur = state.lists.find((l) => l.id === listId);
  if (!cur) return;
  await saveList({ ...cur, items: cur.items.filter((x) => x !== movieId) });
  const m = state.movies.get(movieId);
  render();
  // A title that's now in no list, not queued and never watched would be invisible everywhere.
  if (m && !m.inWatchlist && !m.watchLog.length && !state.lists.some((l) => l.items.includes(movieId))) {
    const c = await choose({
      kicker: "Library", title: `Keep “${m.title}”?`,
      text: "It isn't on your watchlist, in any list, or watched.",
      buttons: [{ label: "Remove it", value: "remove", kind: "danger" }, { label: "Move to watchlist", value: "keep", kind: "hero" }],
    });
    if (c === "keep") await saveMovie({ ...m, inWatchlist: true });
    else if (c === "remove") await deleteMovie(movieId);
  }
}

async function moveInList(listId, movieId, dir) {
  const cur = state.lists.find((l) => l.id === listId);
  if (!cur) return;
  const items = [...cur.items];
  const i = items.indexOf(movieId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= items.length) return;
  [items[i], items[j]] = [items[j], items[i]];
  await saveList({ ...cur, items });
  render();
  document.querySelector(`.card[data-id="${CSS.escape(movieId)}"] [data-action="${dir < 0 ? "list-up" : "list-down"}"]`)?.focus();
}

/** Drawer section: which lists this title is in, plus "Add to list". */
function listsSection(movie) {
  const mine = state.lists.filter((l) => l.items.includes(movie.id));
  return h("section", { class: "drawer-lists" },
    h("span", { class: "micro", text: "Lists" }),
    h("div", { class: "chip-row" },
      mine.map((l) => h("button", { type: "button", class: "list-chip", onclick: () => { $("#drawer").close(); state.view = "lists"; state.listId = l.id; render(); } },
        `${l.emoji || "📼"} ${l.name}`)),
      h("button", { type: "button", class: "btn btn-xs", onclick: () => pickLists(movie) }, icon("plus"), mine.length ? "Change" : "Add to list")));
}

async function pickLists(movie) {
  const memberOf = new Set(state.lists.filter((l) => l.items.includes(movie.id)).map((l) => l.id));
  const res = await listPicker(movie.title, state.lists, memberOf);
  if (!res) return;
  // A title picked from search isn't in the library yet: save it first (not on the watchlist).
  if (!state.movies.has(movie.id)) {
    await saveMovie({ ...movie, inWatchlist: false }, { isNew: true });
    state.drawer = { id: movie.id };
  }
  if (res.newList) {
    const l = await createList(res.newList);
    res.selected.add(l.id);
  }
  for (const l of state.lists) {
    const has = l.items.includes(movie.id);
    const want = res.selected.has(l.id);
    if (want && !has) await saveList({ ...l, items: [...l.items, movie.id] });
    if (!want && has) await saveList({ ...l, items: l.items.filter((x) => x !== movie.id) });
  }
  render();
  toast(res.selected.size ? `In ${res.selected.size} list${res.selected.size === 1 ? "" : "s"}` : "Removed from lists");
}

// ---------------------------------------------------------------- add it yourself

async function addCustom(prefill = "") {
  const f = await customForm(prefill);
  if (!f) return;
  const m = normalizeMovie({
    id: newId("m"), mediaType: "custom", title: f.title, releaseYear: f.year, emoji: f.emoji,
    inWatchlist: f.action === "watchlist", addedDate: todayISO(), watchLog: [],
  });
  if (f.action === "watched") {
    openDrawer({ pending: m }); // saved when the watch is logged
    return;
  }
  await saveMovie(m, { isNew: true });
  toast(`Added “${m.title}” to your watchlist`);
}

// ---------------------------------------------------------------- poster editor

function openPosterEditor(id) {
  const movie = state.movies.get(id);
  if (!movie) return;
  state.posterEditId = id;
  $("#poster-movie").textContent = movie.title;
  const input = $("#poster-url");
  input.value = movie.customPosterUrl || "";
  $("#poster-emoji").value = movie.emoji || "";
  const preview = $("#poster-preview");
  resetPreviewFallback(movie.emoji);
  $("#poster-reset").disabled = !movie.customPosterUrl;
  updatePosterPreview();
  $("#poster-dialog").showModal();
  input.focus();
}

/** The preview's backdrop: the emoji being typed, or the film icon. */
function resetPreviewFallback(emoji) {
  const preview = $("#poster-preview");
  preview.querySelector(".poster-fallback")?.remove();
  preview.append(emoji
    ? h("div", { class: "poster-fallback poster-emoji", "aria-hidden": "true" }, h("span", { text: emoji }))
    : h("div", { class: "poster-fallback", "aria-hidden": "true" }, icon("film")));
}

/** Returns { ok, url } for the current field value and updates preview + hint. */
function updatePosterPreview() {
  const movie = state.movies.get(state.posterEditId);
  const raw = $("#poster-url").value.trim();
  const hint = $("#poster-hint");
  const save = $("#poster-save");
  const preview = $("#poster-preview");
  let ok = true, url = null;

  if (!raw) {
    hint.textContent = movie.posterPath ? "Empty = use the default TMDB poster." : "Empty = show the emoji.";
    hint.className = "hint";
    setSlotImage(preview, movie.posterPath ? `https://image.tmdb.org/t/p/w500${movie.posterPath}` : null, "Default poster preview", false);
  } else {
    let parsed = null;
    try { parsed = new URL(raw); } catch {}
    if (!parsed) {
      ok = false;
      hint.textContent = "That isn't a valid URL.";
    } else if (parsed.protocol === "http:") {
      ok = false;
      hint.textContent = "⚠ Must be https:// — browsers silently block http images on secure pages (mixed content), so this poster would never show.";
    } else if (!httpsUrlOrNull(raw)) {
      ok = false;
      hint.textContent = "Only https:// image links are allowed.";
    }
    hint.className = ok ? "hint" : "hint hint-warn";
    if (ok) {
      url = httpsUrlOrNull(raw);
      hint.textContent = "Previewing. If the image can't load, the card shows a placeholder.";
      setSlotImage(preview, url, "Custom poster preview", false);
    } else {
      setSlotImage(preview, null);
    }
  }
  save.disabled = !ok;
  return { ok, url };
}

async function savePoster(e) {
  e.preventDefault();
  const { ok, url } = updatePosterPreview();
  if (!ok) return;
  const movie = state.movies.get(state.posterEditId);
  await saveMovie({ ...movie, customPosterUrl: url, emoji: cleanEmoji($("#poster-emoji").value) });
  $("#poster-dialog").close();
  toast(url ? "Poster updated" : movie.posterPath ? "Using default poster" : "Saved");
}

async function resetPoster() {
  const movie = state.movies.get(state.posterEditId);
  await saveMovie({ ...movie, customPosterUrl: null });
  $("#poster-dialog").close();
  toast("Poster reset to TMDB default");
}

// ---------------------------------------------------------------- import / export

function exportLibrary() {
  const data = buildExport([...state.movies.values()], state.lists);
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = h("a", { href: URL.createObjectURL(blob), download: `movie-tracker-${stamp}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`Exported ${data.movies.length} titles${data.lists.length ? ` and ${data.lists.length} lists` : ""}`);
}

async function importFile(file) {
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { toast("File too large (max 5 MB).", "error"); return; }
  let incoming, incomingLists, skipped;
  try {
    ({ movies: incoming, lists: incomingLists, skipped } = parseImport(JSON.parse(await file.text())));
  } catch (err) {
    toast(err instanceof SyntaxError ? "That file isn't valid JSON." : err.message, "error");
    return;
  }
  if (!incoming.length) { toast("No valid movies found in that file.", "error"); return; }
  const mode = await choose({
    kicker: "Import",
    title: `Import ${incoming.length} movie${incoming.length === 1 ? "" : "s"}?`,
    text: `Merge combines them with your current ${state.movies.size} (watch histories are joined). Replace deletes your current library first.${skipped ? ` ${skipped} invalid entr${skipped === 1 ? "y was" : "ies were"} skipped.` : ""}`,
    buttons: [{ label: "Cancel", value: "cancel" }, { label: "Replace", value: "replace", kind: "danger" }, { label: "Merge", value: "merge", kind: "hero" }],
  });
  if (mode !== "merge" && mode !== "replace") return;
  await runImport(incoming, mode, incomingLists);
}

async function runImport(incoming, mode, incomingLists = []) {
  if (state.busy) return;
  state.busy = true;
  document.body.classList.add("busy");
  try {
    const { added, merged } = await applyImport(state.adapter, [...state.movies.values()], incoming, mode, state.lists, incomingLists);
    await useAdapter(state.adapter);
    toast(`Import done: ${added} added, ${merged} merged`);
  } catch (err) {
    console.error(err);
    toast("Import stopped partway — some movies may not have saved.", "error");
    await useAdapter(state.adapter).catch(() => {});
  } finally {
    state.busy = false;
    document.body.classList.remove("busy");
  }
}

// ---------------------------------------------------------------- search

let searchTimer = null;

function onSearchInput() {
  const q = $("#q").value.trim();
  $("#search-clear").hidden = !q;
  clearTimeout(searchTimer);
  if (!q) { exitSearch(); return; }
  searchTimer = setTimeout(() => runSearch(q), 350);
}

async function runSearch(q) {
  state.search = { ...state.search, query: q, loading: true, error: null };
  render();
  try {
    const results = await searchMovies(q);
    if ($("#q").value.trim() !== q) return;
    state.search = { query: q, results, loading: false, error: null };
  } catch (err) {
    if (isAbort(err)) return;
    state.search = { query: q, results: [], loading: false, error: err.message };
  }
  render();
}

function exitSearch() {
  clearTimeout(searchTimer);
  $("#q").value = "";
  $("#search-clear").hidden = true;
  state.search = { query: "", results: [], loading: false, error: null };
  render();
}

// ---------------------------------------------------------------- theme / prefs

function applyTheme(name) {
  const theme = THEMES.includes(name) ? name : "marquee";
  document.documentElement.dataset.theme = theme;
  // Status bar / browser chrome follows the page background.
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", getComputedStyle(document.body || document.documentElement).getPropertyValue("--bg").trim() || "#000000");
  document.querySelectorAll("[data-theme-pick]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.themePick === theme)));
  writePref(THEME_KEY, theme);
}

function readPref(k) { try { return localStorage.getItem(k); } catch { return null; } }
function writePref(k, v) { try { localStorage.setItem(k, v); } catch {} }

function showBanner(text) {
  const b = $("#banner");
  b.textContent = text;
  b.hidden = false;
}

// ---------------------------------------------------------------- events

function wireEvents() {
  $("#search-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const q = $("#q").value.trim();
    if (q) { clearTimeout(searchTimer); runSearch(q); }
  });
  $("#q").addEventListener("input", onSearchInput);
  $("#q").addEventListener("keydown", (e) => { if (e.key === "Escape") exitSearch(); });
  $("#search-clear").addEventListener("click", () => { exitSearch(); $("#q").focus(); });

  document.querySelectorAll(".rail-btn").forEach((b) => b.addEventListener("click", () => {
    state.view = b.dataset.view;
    state.genre = null;
    state.listId = null;
    if (state.search.query) exitSearch(); else render();
    $("#main").focus({ preventScroll: true });
  }));

  $("#sort-control").addEventListener("click", (e) => {
    const b = e.target.closest("[data-sort]");
    if (!b) return;
    state.sort[state.view] = b.dataset.sort;
    render();
  });

  document.querySelectorAll("[data-theme-pick]").forEach((b) => b.addEventListener("click", () => applyTheme(b.dataset.themePick)));
  $("#owner-btn").addEventListener("click", onOwnerButton);
  $("#signin-form").addEventListener("submit", onSignInSubmit);
  $("#paste-form").addEventListener("submit", onPasteSubmit);

  // Delegated actions for cards, stats and rail buttons.
  document.addEventListener("click", async (e) => {
    const el = e.target.closest("[data-action]");
    if (!el) return;
    const id = el.dataset.id;
    try {
      switch (el.dataset.action) {
        case "open": openDrawer({ id }); break;
        case "edit-poster": openPosterEditor(id); break;
        case "add-watchlist": await addToWatchlist(id); break;
        case "log-new": {
          const r = resultById(id);
          if (r) openDrawer({ pending: fromResult(r) });
          break;
        }
        case "batch": openBatch(); break;
        case "custom-add": await addCustom($("#q").value.trim()); break;
        case "list-new": { const l = await newListFlow(); if (l) { state.listId = l.id; render(); } break; }
        case "list-open": state.listId = id; render(); window.scrollTo({ top: 0 }); break;
        case "list-back": state.listId = null; render(); break;
        case "list-edit": await editListFlow(id); break;
        case "list-delete": await deleteListFlow(id); break;
        case "list-up": await moveInList(state.listId, id, -1); break;
        case "list-down": await moveInList(state.listId, id, 1); break;
        case "list-remove": await removeFromList(state.listId, id); break;
        case "export": exportLibrary(); break;
        case "import": $("#import-file").click(); break;
      }
    } catch (err) {
      console.error(err);
    }
  });

  $("#import-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    await importFile(file);
  });

  let posterTimer = null;
  $("#poster-url").addEventListener("input", () => { clearTimeout(posterTimer); posterTimer = setTimeout(updatePosterPreview, 250); });
  $("#poster-emoji").addEventListener("input", () => resetPreviewFallback(cleanEmoji($("#poster-emoji").value)));
  $("#poster-form").addEventListener("submit", (e) => savePoster(e).catch(() => {}));
  $("#poster-reset").addEventListener("click", () => resetPoster().catch(() => {}));

  $("#drawer").addEventListener("close", () => { state.drawer = null; state.review = null; state.editing = null; });

  // Close dialogs on [data-close] buttons and on backdrop clicks.
  document.querySelectorAll("dialog").forEach((dlg) => {
    dlg.addEventListener("click", (e) => {
      if (e.target.closest("[data-close]") || e.target === dlg) dlg.close();
    });
  });
}
