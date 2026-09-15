#!/usr/bin/env node
/**
 * Integration tests for the *browser* half of offline mode (src/lib/offline.ts).
 *
 * There is no real browser here, so the test fakes the few globals the module
 * touches (`window` + `localStorage`, `navigator.onLine`, `fetch`) and drives
 * the whole round trip:
 *
 *   snapshot a deck → lose the network → read the deck/list/queue from the
 *   cache → study offline → queue the writes → reconnect → drain the outbox
 *
 * The IndexedDB path isn't exercised (Node has no IndexedDB): the module falls
 * back to its in-memory backend, which the same code paths drive. The tests
 * below are therefore about *behaviour* — what is queued, what is replayed,
 * what survives — not about storage internals (those live in offline.test.mjs).
 *
 * Usage:
 *   npm run test:offline
 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";

// ── Fake browser environment (must exist before the module is imported) ──────
const windowListeners = new Map();
const storage = new Map();

globalThis.window = {
  addEventListener(type, fn) {
    const list = windowListeners.get(type) ?? [];
    list.push(fn);
    windowListeners.set(type, list);
  },
  removeEventListener(type, fn) {
    const list = windowListeners.get(type) ?? [];
    windowListeners.set(
      type,
      list.filter((entry) => entry !== fn)
    );
  },
  localStorage: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  },
  location: { replace() {} },
};

const fakeNavigator = { onLine: true };
Object.defineProperty(globalThis, "navigator", { configurable: true, value: fakeNavigator });

/** Requests the code under test made; the test decides how they're answered. */
const calls = [];
let respond = async () => {
  throw new TypeError("Failed to fetch");
};
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body });
  return respond(String(url), init);
};

const offline = () => {
  fakeNavigator.onLine = false;
};
const online = () => {
  fakeNavigator.onLine = true;
};

const {
  applyLocalGrades,
  buildOfflineDeck,
  cacheProfile,
  countDueNow,
  enqueueOfflineWrite,
  flushOfflineQueue,
  isProbablyOnline,
  loadDeckForStudy,
  loadOfflineSessionList,
  loadReviewData,
  noteNetworkResult,
  purgeOfflineData,
  readCachedProfile,
  readDecks,
  readOfflineReadiness,
  readOutbox,
  readOutboxCount,
  readSrsRecords,
  saveDeck,
  saveProgressLocally,
  sendOrQueueWrite,
} = await import("../src/lib/offline.ts");

const NOW = Date.now();
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const DECK = {
  session: {
    id: 7,
    title: "Cell Biology",
    sourceType: "pdf",
    summary: "Membranes and organelles",
    createdAt: iso(-3 * 24 * HOUR),
  },
  cards: [
    { id: 70, question: "Powerhouse?", answer: "Mitochondria", hint: null, difficulty: "easy", orderIndex: 0 },
    { id: 71, question: "Control centre?", answer: "Nucleus", hint: null, difficulty: "medium", orderIndex: 1 },
    { id: 72, question: "Protein factory?", answer: "Ribosome", hint: null, difficulty: "medium", orderIndex: 2 },
  ],
  progress: [],
};

const jsonResponse = (payload, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => payload,
  clone() {
    return this;
  },
});

