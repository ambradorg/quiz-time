/**
 * Offline mode — the browser half.
 *
 * Everything that touches IndexedDB, `fetch`, the Cache API or the service
 * worker lives here; the deterministic logic it leans on is in
 * `src/lib/offline-core.ts` (unit-tested in `scripts/offline.test.mjs`).
 *
 * The three jobs:
 *   1. **Identity** — cache the signed-in profile so the app can open offline
 *      (`public/sw.js` caches `/api/auth/session` for the same reason).
 *   2. **Snapshots** — decks/cards/progress/SRS state, so "My Sets" and all
 *      four study modes work with no network. Decks the learner opened are
 *      cached automatically; "Save offline" pins them for good.
 *   3. **Outbox** — study outcomes, review grades and progress writes are
 *      queued durably and replayed when the connection returns, in order.
 *
 * Reads go through `loadX()` helpers that try the network first and fall back
 * to the snapshot, so a page never has to know *why* it is offline — it only
 * gets to show the "offline" badge.
 *
 * ⚠️ `public/sw.js` drains the same outbox (Background Sync) while the app is
 * closed: it must keep using `OFFLINE_DB_NAME` / `STORE_OUTBOX` and the same
 * queued-write shape. `scripts/offline.test.mjs` asserts that contract.
 */
import {
  MAX_OUTBOX_ITEMS,
  OFFLINE_DB_NAME,
  OFFLINE_DB_VERSION,
  OFFLINE_MODE_KEY,
  STORE_DECKS,
  STORE_META,
  STORE_OUTBOX,
  STORE_PROFILE,
  STORE_SRS,
  applyGradeToSrs,
  applyProgressToDeck,
  buildOfflineDeck,
  buildOfflineReviewData,
  buildOfflineSessionRows,
  canAttemptFlush,
  countDueNow,
  describeQueueableWrite,
  enqueueWrite,
  flushQueue,
  isOfflineModeEnabled,
  mergeDeckSnapshot,
  nowIso,
  outboxSize,
  queueKey,
  setOfflineMode,
  srsRowToOffline,
  type FlushResult,
  type OfflineBackend,
  type OfflineCard,
  type OfflineDeck,
  type OfflineDueCard,
  type OfflineProfile,
  type OfflineProgress,
  type OfflineReviewData,
  type OfflineSessionRow,
  type OfflineSrs,
  type QueuedWrite,
  type SessionPayload,
} from "./offline-core";
import type { ReviewGrade } from "./srs";

export * from "./offline-core";

/** Cache-storage namespace owned by `public/sw.js` (never cache `srv-` keys). */
export const SW_CACHE_PREFIX = "quiztime-";

// ─── Backend: IndexedDB, with an in-memory fallback ──────────────────────────
/**
 * Some contexts have no IndexedDB (Safari private mode, hardened profiles, the
 * server during SSR). Offline mode then degrades to "works for this tab" —
 * the in-memory backend keeps the code paths identical instead of scattering
 * `if (typeof indexedDB)` checks through the UI.
 */
export function createMemoryBackend(): OfflineBackend {
  const stores = new Map<string, Map<string | number, unknown>>();
  // Mirrors IndexedDB's `autoIncrement` on the outbox, so the queue keeps a
  // stable, monotonic ordering on both backends.
  let autoSeq = 0;
  const table = (store: string) => {
    let map = stores.get(store);
    if (!map) {
      map = new Map();
      stores.set(store, map);
    }
    return map;
  };
  const keyOf = (value: unknown, fallback: string | number): string | number => {
    if (typeof value === "object" && value !== null) {
      const record = value as Record<string, unknown>;
      const key = record.seq ?? record.id ?? record.cardId ?? record.key;
      if (typeof key === "string" || typeof key === "number") return key;
    }
    return fallback;
  };
  return {
    async getAll<T>(store: string) {
      return [...table(store).values()] as T[];
    },
    async get<T>(store: string, key: string | number) {
      return table(store).get(key) as T | undefined;
    },
    async put(store: string, value: unknown) {
      if (store === STORE_OUTBOX && typeof value === "object" && value !== null) {
        const item = value as { seq?: number };
        if (typeof item.seq !== "number") {
          const stored = { ...(value as Record<string, unknown>), seq: ++autoSeq };
          table(store).set(stored.seq as number, stored);
          return;
        }
      }
      table(store).set(keyOf(value, Math.random().toString(36).slice(2)), value);
    },
    async delete(store: string, key: string | number) {
      table(store).delete(key);
    },
    async clear(store: string) {
      table(store).clear();
    },
  };
}

