#!/usr/bin/env node
/**
 * Tests for offline mode — `src/lib/offline-core.ts` (the deterministic half of
 * the feature) plus the contract it shares with `public/sw.js`.
 *
 * No database, no network, no browser: the core is pure (storage and `fetch`
 * are injected), so every case below is deterministic. What is covered:
 *
 *   - the offline review queue is the API's twin: overdue first, then a daily
 *     helping of new cards, capped by the limit and by NEW_CARDS_PER_DAY
 *   - grading offline reschedules a card locally and it leaves the queue
 *   - deck snapshots keep progress, pinned decks stay pinned
 *   - the outbox batches ≤100 entries per request, collapses repeat progress
 *     writes, and never reorders answers
 *   - the drain policy: 2xx deletes, network/401/5xx keep, other 4xx drop
 *   - `public/sw.js` still speaks the same IndexedDB/queue protocol as the app
 *     (its own `planFlush` is extracted and run against the same inputs)
 *
 * Usage:
 *   npm run test:offline
 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const {
  MAX_BATCH,
  MAX_OUTBOX_ITEMS,
  OFFLINE_DB_NAME,
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
  flushBackoffMs,
  flushQueue,
  formatSavedAgo,
  isOfflineModeEnabled,
  mergeDeckSnapshot,
  outboxSize,
  planFlush,
  profileFromUser,
  queueKey,
  setOfflineMode,
} = await import("../src/lib/offline-core.ts");

const { scheduleCard } = await import("../src/lib/srs.ts");

const swSource = readFileSync(join(root, "public/sw.js"), "utf8");

// ── Fixtures ─────────────────────────────────────────────────────────────────
const NOW = new Date("2026-09-15T12:00:00.000Z");
const iso = (offsetMs) => new Date(NOW.getTime() + offsetMs).toISOString();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const card = (id, question, orderIndex = 0) => ({
  id,
  question,
  answer: `Answer ${id}`,
  hint: null,
  difficulty: "medium",
  orderIndex,
});

const deck = (overrides = {}) =>
  buildOfflineDeck({
    session: {
      id: overrides.id ?? 1,
      title: overrides.title ?? "Biology",
      sourceType: "pdf",
      summary: null,
      createdAt: overrides.createdAt ?? iso(-7 * DAY),
    },
    cards: overrides.cards ?? [card(1, "Q1"), card(2, "Q2"), card(3, "Q3")],
    progress: overrides.progress ?? [],
    pinned: overrides.pinned ?? false,
    now: NOW,
  });

const srsRow = (overrides = {}) => ({
  cardId: overrides.cardId ?? 1,
  sessionId: overrides.sessionId ?? 1,
  dueAt: overrides.dueAt ?? iso(-HOUR),
  lastReviewedAt: overrides.lastReviewedAt ?? iso(-2 * DAY),
  introducedAt: overrides.introducedAt ?? iso(-3 * DAY),
  state: {
    ease: 2.5,
    intervalDays: overrides.intervalDays ?? 3,
    reps: 2,
    lapses: 0,
    learningStep: 0,
    reviewCount: overrides.reviewCount ?? 3,
    lastGrade: "good",
  },
});

const write = (overrides = {}) => ({
  url: overrides.url ?? "/api/review",
  method: overrides.method ?? "POST",
  kind: overrides.kind ?? "review",
  body: overrides.body ?? { reviews: [{ cardId: 1, sessionId: 1, grade: "good" }] },
  createdAt: overrides.createdAt ?? NOW.toISOString(),
  attempts: 0,
  ...(overrides.seq === undefined ? {} : { seq: overrides.seq }),
});

// ── Identity ─────────────────────────────────────────────────────────────────
describe("identity cache", () => {
  test("a session user becomes a cacheable profile", () => {
    const profile = profileFromUser(
      { id: "u1", name: "Ada", email: "ada@example.com", image: "https://x/y.png" },
      NOW
    );
    assert.deepEqual(profile, {
      id: "u1",
      name: "Ada",
      email: "ada@example.com",
      image: "https://x/y.png",
      savedAt: NOW.toISOString(),
    });
  });

  test("without an id there is nothing to cache (signed out)", () => {
    assert.equal(profileFromUser({ name: "Ada" }, NOW), null);
  });

  test("offline mode is a localStorage flag that survives a failed write", () => {
    const store = new Map();
    const storage = {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, value),
      removeItem: (key) => store.delete(key),
    };
    assert.equal(isOfflineModeEnabled(storage), false);
    setOfflineMode(storage, true);
    assert.equal(store.get(OFFLINE_MODE_KEY), "1");
    assert.equal(isOfflineModeEnabled(storage), true);
    setOfflineMode(storage, false);
    assert.equal(isOfflineModeEnabled(storage), false);
    // Private mode: storage that throws must not crash the app.
    const hostile = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    assert.equal(isOfflineModeEnabled(hostile), false);
    assert.doesNotThrow(() => setOfflineMode(hostile, true));
  });
});

// ── Deck snapshots ───────────────────────────────────────────────────────────
describe("deck snapshots", () => {
  test("cards are stored in author order and metadata is preserved", () => {
    const snapshot = buildOfflineDeck({
      session: { id: 9, title: " Sets ", sourceType: "docx", createdAt: iso(0) },
      cards: [card(2, "second", 1), card(1, "first", 0)],
      progress: [{ cardId: 1, isKnown: true, attempts: 2 }],
      now: NOW,
    });
    assert.deepEqual(snapshot.cards.map((c) => c.id), [1, 2]);
    assert.equal(snapshot.id, 9);
    assert.equal(snapshot.pinned, false);
    assert.equal(snapshot.savedAt, NOW.toISOString());
    assert.deepEqual(snapshot.progress, [{ cardId: 1, isKnown: true, attempts: 2 }]);
  });

  test("merging keeps the pin and the richer progress", () => {
    const pinned = { ...deck(), pinned: true, progress: [{ cardId: 1, isKnown: true, attempts: 1 }] };
    const fresh = { ...deck(), pinned: false, progress: [] };
    const merged = mergeDeckSnapshot(pinned, fresh);
    assert.equal(merged.pinned, true, "downloading everything must not unpin a set");
    assert.equal(merged.progress.length, 1, "local progress is not dropped by a stale server copy");
  });

  test("offline progress upserts one card and counts attempts", () => {
    const before = deck({ progress: [{ cardId: 1, isKnown: false, attempts: 1 }] });
    const after = applyProgressToDeck(before, { cardId: 1, isKnown: true });
    assert.deepEqual(after.progress, [{ cardId: 1, isKnown: true, attempts: 2 }]);
    const added = applyProgressToDeck(after, { cardId: 2, isKnown: true });
    assert.equal(added.progress.length, 2);
  });

  test("the session list is rebuilt newest-first with the right counts", () => {
    const older = deck({ id: 1, title: "Old", createdAt: iso(-30 * DAY) });
    const newer = deck({
      id: 2,
      title: "New",
      createdAt: iso(-DAY),
      cards: [card(10, "a", 0), card(11, "b", 1)],
      progress: [{ cardId: 10, isKnown: true, attempts: 3 }],
    });
    const rows = buildOfflineSessionRows(
      [older, newer],
      [
        srsRow({ cardId: 1, sessionId: 1, dueAt: iso(-MINUTE) }),
        srsRow({ cardId: 10, sessionId: 2, dueAt: iso(2 * DAY) }),
      ],
      NOW
    );
    assert.deepEqual(rows.map((row) => row.title), ["New", "Old"]);
    assert.equal(rows[0].cardCount, 2);
    assert.equal(rows[0].knownCount, 1);
    assert.equal(rows[0].dueCount, 0);
    assert.equal(rows[0].trackedCount, 1);
    assert.equal(rows[1].dueCount, 1);
  });

  test("accounting helpers: due-now count and human dates", () => {
    const rows = [
      srsRow({ cardId: 1, dueAt: iso(-MINUTE) }),
      srsRow({ cardId: 2, dueAt: iso(HOUR) }),
    ];
    assert.equal(countDueNow(rows, NOW), 1);
    assert.equal(formatSavedAgo(iso(-10 * MINUTE), NOW), "10 min ago");
    assert.equal(formatSavedAgo(iso(-3 * HOUR), NOW), "3 h ago");
    assert.equal(formatSavedAgo(null, NOW), "not saved yet");
  });
});

// ── Offline spaced repetition ────────────────────────────────────────────────
describe("offline review queue", () => {
  test("overdue cards come first, ordered by how late they are", () => {
    const data = buildOfflineReviewData({
      decks: [deck({ cards: [card(1, "a", 0), card(2, "b", 1), card(3, "c", 2)] })],
      srs: [
        srsRow({ cardId: 1, dueAt: iso(-MINUTE) }),
        srsRow({ cardId: 2, dueAt: iso(-2 * DAY) }),
      ],
      now: NOW,
      limit: 50,
    });
    assert.deepEqual(data.queue.map((c) => c.cardId), [2, 1, 3]);
    assert.deepEqual(data.queue.map((c) => c.isNew), [false, false, true]);
    assert.equal(data.queue[2].state, null);
    assert.equal(data.counts.due, 2);
    assert.equal(data.counts.tracked, 2);
    assert.equal(data.counts.newCards, 1);
  });

  test("new cards are throttled by the daily allowance and the limit", () => {
    const many = deck({ cards: Array.from({ length: 30 }, (_, i) => card(i + 1, `q${i}`, i)) });
    const data = buildOfflineReviewData({ decks: [many], srs: [], now: NOW, limit: 100 });
    assert.equal(data.queue.length, data.counts.newPerDay, "one day's helping of new cards");
    assert.equal(data.counts.newRemainingToday, data.counts.newPerDay);

    const introduced = Array.from({ length: 5 }, (_, i) =>
      srsRow({
        cardId: i + 1,
        intervalDays: 1,
        reviewCount: 1,
        lastReviewedAt: iso(-HOUR),
        dueAt: iso(DAY),
      })
    );
    const after = buildOfflineReviewData({ decks: [many], srs: introduced, now: NOW, limit: 100 });
    assert.equal(after.counts.newIntroducedToday, 5);
    assert.equal(after.counts.newRemainingToday, data.counts.newPerDay - 5);
    assert.equal(after.queue.length, data.counts.newPerDay - 5);
  });

  test("a deck filter scopes both the queue and the counts", () => {
    const decks = [
      deck({ id: 1, title: "One", cards: [card(1, "a"), card(2, "b")] }),
      deck({ id: 2, title: "Two", cards: [card(3, "c"), card(4, "d")] }),
    ];
    const srs = [srsRow({ cardId: 1, sessionId: 1, dueAt: iso(-HOUR) })];
    const scoped = buildOfflineReviewData({ decks, srs, sessionId: 2, now: NOW, limit: 50 });
    assert.deepEqual(scoped.queue.map((c) => c.sessionId), [2, 2]);
    assert.equal(scoped.counts.due, 0);
    assert.equal(scoped.decks.length, 1);

    const all = buildOfflineReviewData({ decks, srs, now: NOW, limit: 50 });
    assert.equal(all.counts.due, 1);
    assert.equal(all.decks.length, 2);
    assert.equal(all.queue[0].deckTitle, "One");
  });

  test("grading offline reschedules the card and drops it out of the queue", () => {
    const snapshot = deck({ cards: [card(1, "a")] });
    const graded = applyGradeToSrs([], { cardId: 1, sessionId: 1, grade: "good" }, NOW);
    assert.equal(graded.length, 1);
    assert.equal(graded[0].state.reviewCount, 1);
    assert.equal(graded[0].introducedAt, NOW.toISOString());

    // "Good" on a brand-new card walks it to the 10-minute learning step, so
    // it is due again ten minutes later — and not before.
    const soon = new Date(NOW.getTime() + 11 * MINUTE);
    const queued = buildOfflineReviewData({ decks: [snapshot], srs: graded, now: soon, limit: 10 });
    assert.equal(queued.queue.length, 1);
    assert.equal(queued.queue[0].isNew, false);
    assert.equal(queued.counts.newCards, 0);

    // …and not due a second after the step was scheduled.
    const early = buildOfflineReviewData({
      decks: [snapshot],
      srs: graded,
      now: new Date(NOW.getTime() + 1000),
      limit: 10,
    });
    assert.equal(early.queue.length, 0);
    assert.equal(early.nextDueAt, graded[0].dueAt);

    // Repeated grades keep the original introduction date (the daily budget).
    const again = applyGradeToSrs(graded, { cardId: 1, sessionId: 1, grade: "easy" }, soon);
    assert.equal(again[0].introducedAt, NOW.toISOString());
    assert.equal(again[0].state.lastGrade, "easy");
    assert.ok(again[0].state.intervalDays >= 4, "Easy graduates a learning card to ~4 days");
  });

  test("the local schedule matches the server's for the same grades", () => {
    const grades = ["good", "good", "hard", "good", "again", "good"];
    let serverState = null;
    let local = [];
    let at = NOW;
    for (const grade of grades) {
      serverState = scheduleCard(serverState, grade, at);
      local = applyGradeToSrs(local, { cardId: 7, sessionId: 1, grade }, at);
      assert.equal(local[0].state.ease, serverState.ease);
      assert.equal(local[0].state.intervalDays, serverState.intervalDays);
      assert.equal(local[0].state.reps, serverState.reps);
      assert.equal(local[0].state.learningStep, serverState.learningStep);
      assert.equal(local[0].dueAt, serverState.dueAt.toISOString());
      at = new Date(at.getTime() + HOUR);
    }
  });
});

// ── Outbox: what may be queued ───────────────────────────────────────────────
describe("queueable writes", () => {
  test("the three replayable writes are recognised", () => {
    assert.equal(describeQueueableWrite("/api/stats/results", "POST").kind, "stats");
    assert.equal(describeQueueableWrite("/api/review", "POST").kind, "review");
    assert.equal(
      describeQueueableWrite("/api/sessions/12", "PATCH", { cardId: 3, isKnown: true }).kind,
      "progress"
    );
    assert.equal(describeQueueableWrite("https://app.example/api/review", "post").kind, "review");
  });

  test("everything that needs the network is refused", () => {
    assert.equal(describeQueueableWrite("/api/sessions", "POST"), null, "creating a deck");
    assert.equal(describeQueueableWrite("/api/sessions/12", "DELETE"), null);
    assert.equal(describeQueueableWrite("/api/sessions/12/cards", "PUT"), null);
    assert.equal(describeQueueableWrite("/api/sessions/12/cards/3", "PATCH", { cardId: 1, isKnown: true }), null);
    // A rename on the same route is a *deck* edit, not card progress.
    assert.equal(describeQueueableWrite("/api/sessions/12", "PATCH", { title: "New" }), null);
    assert.equal(describeQueueableWrite("/api/sessions/12", "PATCH", { cardId: "3", isKnown: true }), null);
    assert.equal(describeQueueableWrite("/api/sessions/12", "PATCH", { cardId: 3, isKnown: "yes" }), null);
    assert.equal(describeQueueableWrite("/api/review", "GET"), null);
    assert.equal(describeQueueableWrite("not a url", "POST"), null);
  });

  test("the outbox caps itself, dropping the oldest entries", () => {
    let queue = [];
    for (let i = 0; i < MAX_OUTBOX_ITEMS + 25; i++) {
      queue = enqueueWrite(queue, { url: "/api/review", method: "POST", kind: "review", body: { reviews: [] } });
    }
    assert.equal(queue.length, MAX_OUTBOX_ITEMS);
  });

  test("sizes are counted in answers, not requests", () => {
    const queue = [
      write({ body: { reviews: [{ cardId: 1 }, { cardId: 2 }] } }),
      write({ body: { results: [{ cardId: 3 }] }, kind: "stats", url: "/api/stats/results" }),
      write({ kind: "progress", method: "PATCH", url: "/api/sessions/1", body: { cardId: 9, isKnown: true } }),
    ];
    assert.equal(outboxSize(queue), 4);
  });
});

// ── Outbox: draining ─────────────────────────────────────────────────────────
describe("outbox draining", () => {
  const ok = () => Promise.resolve({ ok: true, status: 200 });
  const status = (code) => () => Promise.resolve({ ok: code < 400, status: code });
  const boom = () => Promise.reject(new TypeError("Failed to fetch"));

  test("batches merge up to the API's limit and keep their order", async () => {
    const queue = Array.from({ length: 150 }, (_, i) =>
      write({ seq: i + 1, body: { reviews: [{ cardId: i + 1, sessionId: 1, grade: "good" }] } })
    );
    const plans = planFlush(queue);
    assert.equal(plans.length, 2, "150 grades = a full batch + a remainder");
    assert.equal(plans[0].body.reviews.length, MAX_BATCH);
    assert.equal(plans[1].body.reviews.length, 50);
    assert.deepEqual(
      plans[0].body.reviews.map((r) => r.cardId).slice(0, 3),
      [1, 2, 3],
      "answers replay in the order they were given"
    );

    const seen = [];
    const result = await flushQueue({
      queue,
      fetchImpl: async (url, init) => {
        seen.push(JSON.parse(init.body).reviews.map((r) => r.cardId));
        return { ok: true, status: 200 };
      },
    });
    assert.equal(result.syncedEntries, 150);
    assert.equal(result.syncedKeys.length, 150);
    assert.equal(seen.length, 2);
    assert.equal(seen[0].length + seen[1].length, 150);
  });

  test("repeat progress writes for one card collapse to the newest", async () => {
    const queue = [
      write({ seq: 1, kind: "progress", method: "PATCH", url: "/api/sessions/1", body: { cardId: 5, isKnown: true } }),
      write({ seq: 2, kind: "progress", method: "PATCH", url: "/api/sessions/1", body: { cardId: 5, isKnown: false } }),
      write({ seq: 3, kind: "progress", method: "PATCH", url: "/api/sessions/1", body: { cardId: 6, isKnown: true } }),
    ];
    const plans = planFlush(queue);
    assert.equal(plans.length, 2, "one PATCH per card");
    assert.deepEqual(plans[0].body, { cardId: 5, isKnown: false }, "last write wins");
    assert.deepEqual(plans[0].keys, [2]);
    assert.deepEqual(plans[1].keys, [3]);
  });

  test("different kinds never merge into one request", () => {
    const queue = [
      write({ seq: 1, body: { reviews: [{ cardId: 1 }] } }),
      write({ seq: 2, kind: "stats", url: "/api/stats/results", body: { results: [{ cardId: 2 }] } }),
      write({ seq: 3, body: { reviews: [{ cardId: 3 }] } }),
    ];
    const plans = planFlush(queue);
    assert.deepEqual(plans.map((plan) => plan.kind), ["review", "stats", "review"]);
    assert.deepEqual(plans.map((plan) => plan.keys), [[1], [2], [3]]);
  });

  test("a successful drain returns the keys it delivered", async () => {
    const queue = [write({ seq: 11 }), write({ seq: 12 })];
    const result = await flushQueue({ queue, fetchImpl: ok });
    assert.deepEqual(result.syncedKeys, [11, 12]);
    assert.equal(result.networkFailed, false);
    assert.equal(result.authFailed, false);
  });

  test("no network keeps every queued answer", async () => {
    const queue = [write({ seq: 1 }), write({ seq: 2 })];
    const result = await flushQueue({ queue, fetchImpl: boom });
    assert.deepEqual(result.syncedKeys, []);
    assert.equal(result.networkFailed, true);
    assert.equal(result.authFailed, false);
  });

  test("an expired session stops the drain instead of losing the queue", async () => {
    const queue = [write({ seq: 1 }), write({ seq: 2 })];
    const result = await flushQueue({ queue, fetchImpl: status(401) });
    assert.deepEqual(result.syncedKeys, []);
    assert.equal(result.authFailed, true);
    assert.equal(result.networkFailed, false);
  });

  test("transient server errors keep the queue, invalid data is dropped", async () => {
    const transient = await flushQueue({ queue: [write({ seq: 1 })], fetchImpl: status(503) });
    assert.deepEqual(transient.syncedKeys, []);
    assert.equal(transient.networkFailed, false);
    assert.equal(transient.droppedKeys.length, 0, "a 503 must be retried, not thrown away");

    // Two *separate* requests (a batch of grades, then one progress PATCH), so
    // the first can fail without taking the second down with it.
    const poisoned = await flushQueue({
      queue: [
        write({ seq: 1, body: { reviews: [{ cardId: 1, sessionId: 1, grade: "good" }] } }),
        write({
          seq: 2,
          kind: "progress",
          method: "PATCH",
          url: "/api/sessions/1",
          body: { cardId: 9, isKnown: true },
        }),
      ],
      fetchImpl: (() => {
        let call = 0;
        return async () => {
          call += 1;
          return call === 1 ? { ok: false, status: 400 } : { ok: true, status: 200 };
        };
      })(),
    });
    assert.deepEqual(poisoned.droppedKeys, [1], "entry the server refuses is dropped");
    assert.deepEqual(poisoned.syncedKeys, [2], "…and the rest still syncs");
  });

  test("keys fall back to the array position for unsaved entries", () => {
    const queue = [write({}), write({ seq: 5 })];
    assert.equal(queueKey(queue[0], 0), "i0");
    assert.equal(queueKey(queue[1], 1), 5);
  });

  test("backoff grows, caps, and gates the next attempt", () => {
    assert.equal(flushBackoffMs(0), 0);
    assert.equal(flushBackoffMs(1), 30_000);
    assert.equal(flushBackoffMs(2), 60_000);
    assert.equal(flushBackoffMs(9), 10 * 60_000, "capped at ten minutes");
    assert.equal(canAttemptFlush({ lastFailureAt: null, attempts: 0 }, NOW), true);
    assert.equal(
      canAttemptFlush({ lastFailureAt: iso(-10_000), attempts: 1 }, NOW),
      false,
      "too soon after a failure"
    );
    assert.equal(canAttemptFlush({ lastFailureAt: iso(-60_000), attempts: 1 }, NOW), true);
  });
});

// ── Service-worker contract ──────────────────────────────────────────────────
describe("public/sw.js contract", () => {
  test("the same IndexedDB database and stores are used", () => {
    assert.ok(swSource.includes(`"${OFFLINE_DB_NAME}"`), "database name");
    assert.ok(swSource.includes(`const DB_VERSION = 1`), "database version");
    assert.ok(swSource.includes(`"${STORE_OUTBOX}"`), "outbox store");
    assert.ok(swSource.includes(`"${STORE_PROFILE}"`), "profile store");
    assert.ok(swSource.includes(`"${STORE_DECKS}"`), "decks store");
    assert.ok(swSource.includes(`"${STORE_SRS}"`), "srs store");
    assert.ok(swSource.includes(`"${STORE_META}"`), "meta store");
    assert.ok(swSource.includes(`keyPath: "seq", autoIncrement: true`), "outbox keyPath");
  });

  test("the background-sync tag and queueable routes match the app", () => {
    assert.ok(swSource.includes(`"quiztime-outbox"`), "sync tag");
    assert.ok(swSource.includes(`"/api/stats/results"`));
    assert.ok(swSource.includes(`"/api/review"`));
    assert.ok(swSource.includes(`/^\\/api\\/sessions\\/\\d+$/`), "progress PATCH matcher");
    assert.ok(swSource.includes(`"Content-Type": "application/json"`));
  });

  test("the worker's planFlush mirrors the app's batching", () => {
    const start = swSource.indexOf("function planFlush(");
    assert.ok(start > 0, "planFlush found in public/sw.js");
    const end = swSource.indexOf("\n}", start);
    assert.ok(end > start, "planFlush is a top-level function");
    const swPlan = new Function(
      "MAX_BATCH",
      `${swSource.slice(start, end + 2)}; return planFlush;`
    )(MAX_BATCH);

    const queues = [
      [write({ seq: 1 }), write({ seq: 2 })],
      Array.from({ length: 130 }, (_, i) =>
        write({ seq: i + 1, body: { reviews: [{ cardId: i + 1 }] } })
      ),
      [
        write({ seq: 1, body: { reviews: [{ cardId: 1 }] } }),
        write({ seq: 2, kind: "stats", url: "/api/stats/results", body: { results: [{ cardId: 2 }] } }),
      ],
      [
        write({ seq: 1, kind: "progress", method: "PATCH", url: "/api/sessions/1", body: { cardId: 5, isKnown: true } }),
        write({ seq: 2, kind: "progress", method: "PATCH", url: "/api/sessions/1", body: { cardId: 5, isKnown: false } }),
      ],
    ];

    for (const queue of queues) {
      const app = planFlush(queue).map((plan) => ({ url: plan.url, body: plan.body }));
      const sw = swPlan(queue).map((plan) => ({ url: plan.url, body: plan.body }));
      assert.deepEqual(sw, app, "sw.js and offline-core.ts must batch identically");
    }
  });

  test("no-cache headers keep the worker itself fresh", () => {
    const config = readFileSync(join(root, "next.config.ts"), "utf8");
    assert.ok(config.includes("/sw.js"), "sw.js is served no-cache");
    assert.ok(config.includes("Service-Worker-Allowed"), "scope header present");
  });
});

// ── The service worker, executed ─────────────────────────────────────────────
/**
 * `public/sw.js` is the only part of offline mode that can't be driven from the
 * app, so it is run here for real: the script is evaluated against a fake
 * `ServiceWorkerGlobalScope` (plus minimal Cache Storage and IndexedDB fakes),
 * and the handlers it registers are dispatched with real `Request`/`Response`
 * objects. That covers the paths a unit test of the app can't reach — the
 * cached session that makes "open my account offline" work, and the offline
 * write that must be queued instead of lost.
 */
