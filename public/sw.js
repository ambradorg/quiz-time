/*
 * QuizTime service worker — offline-first app shell + background sync.
 *
 * What it does, in order of importance:
 *
 *   1. App shell: navigations and build assets are cached so an installed
 *      QuizTime opens with no network at all (the page itself then renders
 *      from the IndexedDB snapshots kept by src/lib/offline.ts).
 *   2. Cached session: `/api/auth/session` is the one API route Auth.js
 *      fetches by itself, so it is cached here — that is what lets
 *      "open my account offline" work without changes to Auth.js.
 *   3. Background sync: study answers, review grades and progress writes that
 *      couldn't be delivered are queued in IndexedDB by the app and replayed
 *      here — even if the tab was closed in between.
 *
 * Update-friendly by design (kept from v1): navigations are network-first so
 * installed apps get every deploy, `/_next/static/*` is cache-first (hashed
 * and immutable), old caches are purged on activate, and `skipWaiting` +
 * `clients.claim` make a new version take over immediately.
 *
 * `?dev=1` (used by src/components/register-sw.tsx in development) keeps the
 * shell cacheable for offline testing but never lets a cached asset win over
 * the dev server, so a stale bundle can't confuse local work.
 *
 * ⚠️ Contract with the app: the IndexedDB database/store names, the queued
 * write shape and the batching rules below are mirrored in
 * src/lib/offline-core.ts (`OFFLINE_DB_NAME`, `STORE_OUTBOX`, `planFlush`,
 * `flushQueue`). scripts/offline.test.mjs asserts the two stay in sync.
 */

const VERSION = "quiztime-v2";
/** Every cache this app owns starts with this prefix (purged on sign-out). */
const CACHE_PREFIX = "quiztime-";
const SHELL_CACHE = `${CACHE_PREFIX}shell-${VERSION}`;
const DATA_CACHE = `${CACHE_PREFIX}data-${VERSION}`;

/** Registered with `/sw.js?dev=1` by the app while running `next dev`. */
const DEV = new URL(self.location.href).searchParams.get("dev") === "1";

// ── Offline database (mirrors src/lib/offline-core.ts) ──────────────────────
const DB_NAME = "quiztime-offline";
const DB_VERSION = 1;
const STORE_OUTBOX = "outbox";
const STORE_PROFILE = "profile";
const STORE_DECKS = "decks";
const STORE_SRS = "srs";
const STORE_META = "meta";

/** Both batched routes reject more than 100 entries per request. */
const MAX_BATCH = 100;
/** Background Sync tag the app registers ("quiztime-outbox"). */
const SYNC_TAG = "quiztime-outbox";

/** Third-party assets worth keeping: fonts and Google avatars. */
const CROSS_ORIGIN_HOSTS = [
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "googleusercontent.com",
  "gstatic.com",
];