const isBrowser = () => typeof window !== "undefined";

let backendPromise: Promise<OfflineBackend> | null = null;

/** Open (once) the offline database. Falls back to memory, never throws. */
export function getOfflineBackend(): Promise<OfflineBackend> {
  if (!backendPromise) {
    backendPromise = openIndexedDb().catch(() => createMemoryBackend());
  }
  return backendPromise;
}

async function openIndexedDb(): Promise<OfflineBackend> {
  if (typeof indexedDB === "undefined") throw new Error("IndexedDB unavailable");
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      // Created idempotently: an upgrade can run more than once while the
      // schema grows, and old devices may jump several versions.
      if (!database.objectStoreNames.contains(STORE_PROFILE)) {
        database.createObjectStore(STORE_PROFILE, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(STORE_DECKS)) {
        database.createObjectStore(STORE_DECKS, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(STORE_SRS)) {
        database.createObjectStore(STORE_SRS, { keyPath: "cardId" });
      }
      if (!database.objectStoreNames.contains(STORE_OUTBOX)) {
        database.createObjectStore(STORE_OUTBOX, { keyPath: "seq", autoIncrement: true });
      }
      if (!database.objectStoreNames.contains(STORE_META)) {
        database.createObjectStore(STORE_META, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    request.onblocked = () => reject(new Error("IndexedDB blocked"));
  });

  const run = <T>(
    store: string,
    mode: IDBTransactionMode,
    action: (objectStore: IDBObjectStore) => IDBRequest<T>
  ): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const request = action(tx.objectStore(store));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    });

  return {
    getAll: <T>(store: string) => run<T[]>(store, "readonly", (os) => os.getAll() as IDBRequest<T[]>),
    get: <T>(store: string, key: string | number) =>
      run<T | undefined>(store, "readonly", (os) => os.get(key) as IDBRequest<T | undefined>),
    put: async (store, value) => {
      await run(store, "readwrite", (os) => os.put(value));
    },
    delete: async (store, key) => {
      await run(store, "readwrite", (os) => os.delete(key));
    },
    clear: async (store) => {
      await run(store, "readwrite", (os) => os.clear());
    },
  };
}

// ─── Connectivity tracking ───────────────────────────────────────────────────
type ConnectivityListener = (online: boolean) => void;
const connectivityListeners = new Set<ConnectivityListener>();
let suspectOffline = false;

/** Listeners for "the app believes it is offline" changes. */
export function subscribeConnectivity(listener: ConnectivityListener): () => void {
  connectivityListeners.add(listener);
  return () => connectivityListeners.delete(listener);
}

function emitConnectivity() {
  const online = isProbablyOnline();
  for (const listener of connectivityListeners) listener(online);
}

/**
 * `navigator.onLine` is optimistic: it is true behind a captive portal or a
 * router with no uplink. Every request therefore feeds its outcome back here,
 * and a *network-level* failure flips the app to offline until a request
 * succeeds again (or the browser fires `online` and a probe passes).
 */
export function noteNetworkResult(ok: boolean): void {
  const next = !ok;
  if (next === suspectOffline) return;
  suspectOffline = next;
  emitConnectivity();
}

/** True when the browser *and* the recent requests agree there's a network. */
export function isProbablyOnline(): boolean {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
  return !suspectOffline;
}