describe("offline client round trip", () => {
  test("a signed-in user and their deck are cached on this device", async () => {
    await cacheProfile({
      id: "u1",
      name: "Ada",
      email: "ada@example.com",
      image: null,
      savedAt: iso(0),
    });
    const profile = await readCachedProfile();
    assert.equal(profile.id, "u1");
    assert.equal(profile.name, "Ada");

    // Snapshot the deck the way "Save offline" / opening a deck does.
    await saveDeck(buildOfflineDeck(DECK));
    const readiness = await readOfflineReadiness();
    assert.equal(readiness.deckCount, 1);
    assert.equal(readiness.cardCount, 3);
    assert.ok(readiness.savedAt);
  });

  test("with no network, the deck list and the deck itself come from the cache", async () => {
    offline();
    respond = async () => {
      throw new TypeError("Failed to fetch");
    };

    const rows = await loadOfflineSessionList();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, "Cell Biology");
    assert.equal(rows[0].cardCount, 3);
    assert.equal(rows[0].knownCount, 0);

    const deck = await loadDeckForStudy(7);
    assert.equal(deck.offline, true, "the deck is flagged as coming from the cache");
    assert.deepEqual(deck.cards.map((card) => card.id), [70, 71, 72]);
    assert.equal(deck.session.title, "Cell Biology");
    assert.equal(isProbablyOnline(), false);

    // A deck that was never saved can't be opened offline.
    await assert.rejects(() => loadDeckForStudy(999), /saved on this device/);
  });

  test("studying offline updates the local snapshot without a server", async () => {
    await saveProgressLocally(7, 70, true);
    const rows = await loadOfflineSessionList();
    assert.equal(rows[0].knownCount, 1);
  });

  test("offline review queues the deck's cards and reschedules grades locally", async () => {
    const review = await loadReviewData(7, 50);
    assert.equal(review.offline, true);
    assert.equal(review.counts.newCards, 3, "nothing has a schedule yet");
    assert.deepEqual(review.queue.map((card) => card.cardId), [70, 71, 72]);

    await applyLocalGrades([{ cardId: 70, sessionId: 7, grade: "good" }]);
    const srs = await readSrsRecords();
    assert.equal(srs.length, 1);
    assert.equal(srs[0].cardId, 70);
    assert.ok(new Date(srs[0].dueAt).getTime() > Date.now(), "scheduled into the future");
    assert.equal(countDueNow(srs), 0);

    // The replayed payload is exactly what the server's POST /api/review wants.
    assert.equal(
      await sendOrQueueWrite("/api/review", "POST", {
        reviews: [{ cardId: 70, sessionId: 7, grade: "good", reviewedAt: iso(0) }],
      }),
      "queued"
    );
  });

  test("only replayable writes are queued — deck edits are refused", async () => {
    const before = await readOutboxCount();
    assert.equal(await sendOrQueueWrite("/api/sessions", "POST", { title: "New deck" }), "rejected");
    assert.equal(await sendOrQueueWrite("/api/sessions/7", "DELETE", undefined), "rejected");
    assert.equal(await sendOrQueueWrite("/api/sessions/7", "PATCH", { title: "Renamed" }), "rejected");
    assert.equal(await readOutboxCount(), before, "nothing extra was queued");

    // …while the three study writes are accepted.
    assert.equal(await enqueueOfflineWrite("/api/stats/results", "POST", { results: [{ cardId: 70 }] }), true);
    assert.equal(await enqueueOfflineWrite("/api/sessions/7", "PATCH", { cardId: 71, isKnown: true }), true);
    const queue = await readOutbox();
    assert.deepEqual(queue.map((entry) => entry.kind).sort(), ["progress", "review", "stats"]);
  });

  test("reconnecting drains the outbox in order and reports what synced", async () => {
    const bodies = [];
    respond = async (url) => {
      bodies.push(url);
      return jsonResponse({ success: true, recorded: 1 });
    };
    online();
    noteNetworkResult(true); // the probe succeeded

    const result = await flushOfflineQueue();
    assert.equal(result.networkFailed, false);
    assert.equal(result.authFailed, false);
    assert.ok(result.syncedEntries >= 3, `expected the queued answers to sync (got ${result.syncedEntries})`);
    assert.equal(result.remaining, 0);
    assert.equal((await readOutbox()).length, 0);
    // One request per batch kind, not one per answer.
    assert.ok(bodies.includes("/api/review"), "review grades replayed");
    assert.ok(bodies.includes("/api/stats/results"), "study outcomes replayed");
    assert.ok(bodies.some((url) => url.startsWith("/api/sessions/7")), "progress replayed");
  });

  test("a server that answers 401 keeps the queue for the next sign-in", async () => {
    offline();
    await sendOrQueueWrite("/api/review", "POST", {
      reviews: [{ cardId: 71, sessionId: 7, grade: "again", reviewedAt: iso(0) }],
    });
    respond = async () => jsonResponse({ error: "Please sign in to continue" }, 401);
    online();
    noteNetworkResult(true);

    const result = await flushOfflineQueue();
    assert.equal(result.authFailed, true);
    assert.equal(result.syncedEntries, 0);
    assert.equal(await readOutboxCount(), 1, "the grade is still queued");
  });

  test("online reads hydrate the cache from the API", async () => {
    const apiDeck = {
      session: { ...DECK.session, title: "Cell Biology (updated)" },
      cards: DECK.cards,
      progress: [{ cardId: 70, isKnown: true, attempts: 2 }],
    };
    respond = async (url) => {
      if (url.includes("/api/sessions/7")) return jsonResponse(apiDeck);
      if (url.includes("/api/review")) {
        return jsonResponse({
          now: iso(0),
          sessionId: 7,
          counts: { due: 1, learning: 0, tracked: 1, newCards: 2, newRemainingToday: 2, newIntroducedToday: 0, newPerDay: 20 },
          nextDueAt: null,
          decks: [{ sessionId: 7, title: "Cell Biology", cardCount: 3, trackedCount: 1, dueCount: 1, newCount: 2, nextDueAt: null, nextDueLabel: "now" }],
          queue: [
            {
              cardId: 70,
              sessionId: 7,
              question: "Powerhouse?",
              answer: "Mitochondria",
              hint: null,
              difficulty: "easy",
              deckTitle: "Cell Biology",
              isNew: false,
              dueAt: iso(-HOUR),
              state: { ease: 2.6, intervalDays: 0, reps: 1, lapses: 0, learningStep: 1, reviewCount: 1, lastGrade: "good" },
            },
          ],
        });
      }
      throw new TypeError("Failed to fetch");
    };
    online();
    noteNetworkResult(true);

    const deck = await loadDeckForStudy(7);
    assert.equal(deck.offline, false);
    assert.equal(deck.session.title, "Cell Biology (updated)");
    const cached = (await readDecks()).find((entry) => entry.id === 7);
    assert.equal(cached.title, "Cell Biology (updated)", "the snapshot was refreshed");

    const review = await loadReviewData(7, 50);
    assert.equal(review.offline, false);
    assert.equal(review.counts.due, 1);
    const srs = await readSrsRecords();
    const row = srs.find((entry) => entry.cardId === 70);
    assert.equal(row.state.learningStep, 1, "the server's schedule is mirrored locally");
  });

  test("signing out purges the profile, the decks and the queue", async () => {
    await purgeOfflineData();
    assert.equal(await readCachedProfile(), null);
    assert.deepEqual(await readDecks(), []);
    assert.equal(await readOutboxCount(), 0);
    const readiness = await readOfflineReadiness();
    assert.equal(readiness.deckCount, 0);
  });
});