// ── Lifecycle ───────────────────────────────────────────────────────────────
self.addEventListener("install", (event) => {
  // Take over immediately: a deploy should never leave two versions running.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      const keep = new Set([SHELL_CACHE, DATA_CACHE]);
      await Promise.all(
        names
          .filter((name) => name.startsWith(CACHE_PREFIX) && !keep.has(name))
          .map((name) => caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

// ── IndexedDB helpers ───────────────────────────────────────────────────────
function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_PROFILE)) {
        db.createObjectStore(STORE_PROFILE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_DECKS)) {
        db.createObjectStore(STORE_DECKS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_SRS)) {
        db.createObjectStore(STORE_SRS, { keyPath: "cardId" });
      }
      if (!db.objectStoreNames.contains(STORE_OUTBOX)) {
        db.createObjectStore(STORE_OUTBOX, { keyPath: "seq", autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(store, mode, action) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const request = action(tx.objectStore(store));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

const readQueue = async () =>
  (await withStore(STORE_OUTBOX, "readonly", (os) => os.getAll())).sort(
    (a, b) => (a.seq || 0) - (b.seq || 0)
  );

const putEntry = (entry) => withStore(STORE_OUTBOX, "readwrite", (os) => os.put(entry));

const deleteEntries = (seqs) =>
  Promise.all(
    seqs
      .filter((seq) => typeof seq === "number")
      .map((seq) => withStore(STORE_OUTBOX, "readwrite", (os) => os.delete(seq)))
  );

const clearStore = (store) => withStore(store, "readwrite", (os) => os.clear());

// ── Outbox: which writes may be queued (mirrors describeQueueableWrite) ─────
function describeQueueableWrite(request, url, body) {
  const method = request.method.toUpperCase();
  if (method === "POST" && url.pathname === "/api/stats/results") return "stats";
  if (method === "POST" && url.pathname === "/api/review") return "review";
  if (method === "PATCH" && /^\/api\/sessions\/\d+$/.test(url.pathname)) {
    const cardId = body && body.cardId;
    const isKnown = body && body.isKnown;
    if (Number.isInteger(cardId) && typeof isKnown === "boolean") return "progress";
  }
  return null;
}

// ── Outbox: batching (mirrors planFlush) ────────────────────────────────────
function planFlush(queue) {
  const plans = [];
  const progressByTarget = new Map();

  queue.forEach((item, index) => {
    if (item.kind === "progress") {
      const target = `${(item.body && item.body.sessionId) || ""}:${
        (item.body && item.body.cardId) || ""
      }`;
      const seen = progressByTarget.get(target);
      if (seen) {
        // One PATCH per card, newest payload wins.
        seen.body = item.body;
        seen.seqs = [item.seq];
        seen.lastIndex = index;
        return;
      }
      const plan = {
        url: item.url,
        method: item.method,
        kind: item.kind,
        body: item.body,
        seqs: [item.seq],
        entries: 1,
        lastIndex: index,
      };
      progressByTarget.set(target, plan);
      plans.push(plan);
      return;
    }

    const listKey = item.kind === "review" ? "reviews" : "results";
    const entries =
      item.body && Array.isArray(item.body[listKey]) ? item.body[listKey] : [];
    if (entries.length === 0) return;

    const last = plans[plans.length - 1];
    if (
      last &&
      last.kind === item.kind &&
      last.url === item.url &&
      last.lastIndex === index - 1 &&
      last.body[listKey].length + entries.length <= MAX_BATCH
    ) {
      last.body[listKey].push(...entries);
      last.seqs.push(item.seq);
      last.entries += 1;
      last.lastIndex = index;
      return;
    }

    plans.push({
      url: item.url,
      method: item.method,
      kind: item.kind,
      body: item.kind === "review" ? { reviews: entries.slice() } : { results: entries.slice() },
      seqs: [item.seq],
      entries: 1,
      lastIndex: index,
    });
  });

  return plans;
}

// ── Outbox: draining ────────────────────────────────────────────────────────
async function notifyClients(message) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
  for (const client of clients) client.postMessage(message);
}

/**
 * Replay queued writes. Same failure policy as the in-app drain: network
 * errors, 401/403, 5xx and 429 keep the queue; other 4xx drop the entries so a
 * poison item can never block later syncs.
 */
async function drainOutbox() {
  let synced = 0;
  let failed = false;
  let authFailed = false;

  try {
    const queue = await readQueue();
    if (queue.length > 0) {
      for (const plan of planFlush(queue)) {
        let response;
        try {
          response = await fetch(plan.url, {
            method: plan.method,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(plan.body),
            credentials: "same-origin",
          });
        } catch {
          failed = true;
          break;
        }
        if (response.ok) {
          await deleteEntries(plan.seqs);
          synced += plan.entries;
          continue;
        }
        if (response.status === 401 || response.status === 403) {
          authFailed = true;
          break;
        }
        if (response.status >= 500 || response.status === 429) {
          failed = true;
          break;
        }
        await deleteEntries(plan.seqs); // 400/404/409/422 — permanently invalid
      }
    }
  } catch {
    // IndexedDB unavailable (private mode) — nothing to sync.
    failed = true;
  }

  const remaining = await readQueue().then((items) => items.length).catch(() => 0);
  const result = { synced, remaining, failed, authFailed };
  // The app shows a toast and refreshes its lists when this arrives.
  await notifyClients({ type: "OUTBOX_SYNCED", ...result });
  return result;
}

self.addEventListener("sync", (event) => {
  if (event.tag === SYNC_TAG) event.waitUntil(drainOutbox());
});

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "SKIP_WAITING") {
    void self.skipWaiting();
    return;
  }
  if (data.type === "PING") {
    event.source?.postMessage({ type: "PONG" });
    return;
  }
  if (data.type === "FLUSH_OUTBOX") {
    event.waitUntil(drainOutbox());
    return;
  }
  if (data.type === "PURGE_OFFLINE") {
    // Sign-out: drop the cached session and every cached asset, plus anything
    // the previous account left in the outbox.
    event.waitUntil(
      (async () => {
        const names = await caches.keys();
        await Promise.all(
          names.filter((name) => name.startsWith(CACHE_PREFIX)).map((name) => caches.delete(name))
        );
        await clearStore(STORE_OUTBOX).catch(() => {});
        await clearStore(STORE_PROFILE).catch(() => {});
        await clearStore(STORE_DECKS).catch(() => {});
        await clearStore(STORE_SRS).catch(() => {});
        await clearStore(STORE_META).catch(() => {});
        await notifyClients({ type: "OFFLINE_PURGED" });
      })()
    );
  }
});

// ── Fetch routing ───────────────────────────────────────────────────────────
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Non-http(s) schemes and "only-if-cached" probes (extensions) aren't ours.
  if (!url.protocol.startsWith("http")) return;
  if (request.cache === "only-if-cached" && request.mode !== "same-origin") return;

  const sameOrigin = url.origin === self.location.origin;

  if (request.method !== "GET") {
    // Only the queueable API writes are intercepted (see the comment there).
    if (!sameOrigin) return;
    event.respondWith(handleWrite(request, url));
    return;
  }

  if (sameOrigin && url.pathname === "/api/auth/session") {
    event.respondWith(handleSession(request));
    return;
  }
  // Every other API GET stays untouched: the app falls back to its own
  // IndexedDB snapshots, so there is exactly one source of offline truth.
  if (sameOrigin && url.pathname.startsWith("/api/")) return;

  if (!sameOrigin) {
    if (CROSS_ORIGIN_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
      event.respondWith(staleWhileRevalidate(request, DATA_CACHE));
    }
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(handleNavigation(request));
    return;
  }

  const isStatic =
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/images/") ||
    url.pathname.startsWith("/_next/image") ||
    /\.(?:css|js|png|jpg|jpeg|svg|webp|ico|woff2?|ttf)$/.test(url.pathname);

  if (isStatic) {
    // Dev must never serve a stale bundle; production assets are content-hashed.
    event.respondWith(
      DEV ? networkFirst(request, SHELL_CACHE) : cacheFirst(request, SHELL_CACHE)
    );
    return;
  }

  if (url.pathname === "/manifest.json" || url.pathname === "/") {
    event.respondWith(networkFirst(request, SHELL_CACHE));
  }
});