/** Attach the `online`/`offline` listeners (browser only, idempotent). */
let connectivityBound = false;
export function bindConnectivityListeners(): void {
  if (connectivityBound || !isBrowser()) return;
  connectivityBound = true;
  window.addEventListener("online", () => {
    // A probe confirms the connection is *usable*, not merely present.
    void probeConnection();
  });
  window.addEventListener("offline", () => {
    suspectOffline = true;
    emitConnectivity();
  });
  window.addEventListener("focus", () => {
    if (suspectOffline) void probeConnection();
  });
}

/**
 * Ping the health route: *any* HTTP answer proves the network path works, so
 * only a rejected fetch counts as "still offline". A 503 from `/api/health`
 * means the server is up but degraded (the database), which is not something
 * the offline switch should hide — the app's own read fallbacks handle it.
 */
export async function probeConnection(): Promise<boolean> {
  try {
    await fetch("/api/health", { cache: "no-store" });
    noteNetworkResult(true);
    return isProbablyOnline();
  } catch {
    noteNetworkResult(false);
    return false;
  }
}

// ─── Errors ──────────────────────────────────────────────────────────────────
/** Thrown when a request never reached the server (offline, timeout, DNS…). */
export class OfflineError extends Error {
  constructor(message = "You appear to be offline") {
    super(message);
    this.name = "OfflineError";
  }
}

/** Thrown when the server answered with a non-2xx status. */
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

/**
 * `fetch` + JSON with a timeout, classifying the two failure modes the offline
 * UI cares about. 401 becomes `HttpError` so callers can tell "session gone"
 * apart from "no network".
 */