describe("public/sw.js executed in a worker scope", () => {
  const ORIGIN = "https://quiztime.test";

  const createCaches = () => {
    const stores = new Map();
    const key = (request) => new URL(typeof request === "string" ? request : request.url, ORIGIN).href;
    const open = async (name) => {
      const store = stores.get(name) ?? new Map();
      stores.set(name, store);
      return {
        // Every read clones: the real Cache Storage replays an entry from disk
        // with a fresh body, so a stored response can be read more than once.
        match: async (request) => {
          const hit = store.get(key(request));
          return hit ? hit.clone() : undefined;
        },
        put: async (request, response) => {
          store.set(key(request), response.clone());
        },
        delete: async (request) => store.delete(key(request)),
        keys: async () => [...store.keys()],
      };
    };
    return {
      open,
      keys: async () => [...stores.keys()],
      delete: async (name) => stores.delete(name),
      /** Peek at one cache without going through the worker. */
      peek: async (name, key2) => {
        const hit = stores.get(name)?.get(new URL(key2, ORIGIN).href);
        return hit ? hit.clone() : undefined;
      },
    };
  };

  /**
   * As much of IndexedDB as the worker uses: `open` + one store per name, with
   * the request/tx event callbacks the code attaches to.
   */
  const createIdb = () => {
    const stores = new Map();
    // Like a real autoIncrement key generator: it lives with the data, not with
    // one connection, so re-opening the database keeps counting.
    let autoSeq = 0;
    const makeRequest = (run) => {
      const request = { result: undefined, error: null, onsuccess: null, onerror: null };
      queueMicrotask(() => {
        try {
          request.result = run();
          request.onsuccess?.();
        } catch (error) {
          request.error = error;
          request.onerror?.();
        }
      });
      return request;
    };
    const openDatabase = (name, version) => {
      const request = { result: undefined, error: null, onupgradeneeded: null, onsuccess: null, onerror: null };
      const contents = stores.get(name) ?? new Map();
      stores.set(name, contents);
      const db = {
        objectStoreNames: { contains: (store) => contents.has(store) },
        createObjectStore: (store) => contents.set(store, new Map()),
        close: () => {},
        transaction: (store) => {
          const rows = contents.get(store);
          const tx = { oncomplete: null, objectStore: () => ({
            put: (value) =>
              makeRequest(() => {
                const key2 = value.seq ?? value.id ?? value.cardId ?? value.key ?? ++autoSeq;
                rows.set(key2, { ...value, seq: typeof value.seq === "number" ? value.seq : key2 });
                return key2;
              }),
            getAll: () => makeRequest(() => [...rows.values()]),
            delete: (id) => makeRequest(() => rows.delete(id)),
            clear: () => makeRequest(() => rows.clear()),
          }) };
          queueMicrotask(() => queueMicrotask(() => tx.oncomplete?.()));
          return tx;
        },
      };
      queueMicrotask(() => {
        request.result = db;
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    };
    return { open: openDatabase, rows: (store) => [...(stores.get("quiztime-offline")?.get(store)?.values() ?? [])] };
  };

  const createScope = () => {
    const listeners = new Map();
    const registrations = [];
    const messages = [];
    return {
      location: { href: `${ORIGIN}/sw.js`, origin: ORIGIN },
      registration: { sync: { register: async (tag) => registrations.push(tag) } },
      clients: {
        claim: async () => {},
        matchAll: async () => [{ postMessage: (message) => messages.push(message) }],
      },
      addEventListener: (type, handler) =>
        listeners.set(type, [...(listeners.get(type) ?? []), handler]),
      skipWaiting: async () => {},
      listeners,
      registrations,
      messages,
    };
  };

  /** Evaluate public/sw.js against the fakes and hand back its internals. */
  const loadWorker = (scope, { caches, indexedDB, fetchImpl }) => {
    const factory = new Function(
      "self",
      "caches",
      "indexedDB",
      "fetch",
      `${swSource}
       return {
         planFlush,
         isQueueableRoute,
         describeQueueableWrite,
         handleWrite,
         drainOutbox,
         SHELL_CACHE,
         DATA_CACHE,
       };`
    );
    return factory(scope, caches, indexedDB, fetchImpl);
  };

  const dispatch = (scope, type, event) => {
    for (const handler of scope.listeners.get(type) ?? []) handler(event);
  };

  /** Fire a fetch event and return what the worker answered (or undefined). */
  const dispatchFetch = async (scope, request) => {
    let answered;
    dispatch(scope, "fetch", { request, respondWith: (value) => (answered = value), waitUntil: () => {} });
    if (answered === undefined) return undefined;
    return answered;
  };

  const jsonResponse = (payload, status = 200) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  const makeWorker = ({ network = true, fetchImpl } = {}) => {
    const scope = createScope();
    const caches = createCaches();
    const indexedDB = createIdb();
    const calls = [];
    const worker = loadWorker(scope, {
      caches,
      indexedDB,
      fetchImpl: async (request, init) => {
        const url = typeof request === "string" ? request : request.url;
        const method =
          (typeof request === "string" ? init?.method : request.method) || "GET";
        calls.push({ url, method: method.toUpperCase() });
        if (fetchImpl) return fetchImpl(request, url, init);
        if (!network) throw new TypeError("Failed to fetch");
        return jsonResponse({ ok: true });
      },
    });
    return { scope, caches, indexedDB, calls, worker };
  };

  test("the script registers its lifecycle, fetch, sync and message handlers", () => {
    const { scope } = makeWorker();
    for (const type of ["install", "activate", "fetch", "message", "sync"]) {
      assert.ok((scope.listeners.get(type) ?? []).length > 0, `${type} handler registered`);
    }
  });

  test("a signed-in session is cached and then served with the network down", async () => {
    const session = { user: { id: "u1", name: "Student" }, expires: "2099-01-01T00:00:00.000Z" };
    let networkUp = true;
    const { scope, caches, worker } = makeWorker({
      fetchImpl: async () => {
        if (!networkUp) throw new TypeError("Failed to fetch");
        return jsonResponse(session);
      },
    });

    // Online: Auth.js' own request is answered and stored in the background.
    const online = await dispatchFetch(scope, new Request(`${ORIGIN}/api/auth/session`));
    assert.equal(online.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 0)); // let the write settle
    const stored = await caches.peek(worker.DATA_CACHE, `${ORIGIN}/api/auth/session`);
    assert.ok(stored, "the session response was written to the data cache");
    assert.deepEqual(await stored.json(), session, "the stored copy is readable, not a spent body");

    // Offline: the cached copy answers — this is what keeps the account open.
    networkUp = false;
    const offline = await dispatchFetch(scope, new Request(`${ORIGIN}/api/auth/session`));
    assert.equal(offline.status, 200);
    assert.deepEqual(await offline.json(), session);
  });

  test("a session without a user is never cached", async () => {
    const { scope, caches, worker } = makeWorker({
      fetchImpl: async () => jsonResponse({ user: null }),
    });
    const response = await dispatchFetch(scope, new Request(`${ORIGIN}/api/auth/session`));
    assert.equal(response.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(
      await caches.peek(worker.DATA_CACHE, `${ORIGIN}/api/auth/session`),
      undefined,
      "signed-out sessions are not kept"
    );
  });

  test("an offline review grade is queued in IndexedDB and answers 202", async () => {
    const { scope, indexedDB } = makeWorker({ network: false });
    const request = new Request(`${ORIGIN}/api/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reviews: [{ cardId: 9, sessionId: 3, grade: "good" }] }),
    });

    const response = await dispatchFetch(scope, request);
    assert.ok(response, "the worker answered instead of failing the request");
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { queued: true, offline: true });

    const rows = indexedDB.rows("outbox");
    assert.equal(rows.length, 1);
    assert.deepEqual(
      { url: rows[0].url, method: rows[0].method, kind: rows[0].kind, body: rows[0].body },
      {
        url: "/api/review",
        method: "POST",
        kind: "review",
        body: { reviews: [{ cardId: 9, sessionId: 3, grade: "good" }] },
      }
    );
    assert.ok(scope.registrations.includes("quiztime-outbox"), "background sync was registered");
    assert.ok(
      scope.messages.some((message) => message.type === "OUTBOX_QUEUED"),
      "open windows are told so the pending counter updates"
    );
  });

  test("a write that cannot be replayed is never swallowed", async () => {
    const { scope, indexedDB } = makeWorker({ network: false });
    const request = new Request(`${ORIGIN}/api/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });

    await assert.rejects(
      () => dispatchFetch(scope, request),
      /Failed to fetch/,
      "uploads fail loudly — the app must not think a deck was created"
    );
    assert.equal(indexedDB.rows("outbox").length, 0);
  });

  test("queueable writes pass straight through while online", async () => {
    const { scope, indexedDB, calls } = makeWorker({
      fetchImpl: async () => jsonResponse({ recorded: 1 }),
    });
    const request = new Request(`${ORIGIN}/api/stats/results`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ results: [{ cardId: 1, sessionId: 2, correct: true }] }),
    });

    const response = await dispatchFetch(scope, request);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { recorded: 1 });
    assert.equal(calls.length, 1);
    assert.equal(indexedDB.rows("outbox").length, 0, "nothing queued when the network works");
  });

  test("the shell is cached and replayed offline, falling back to / for deep links", async () => {
    const page = () =>
      new Response("<!doctype html><title>QuizTime</title>", {
        headers: { "Content-Type": "text/html" },
      });
    let networkUp = true;
    const { scope } = makeWorker({
      fetchImpl: async () => {
        if (!networkUp) throw new TypeError("Failed to fetch");
        return page();
      },
    });

    // A browser marks navigations with `mode: "navigate"`; that is what routes
    // a request to the shell handler.
    const navigation = (url) => {
      const request = new Request(url, { headers: { accept: "text/html" } });
      Object.defineProperty(request, "mode", { value: "navigate" });
      return request;
    };

    const online = await dispatchFetch(scope, navigation(`${ORIGIN}/`));
    assert.equal(online.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 0)); // let the write settle

    networkUp = false;
    const reloaded = await dispatchFetch(scope, navigation(`${ORIGIN}/`));
    assert.equal(await reloaded.text(), "<!doctype html><title>QuizTime</title>");

    // A URL that was never cached still boots the app from the cached shell.
    const deepLink = await dispatchFetch(scope, navigation(`${ORIGIN}/sessions`));
    assert.equal(await deepLink.text(), "<!doctype html><title>QuizTime</title>");
  });

  test("the drain replays the queue in one batched request and clears it", async () => {
    let networkUp = false;
    const sent = [];
    const { scope, indexedDB, worker } = makeWorker({
      fetchImpl: async (request, url, init) => {
        if (!networkUp) throw new TypeError("Failed to fetch");
        sent.push({ url, body: JSON.parse(init.body) });
        return jsonResponse({ recorded: true });
      },
    });

    // Two grades answered offline: queued by the worker while the tab was open.
    for (const cardId of [1, 2]) {
      const response = await dispatchFetch(
        scope,
        new Request(`${ORIGIN}/api/review`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reviews: [{ cardId, sessionId: 5, grade: "good" }] }),
        })
      );
      assert.equal(response.status, 202);
    }
    assert.equal(indexedDB.rows("outbox").length, 2);

    // Background sync fires (no tab needed): one request, queue cleared.
    networkUp = true;
    const result = await worker.drainOutbox();
    assert.equal(result.synced, 2);
    assert.equal(result.remaining, 0);
    assert.equal(result.failed, false);
    assert.equal(indexedDB.rows("outbox").length, 0);

    assert.equal(sent.length, 1, "both grades travelled in one request");
    assert.equal(sent[0].url, "/api/review");
    assert.deepEqual(sent[0].body, {
      reviews: [
        { cardId: 1, sessionId: 5, grade: "good" },
        { cardId: 2, sessionId: 5, grade: "good" },
      ],
    });
    assert.ok(
      scope.messages.some((message) => message.type === "OUTBOX_SYNCED" && message.synced === 2),
      "open windows are told so they can refresh"
    );
  });
});