/** Routes whose writes may be replayed later (mirrors describeQueueableWrite). */
function isQueueableRoute(method, pathname) {
  if (method === "POST" && (pathname === "/api/stats/results" || pathname === "/api/review")) {
    return true;
  }
  return method === "PATCH" && /^\/api\/sessions\/\d+$/.test(pathname);
}

/**
 * Non-GET requests: pass through, and when the network is unreachable queue
 * the write (if it is a queueable one) and answer 202 so the app knows the
 * answer was kept rather than lost.
 */
async function handleWrite(request, url) {
  const method = request.method.toUpperCase();
  // Cloned *before* the network attempt: a request whose body the failed fetch
  // already consumed can no longer be cloned. Only the three small JSON routes
  // are ever cloned — uploads stay streamed straight through.
  let queued = null;
  if (isQueueableRoute(method, url.pathname)) {
    try {
      queued = request.clone();
    } catch {
      queued = null;
    }
  }

  try {
    return await fetch(request);
  } catch (error) {
    if (!queued || url.pathname.startsWith("/api/auth/")) throw error;
    let body = null;
    try {
      body = JSON.parse(await queued.text());
    } catch {
      body = null;
    }
    const kind = describeQueueableWrite(request, url, body);
    if (!kind) throw error;
    try {
      await putEntry({
        url: url.pathname + url.search,
        method,
        kind,
        body,
        createdAt: new Date().toISOString(),
        attempts: 0,
      });
      if (self.registration.sync) {
        await self.registration.sync.register(SYNC_TAG).catch(() => {});
      }
      await notifyClients({ type: "OUTBOX_QUEUED", kind });
      return new Response(JSON.stringify({ queued: true, offline: true }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      });
    } catch {
      throw error;
    }
  }
}

/**
 * Auth.js fetches the session itself, so it is the one API response cached
 * here. Only responses that actually contain a user are stored, and offline
 * reads serve that copy — the app's cached profile is the backstop when the
 * service worker isn't available.
 */
async function handleSession(request) {
  const cache = await caches.open(DATA_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) {
      // The body is read as text from a clone and the *stored* copy is rebuilt
      // from that text: `cache.put()` needs a response whose body hasn't been
      // read yet, and a parsed copy can no longer be stored.
      void response
        .clone()
        .text()
        .then((text) => {
          let data = null;
          try {
            data = JSON.parse(text);
          } catch {
            data = null;
          }
          return data && data.user
            ? cache.put(request, new Response(text, { headers: response.headers }))
            : cache.delete(request);
        })
        .catch(() => {});
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw error;
  }
}

/** HTML: always try the deploy first, fall back to the cached shell. */
async function handleNavigation(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) {
      const copy = response.clone();
      cache.put(request, copy);
    }
    return response;
  } catch {
    const cached =
      (await cache.match(request)) ||
      (await cache.match(request, { ignoreSearch: true })) ||
      (await cache.match("/"));
    if (cached) return cached;
    return new Response(
      "<!doctype html><meta charset=\"utf-8\"><title>QuizTime</title>" +
        "<body style=\"font-family:system-ui;padding:40px;text-align:center;color:#10233f\">" +
        "<h1>You're offline</h1><p>Open QuizTime once while online so it can be saved for offline use.</p>",
      { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw error;
  }
}

/** Fonts/avatars: instant from cache, refreshed in the background. */
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      // Opaque (no-cors) responses are fine to store — they are only ever
      // replayed as-is for <img>/<link> tags.
      if (response.ok || response.type === "opaque") cache.put(request, response.clone());
      return response;
    })
    .catch(() => undefined);

  if (cached) return cached;
  const response = await network;
  if (response) return response;
  throw new Error("offline");
}