export async function fetchJson<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {}
): Promise<T> {
  const { timeoutMs = 10_000, ...rest } = init;
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer =
    controller && timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetch(url, { ...rest, signal: controller?.signal, cache: "no-store" });
    if (!res.ok) {
      noteNetworkResult(true); // the server answered — we are online
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new HttpError(res.status, body?.error ?? `Request failed (${res.status})`);
    }
    noteNetworkResult(true);
    return (await res.json()) as T;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    noteNetworkResult(false);
    throw new OfflineError();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ─── Identity ────────────────────────────────────────────────────────────────
export async function readCachedProfile(): Promise<OfflineProfile | null> {
  if (!isBrowser()) return null;
  try {
    const backend = await getOfflineBackend();
    const rows = await backend.getAll<OfflineProfile>(STORE_PROFILE);
    // Exactly one profile is cached: whoever signed in last on this device.
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

export async function cacheProfile(profile: OfflineProfile | null): Promise<void> {
  if (!isBrowser() || !profile) return;
  try {
    const backend = await getOfflineBackend();
    await backend.clear(STORE_PROFILE); // one account at a time, never a blend
    await backend.put(STORE_PROFILE, profile);
  } catch {
    // Storage unavailable — offline sign-in just won't be offered.
  }
}

export function isOfflineMode(): boolean {
  if (!isBrowser()) return false;
  try {
    return isOfflineModeEnabled(window.localStorage);
  } catch {
    return false;
  }
}

export function enableOfflineMode(enabled: boolean): void {
  if (!isBrowser()) return;
  try {
    setOfflineMode(window.localStorage, enabled);
  } catch {
    // Ignore — private mode.
  }
}

/** Does this device have everything it needs to open the account offline? */
export async function readOfflineReadiness(): Promise<{
  profile: OfflineProfile | null;
  deckCount: number;
  cardCount: number;
  savedAt: string | null;
}> {
  const [profile, decks] = await Promise.all([readCachedProfile(), readDecks()]);
  const savedAt =
    decks.map((deck) => deck.savedAt).sort().at(-1) ?? profile?.savedAt ?? null;
  return {
    profile,
    deckCount: decks.length,
    cardCount: decks.reduce((total, deck) => total + deck.cards.length, 0),
    savedAt,
  };
}

// ─── Deck snapshots ──────────────────────────────────────────────────────────
export async function readDecks(): Promise<OfflineDeck[]> {
  if (!isBrowser()) return [];
  try {
    return await (await getOfflineBackend()).getAll<OfflineDeck>(STORE_DECKS);
  } catch {
    return [];
  }
}

export async function readDeck(id: number): Promise<OfflineDeck | null> {
  if (!isBrowser()) return null;
  try {
    return (await (await getOfflineBackend()).get<OfflineDeck>(STORE_DECKS, id)) ?? null;
  } catch {
    return null;
  }
}

export async function saveDeck(deck: OfflineDeck): Promise<void> {
  if (!isBrowser()) return;
  try {
    const backend = await getOfflineBackend();
    const existing = await backend.get<OfflineDeck>(STORE_DECKS, deck.id);
    await backend.put(STORE_DECKS, mergeDeckSnapshot(existing, deck));
  } catch {
    // Out of quota — the online app is unaffected.
  }
}

/**
 * Keep the subject folder of saved deck snapshots in sync with the server, so
 * a set moved into (or out of) a subject doesn't reappear in "All Sets" when
 * the list is rebuilt from this device. Pass a map of deckId → subjectId.
 */
export async function syncDeckSubjects(
  subjectsById: Map<number, number | null>
): Promise<void> {
  if (!isBrowser() || subjectsById.size === 0) return;
  try {
    const backend = await getOfflineBackend();
    const decks = await backend.getAll<OfflineDeck>(STORE_DECKS);
    for (const deck of decks) {
      if (!subjectsById.has(deck.id)) continue;
      const subjectId = subjectsById.get(deck.id) ?? null;
      if ((deck.subjectId ?? null) === subjectId) continue;
      await backend.put(STORE_DECKS, { ...deck, subjectId });
    }
  } catch {
    // Ignore — the online list is unaffected.
  }
}

export async function deleteDeckSnapshot(id: number): Promise<void> {
  if (!isBrowser()) return;
  try {
    await (await getOfflineBackend()).delete(STORE_DECKS, id);
  } catch {
    // Ignore.
  }
}

/** Update one card's progress in the snapshot (offline "Got it / Still learning"). */
export async function saveProgressLocally(
  sessionId: number,
  cardId: number,
  isKnown: boolean
): Promise<void> {
  const deck = await readDeck(sessionId);
  if (!deck) return;
  await saveDeck(applyProgressToDeck(deck, { cardId, isKnown }));
}

// ─── Spaced repetition state ─────────────────────────────────────────────────
export async function readSrsRecords(): Promise<OfflineSrs[]> {
  if (!isBrowser()) return [];
  try {
    return await (await getOfflineBackend()).getAll<OfflineSrs>(STORE_SRS);
  } catch {
    return [];
  }
}

export async function saveSrsRecords(records: OfflineSrs[]): Promise<void> {
  if (!isBrowser() || records.length === 0) return;
  try {
    const backend = await getOfflineBackend();
    await Promise.all(records.map((record) => backend.put(STORE_SRS, record)));
  } catch {
    // Ignore — the server copy is authoritative anyway.
  }
}

// ─── Stats & misc meta ───────────────────────────────────────────────────────
interface MetaRow<T> {
  key: string;
  value: T;
}

export async function readMeta<T>(key: string): Promise<T | null> {
  if (!isBrowser()) return null;
  try {
    const row = await (await getOfflineBackend()).get<MetaRow<T>>(STORE_META, key);
    return row?.value ?? null;
  } catch {
    return null;
  }
}

export async function writeMeta<T>(key: string, value: T): Promise<void> {
  if (!isBrowser()) return;
  try {
    await (await getOfflineBackend()).put(STORE_META, { key, value });
  } catch {
    // Ignore.
  }
}

export interface StatsSnapshot {
  data: unknown;
  savedAt: string;
}

export const STATS_SNAPSHOT_KEY = "stats-snapshot";

export async function cacheStatsSnapshot(data: unknown): Promise<void> {
  await writeMeta<StatsSnapshot>(STATS_SNAPSHOT_KEY, { data, savedAt: nowIso() });
}

export function readStatsSnapshot(): Promise<StatsSnapshot | null> {
  return readMeta<StatsSnapshot>(STATS_SNAPSHOT_KEY);
}

// ─── Outbox ──────────────────────────────────────────────────────────────────
type OutboxListener = () => void;
const outboxListeners = new Set<OutboxListener>();

export function subscribeOutbox(listener: OutboxListener): () => void {
  outboxListeners.add(listener);
  return () => outboxListeners.delete(listener);
}

function emitOutbox() {
  for (const listener of outboxListeners) listener();
}

export async function readOutbox(): Promise<QueuedWrite[]> {
  if (!isBrowser()) return [];
  try {
    const items = await (await getOfflineBackend()).getAll<QueuedWrite>(STORE_OUTBOX);
    return items.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  } catch {
    return [];
  }
}

export async function readOutboxCount(): Promise<number> {
  return outboxSize(await readOutbox());
}

/**
 * Queue a write that could not reach the server. Returns false when the
 * request is not queueable (deck create/edit/delete, auth) — those need the
 * network and the UI says so.
 *
 * Only the new entry is written (and the cap is enforced by deleting the
 * oldest rows): keeping existing `seq`s stable is what lets a drain in
 * progress delete exactly the entries it sent.
 */
export async function enqueueOfflineWrite(
  url: string,
  method: string,
  body: unknown
): Promise<boolean> {
  if (!isBrowser()) return false;
  const queueable = describeQueueableWrite(url, method, body);
  if (!queueable) return false;
  try {
    const backend = await getOfflineBackend();
    const existing = await readOutbox();
    const item = enqueueWrite([], {
      url,
      method: method.toUpperCase(),
      kind: queueable.kind,
      body,
    })[0];
    await backend.put(STORE_OUTBOX, item);
    const overflow = existing.length + 1 - MAX_OUTBOX_ITEMS;
    for (const stale of existing.slice(0, Math.max(0, overflow))) {
      if (typeof stale.seq === "number") await backend.delete(STORE_OUTBOX, stale.seq);
    }
    emitOutbox();
    void registerBackgroundSync();
    return true;
  } catch {
    return false;
  }
}

let flushing: Promise<FlushResult & { remaining: number }> | null = null;

/**
 * Drain the outbox through the API. Concurrent calls share one drain, and a
 * successful drain clears the failure backoff; a failed one starts it.
 */
export function flushOfflineQueue(): Promise<FlushResult & { remaining: number }> {
  if (!flushing) {
    flushing = drainOutbox().finally(() => {
      flushing = null;
    });
  }
  return flushing;
}

async function drainOutbox(): Promise<FlushResult & { remaining: number }> {
  const empty: FlushResult = {
    syncedKeys: [],
    syncedEntries: 0,
    droppedKeys: [],
    networkFailed: false,
    authFailed: false,
  };
  if (!isBrowser()) return { ...empty, remaining: 0 };

  const queue = await readOutbox();
  if (queue.length === 0) return { ...empty, remaining: 0 };
  if (!isProbablyOnline()) return { ...empty, remaining: outboxSize(queue) };

  const backoff = await readMeta<{ lastFailureAt: string | null; attempts: number }>(
    "flush-backoff"
  );
  if (backoff && !canAttemptFlush(backoff)) {
    return { ...empty, remaining: outboxSize(queue) };
  }

  const result = await flushQueue({
    queue,
    fetchImpl: async (url, init) => {
      // A failing request has to flip the app to offline *inside* the drain,
      // otherwise the retry loop would hammer a dead network.
      try {
        const res = await fetch(url, init);
        noteNetworkResult(true);
        return { ok: res.ok, status: res.status };
      } catch (error) {
        noteNetworkResult(false);
        throw error;
      }
    },
  });

  if (result.syncedKeys.length > 0 || result.droppedKeys.length > 0) {
    const done = new Set([...result.syncedKeys, ...result.droppedKeys]);
    const backend = await getOfflineBackend();
    queue.forEach((item, index) => {
      if (done.has(queueKey(item, index))) {
        void backend.delete(STORE_OUTBOX, item.seq ?? -1);
      }
    });
  }

  if (result.networkFailed) {
    await writeMeta("flush-backoff", {
      lastFailureAt: nowIso(),
      attempts: Math.min(8, (backoff?.attempts ?? 0) + 1),
    });
    noteNetworkResult(false);
  } else if (!result.authFailed) {
    await writeMeta("flush-backoff", { lastFailureAt: null, attempts: 0 });
  }

  const remaining = await readOutboxCount();
  emitOutbox();
  return { ...result, remaining };
}

/**
 * Ask the browser to replay the queue later even if the tab is closed
 * (Chrome/Edge/Android). Safari has no Background Sync — the app drains on
 * `online`, on focus and on every launch instead.
 */
export async function registerBackgroundSync(): Promise<void> {
  if (!isBrowser() || !("serviceWorker" in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    const sync = (registration as ServiceWorkerRegistration & {
      sync?: { register: (tag: string) => Promise<void> };
    })?.sync;
    await sync?.register("quiztime-outbox");
  } catch {
    // Unsupported or permission-restricted — the in-app drain covers it.
  }
}

/** Message the service worker (no-op when it isn't installed/controlled). */
export function messageServiceWorker(message: { type: string }): void {
  if (!isBrowser() || !("serviceWorker" in navigator)) return;
  try {
    navigator.serviceWorker.controller?.postMessage(message);
  } catch {
    // Ignore.
  }
}

/** Re-read the outbox everywhere it is displayed (used after SW messages). */
export function bumpOutbox(): void {
  emitOutbox();
}

/**
 * Write now, or queue for later — the single entry point for every write that
 * is safe to apply late (study outcomes, review grades, card progress).
 *
 *   "sent"     the server accepted it
 *   "queued"   kept in the outbox (offline, or the service worker queued it)
 *   "rejected" the request is not queueable, or the server refused it
 */
export type WriteOutcome = "sent" | "queued" | "rejected";

export async function sendOrQueueWrite(
  url: string,
  method: string,
  body: unknown
): Promise<WriteOutcome> {
  if (!isBrowser()) return "rejected";

  if (!isProbablyOnline()) {
    return (await enqueueOfflineWrite(url, method, body)) ? "queued" : "rejected";
  }

  try {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    noteNetworkResult(true);
    if (res.status === 202) {
      // The service worker caught a dead network and queued the write itself.
      const payload = (await res
        .clone()
        .json()
        .catch(() => null)) as { queued?: boolean } | null;
      if (payload?.queued) {
        emitOutbox();
        void registerBackgroundSync();
        return "queued";
      }
      return "sent";
    }
    return res.ok ? "sent" : "rejected";
  } catch {
    noteNetworkResult(false);
    return (await enqueueOfflineWrite(url, method, body)) ? "queued" : "rejected";
  }
}

/** Apply several offline grades to the local schedule in one storage pass. */
export async function applyLocalGrades(
  grades: { cardId: number; sessionId: number; grade: ReviewGrade }[]
): Promise<void> {
  if (!isBrowser() || grades.length === 0) return;
  const records = await readSrsRecords();
  const now = new Date();
  let next = records;
  for (const grade of grades) {
    next = applyGradeToSrs(next, grade, now);
  }
  const touched = new Set(grades.map((grade) => grade.cardId));
  await saveSrsRecords(next.filter((record) => touched.has(record.cardId)));
}

/** How many of this deck's cards are due — API first, cache when offline. */
export async function loadDeckDueCount(
  sessionId: number
): Promise<{ due: number; offline: boolean }> {
  try {
    const data = await fetchJson<{ counts?: { due?: number } }>(
      `/api/review?sessionId=${sessionId}&limit=1`
    );
    return { due: data.counts?.due ?? 0, offline: false };
  } catch {
    const srs = await readSrsRecords();
    const now = Date.now();
    return {
      due: srs.filter(
        (row) => row.sessionId === sessionId && new Date(row.dueAt).getTime() <= now
      ).length,
      offline: true,
    };
  }
}

// ─── Reads with offline fallback ─────────────────────────────────────────────
export interface OfflineDeckPayload {
  session: SessionPayload;
  cards: OfflineCard[];
  progress: OfflineProgress[];
  /** True when the payload came from the snapshot instead of the API. */
  offline: boolean;
  savedAt: string | null;
}

const snapshotToPayload = (deck: OfflineDeck, offline: boolean): OfflineDeckPayload => ({
  session: {
    id: deck.id,
    title: deck.title,
    summary: deck.summary,
    sourceType: deck.sourceType,
    createdAt: deck.createdAt,
    subjectId: deck.subjectId ?? null,
  },
  cards: deck.cards,
  progress: deck.progress,
  offline,
  savedAt: deck.savedAt,
});

/**
 * Load a deck for study: network first (and refresh the snapshot while we're
 * there), snapshot when the network is unreachable.
 */
export async function loadDeckForStudy(deckId: number): Promise<OfflineDeckPayload> {
  try {
    const data = await fetchJson<{
      session: SessionPayload;
      cards: OfflineCard[];
      progress: OfflineProgress[];
    }>(`/api/sessions/${deckId}`);
    const snapshot = buildOfflineDeck({
      session: data.session,
      cards: data.cards ?? [],
      progress: data.progress ?? [],
      pinned: (await readDeck(deckId))?.pinned ?? false,
    });
    await saveDeck(snapshot);
    // The schedule isn't part of this response — pull the bundle in the
    // background so the deck's review queue also works offline.
    void cacheDeckBundle(deckId, { pinned: snapshot.pinned }).catch(() => {});
    return { ...data, offline: false, savedAt: snapshot.savedAt };
  } catch (error) {
    if (error instanceof HttpError && error.status !== 404) throw error;
    const deck = await readDeck(deckId);
    if (!deck) throw new OfflineError("This set isn't saved on this device yet");
    return snapshotToPayload(deck, true);
  }
}

/** "My Study Sets" from the snapshot store, with locally computed counts. */
export async function loadOfflineSessionList(): Promise<OfflineSessionRow[]> {
  const [decks, srs] = await Promise.all([readDecks(), readSrsRecords()]);
  return buildOfflineSessionRows(decks, srs);
}

/**
 * The review queue: the API when reachable, otherwise rebuilt from the
 * snapshots (same rules — overdue first, then a daily helping of new cards).
 */
export async function loadReviewData(
  sessionId?: number | null,
  limit = 50
): Promise<OfflineReviewData & { offline: boolean }> {
  const query = `${sessionId ? `sessionId=${sessionId}&` : ""}limit=${limit}`;
  try {
    const data = await fetchJson<OfflineReviewData>(`/api/review?${query}`);
    // Keep the local schedule in step with the server's while we're online:
    // the queue carries each card's state, and the deck list carries the rest.
    const queued: OfflineDueCard[] = data.queue;
    const rows: OfflineSrs[] = queued.flatMap((card) =>
      card.state
        ? [
            {
              cardId: card.cardId,
              sessionId: card.sessionId,
              dueAt: card.dueAt ?? nowIso(),
              lastReviewedAt: null,
              introducedAt: nowIso(),
              state: card.state,
            },
          ]
        : []
    );
    // `lastReviewedAt`/`introducedAt` aren't in the queue payload, so merge
    // with whatever the snapshot already knew rather than overwriting it.
    const existing = await readSrsRecords();
    const byCard = new Map(existing.map((row) => [row.cardId, row]));
    const merged = rows.map((row) => {
      const previous = byCard.get(row.cardId);
      return previous ? { ...row, introducedAt: previous.introducedAt, lastReviewedAt: previous.lastReviewedAt } : row;
    });
    await saveSrsRecords(merged);
    return { ...data, offline: false };
  } catch (error) {
    if (error instanceof HttpError && error.status !== 404) throw error;
    const [decks, srs] = await Promise.all([readDecks(), readSrsRecords()]);
    if (decks.length === 0) throw new OfflineError("Nothing is saved for offline study yet");
    return { ...buildOfflineReviewData({ decks, srs, sessionId, limit }), offline: true };
  }
}

// ─── Downloads ───────────────────────────────────────────────────────────────
interface BundleResponse {
  generatedAt: string;
  truncated?: boolean;
  decks: {
    session: SessionPayload;
    cards: OfflineCard[];
    progress: OfflineProgress[];
    reviews: Parameters<typeof srsRowToOffline>[0][];
  }[];
}

/**
 * Fetch `/api/offline/bundle` and freeze it locally. Used by both the
 * per-deck "Save offline" button and "Download all".
 */
export async function cacheDeckBundle(
  deckId?: number,
  options: { pinned?: boolean } = {}
): Promise<{ deckCount: number; cardCount: number; truncated: boolean }> {
  const url = deckId ? `/api/offline/bundle?sessionId=${deckId}` : "/api/offline/bundle";
  const bundle = await fetchJson<BundleResponse>(url, { timeoutMs: 30_000 });
  const existing = new Map((await readDecks()).map((deck) => [deck.id, deck]));
  const srsRecords: OfflineSrs[] = [];

  for (const entry of bundle.decks) {
    const previous = existing.get(entry.session.id);
    await saveDeck(
      buildOfflineDeck({
        session: entry.session,
        cards: entry.cards,
        progress: entry.progress,
        // Pinning is sticky: downloading everything shouldn't unpin a set
        // that was saved deliberately earlier.
        pinned: options.pinned || previous?.pinned || false,
      })
    );
    for (const review of entry.reviews ?? []) {
      srsRecords.push(srsRowToOffline(review));
    }
  }

  await saveSrsRecords(srsRecords);
  if (bundle.decks.length > 0) {
    void requestPersistentStorage();
  }
  return {
    deckCount: bundle.decks.length,
    cardCount: bundle.decks.reduce((total, entry) => total + entry.cards.length, 0),
    truncated: Boolean(bundle.truncated),
  };
}

/** Remove one deck from the offline cache (and its schedules). */
export async function forgetDeckOffline(deckId: number): Promise<void> {
  const srs = await readSrsRecords();
  const keep = srs.filter((row) => row.sessionId !== deckId);
  await deleteDeckSnapshot(deckId);
  const removed = srs.length - keep.length;
  if (removed > 0) {
    const backend = await getOfflineBackend();
    await Promise.all(
      srs
        .filter((row) => row.sessionId === deckId)
        .map((row) => backend.delete(STORE_SRS, row.cardId).catch(() => {}))
    );
  }
}

/**
 * Ask the browser to keep our offline data when storage runs low. Best effort:
 * Chrome grants it silently for installed PWAs, Safari ignores it.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (isBrowser() && navigator.storage?.persist) {
      return await navigator.storage.persist();
    }
  } catch {
    // Ignore.
  }
  return false;
}

/**
 * Sign-out: drop the profile, the snapshots, the queue and the SW's caches so
 * the next person at this device can't read the previous account's decks.
 */
export async function purgeOfflineData(): Promise<void> {
  if (!isBrowser()) return;
  enableOfflineMode(false);
  const backend = await getOfflineBackend().catch(() => null);
  if (backend) {
    await Promise.all(
      [STORE_PROFILE, STORE_DECKS, STORE_SRS, STORE_OUTBOX, STORE_META].map((store) =>
        backend.clear(store).catch(() => {})
      )
    );
  }
  emitOutbox();
  // The service worker keeps the app shell + the cached session; drop them too
  // (its own activate handler also purges anything outside its namespace).
  messageServiceWorker({ type: "PURGE_OFFLINE" });
  try {
    if (typeof caches !== "undefined") {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith(SW_CACHE_PREFIX))
          .map((name) => caches.delete(name))
      );
    }
  } catch {
    // Ignore.
  }
}

export { OFFLINE_MODE_KEY };
