#!/usr/bin/env node
/**
 * E2E: offline study, against a real server and a real database.
 *
 * `scripts/offline.test.mjs` and `scripts/offline-client.test.mjs` prove the
 * logic and the module wiring with fake storage and fake responses. This suite
 * answers the question those can't: *does the whole offline round trip work
 * against the actual Next.js app?* It drives the real client module
 * (src/lib/offline.ts) over HTTP with an Auth.js session cookie, exactly like a
 * browser would, and checks the database afterwards to prove the queue landed.
 *
 * The fake browser is the same trick as the client tests: Node has no
 * IndexedDB/window, so `window`/`localStorage`/`navigator.onLine` are installed
 * before the module is imported (IndexedDB then falls back to its in-memory
 * backend) and `fetch` is proxied to the server — going "offline" simply makes
 * that proxy throw, which is what a browser does with no network.
 *
 * What it proves:
 *   1. `/api/offline/bundle` freezes decks + cards + progress + SRS schedules,
 *      and is scoped to the signed-in user (another account's deck is invisible)
 *   2. with the network down, the deck list, the deck itself and the review
 *      queue all resolve from that snapshot (including due/new accounting)
 *   3. offline writes to the three replayable routes are queued, local state is
 *      updated immediately, and nothing reaches the server
 *   4. coming back online drains the outbox and the grades/progress/outcomes
 *      really are in Postgres afterwards, with the schedule advanced by the
 *      same scheduler the server uses
 *   5. signing out purges the device copy
 *
 * Usage (server on $BASE_URL or spawned automatically):
 *   DATABASE_URL=... AUTH_SECRET=... npm run test:offline-e2e
 *   NPM_CMD=dev npm run test:offline-e2e      # spawn `npm run dev`
 *   BASE_URL=http://127.0.0.1:3000 npm run test:offline-e2e   # reuse a server
 *
 * Requires DATABASE_URL + AUTH_SECRET (same values the server uses).
 */
import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { encode } from "next-auth/jwt";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── Environment ──────────────────────────────────────────────────────────────
function loadEnvLocal() {
  try {
    for (const line of readFileSync(join(root, ".env.local"), "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  } catch {
    /* no .env.local — rely on the real environment */
  }
}
loadEnvLocal();

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const AUTH_SECRET = process.env.AUTH_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;
assert.ok(AUTH_SECRET, "AUTH_SECRET must be set (same value the server uses)");
assert.ok(DATABASE_URL, "DATABASE_URL must be set (same database the server uses)");

const COOKIE = "authjs.session-token"; // http (non-secure) cookie name in Auth.js v5
const USER = "offline-e2e-user-111111";
const OTHER = "offline-e2e-other-222222";

/** Mint a session JWT for a user id, the way Auth.js would after Google sign-in. */
const sessionTokenFor = (userId) =>
  encode({
    token: {
      userId,
      sub: userId,
      email: `${userId}@e2e.local`,
      name: `Offline ${userId.slice(-1)}`,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 60 * 60,
      jti: `offline-e2e-${userId}-${Date.now()}`,
    },
    secret: AUTH_SECRET,
    salt: "authjs.session-token",
  });

// ── Fake browser (must exist before src/lib/offline.ts is imported) ──────────
let networkUp = true;
let sessionToken = "";
const requests = [];
const windowListeners = new Map();
const localStore = new Map();

globalThis.window = {
  addEventListener(type, fn) {
    windowListeners.set(type, [...(windowListeners.get(type) ?? []), fn]);
  },
  removeEventListener(type, fn) {
    windowListeners.set(
      type,
      (windowListeners.get(type) ?? []).filter((entry) => entry !== fn)
    );
  },
  localStorage: {
    getItem: (key) => (localStore.has(key) ? localStore.get(key) : null),
    setItem: (key, value) => localStore.set(key, String(value)),
    removeItem: (key) => localStore.delete(key),
  },
  location: { replace() {} },
  // `online`/`offline` events: the test fires them, the module reacts.
  dispatchEvent(event) {
    for (const fn of windowListeners.get(event.type) ?? []) fn(event);
  },
};

Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { onLine: true },
});

/**
 * Every request the client module makes goes through here. Offline = the
 * promise rejects like a dead network (that is all a browser gives us), and the
 * session cookie is attached the way the browser jar would.
 */
const realFetch = globalThis.fetch; // captured before the override, or we'd recurse
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const target = url.startsWith("/") ? `${BASE_URL}${url}` : url;
  requests.push({ url: target, method: (init.method ?? "GET").toUpperCase() });
  if (!networkUp) throw new TypeError("Failed to fetch");
  const headers = new Headers(init.headers ?? {});
  if (sessionToken && target.startsWith(BASE_URL)) {
    headers.set("cookie", `${COOKIE}=${sessionToken}`);
  }
  return realFetch(target, { ...init, headers });
};

const goOffline = () => {
  networkUp = false;
  navigator.onLine = false;
  window.dispatchEvent({ type: "offline" });
};

/**
 * Back online: flip the browser signal, fire the event the app listens for and
 * let the module's own probe confirm it (a probe is what the app does too, and
 * "connected but unreachable" must not be treated as online).
 */
const goOnline = async () => {
  networkUp = true;
  navigator.onLine = true;
  window.dispatchEvent({ type: "online" });
  await probeConnection();
};

const {
  applyLocalGrades,
  bindConnectivityListeners,
  cacheDeckBundle,
  cacheProfile,
  cacheStatsSnapshot,
  countDueNow,
  flushOfflineQueue,
  isProbablyOnline,
  loadDeckDueCount,
  loadDeckForStudy,
  loadOfflineSessionList,
  loadReviewData,
  profileFromUser,
  probeConnection,
  purgeOfflineData,
  readCachedProfile,
  readDecks,
  readOfflineReadiness,
  readOutbox,
  readOutboxCount,
  readSrsRecords,
  readStatsSnapshot,
  saveProgressLocally,
  sendOrQueueWrite,
} = await import("../src/lib/offline.ts");

// src/app/page.tsx binds these on mount (via useOnlineStatus).
bindConnectivityListeners();

// ── Fixture ──────────────────────────────────────────────────────────────────
const pool = new pg.Pool({ connectionString: DATABASE_URL });
let deckId;
let foreignDeckId;
let cardIds = [];
let foreignCardId;

async function seed() {
  await pool.query(`DELETE FROM users WHERE id IN ($1, $2)`, [USER, OTHER]);
  await pool.query(
    `INSERT INTO users (id, email, name, provider) VALUES
       ($1, $2, 'Offline E2E', 'google'),
       ($3, $4, 'Offline Other', 'google')`,
    [USER, `${USER}@e2e.local`, OTHER, `${OTHER}@e2e.local`]
  );

  const mkDeck = async (userId, title) =>
    (
      await pool.query(
        `INSERT INTO study_sessions (title, source_type, summary, user_id)
         VALUES ($1, 'text', $2, $3) RETURNING id`,
        [title, `${title} summary`, userId]
      )
    ).rows[0].id;

  const mkCard = async (sessionId, index) =>
    (
      await pool.query(
        `INSERT INTO flashcards (session_id, question, answer, hint, difficulty, order_index)
         VALUES ($1, $2, $3, $4, 'medium', $5) RETURNING id`,
        [sessionId, `Question ${index}?`, `Answer ${index}`, `Hint ${index}`, index - 1]
      )
    ).rows[0].id;

  deckId = await mkDeck(USER, "Offline Deck");
  foreignDeckId = await mkDeck(OTHER, "Foreign Deck");
  cardIds = [await mkCard(deckId, 1), await mkCard(deckId, 2), await mkCard(deckId, 3)];
  foreignCardId = await mkCard(foreignDeckId, 1);

  // Schedules: card 1 is overdue (and in the learning steps, intervalDays 0),
  // card 2 is scheduled for tomorrow, card 3 has never been reviewed.
  await pool.query(
    `INSERT INTO card_reviews
       (card_id, session_id, user_id, ease, interval_days, reps, lapses, learning_step,
        review_count, last_grade, last_reviewed_at, due_at)
     VALUES ($1, $2, $3, 2.5, 0, 2, 0, 0, 2, 'good', now() - interval '3 days', now() - interval '2 days')`,
    [cardIds[0], deckId, USER]
  );
  await pool.query(
    `INSERT INTO card_reviews
       (card_id, session_id, user_id, ease, interval_days, reps, lapses, learning_step,
        review_count, last_grade, last_reviewed_at, due_at)
     VALUES ($1, $2, $3, 2.5, 6, 3, 0, 0, 3, 'good', now() - interval '1 day', now() + interval '5 days')`,
    [cardIds[1], deckId, USER]
  );
  // "Got it" from an earlier live study session.
  await pool.query(
    `INSERT INTO card_progress (card_id, session_id, is_known, attempts) VALUES ($1, $2, true, 2)`,
    [cardIds[1], deckId]
  );
}

let spawned = null;
async function waitForServer(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/api/health`);
      if (res.status > 0) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`server at ${BASE_URL} never came up`);
}

before(async () => {
  let up = false;
  try {
    await fetch(`${BASE_URL}/api/health`);
    up = true;
  } catch {
    up = false;
  }
  if (!up) {
    const cmd = process.env.NPM_CMD ?? "start";
    spawned = spawn("npm", ["run", cmd], {
      cwd: root,
      env: { ...process.env, HOSTNAME: "0.0.0.0", PORT: String(new URL(BASE_URL).port || 3000) },
      stdio: "inherit",
    });
    await waitForServer();
  }

  await seed();
  sessionToken = await sessionTokenFor(USER);
  // A real device gets here by signing in once; the cached profile is what
  // makes the account openable offline afterwards.
  await cacheProfile(
    profileFromUser({ id: USER, name: "Offline E2E", email: `${USER}@e2e.local`, image: null })
  );
});

after(async () => {
  await pool.query(`DELETE FROM users WHERE id IN ($1, $2)`, [USER, OTHER]).catch(() => {});
  await pool.end();
  if (spawned) spawned.kill("SIGTERM");
});

// ── Tests ────────────────────────────────────────────────────────────────────
describe("offline study against a live server", () => {
  test("the bundle endpoint freezes decks, cards, progress and schedules", async () => {
    const result = await cacheDeckBundle(deckId, { pinned: true });
    assert.equal(result.deckCount, 1);
    assert.equal(result.cardCount, 3);

    const decks = await readDecks();
    assert.equal(decks.length, 1);
    const [deck] = decks;
    assert.equal(deck.id, deckId);
    assert.equal(deck.title, "Offline Deck");
    assert.equal(deck.summary, "Offline Deck summary");
    assert.equal(deck.pinned, true);
    assert.deepEqual(
      deck.cards.map((card) => card.id),
      cardIds,
      "cards keep their author order"
    );
    assert.deepEqual(
      deck.progress.map((row) => [row.cardId, row.isKnown]),
      [[cardIds[1], true]]
    );

    const srs = await readSrsRecords();
    assert.equal(srs.length, 2, "both scheduled cards came down");
    assert.equal(srs.find((row) => row.cardId === cardIds[0]).state.intervalDays, 0);
    assert.equal(srs.find((row) => row.cardId === cardIds[1]).state.intervalDays, 6);
  });

  test("the bundle only contains the signed-in account's decks", async () => {
    // Same request, a different account's cookie: the foreign deck is invisible
    // (and asking for it by id is just as empty).
    const mine = sessionToken;
    sessionToken = await sessionTokenFor(OTHER);
    try {
      const foreign = await cacheDeckBundle(deckId, { pinned: false });
      assert.equal(foreign.deckCount, 0);
      assert.ok(
        !(await readDecks()).some((deck) => deck.id === foreignDeckId && deck.cards.length),
        "another user's deck was never cached"
      );
    } finally {
      sessionToken = mine;
    }
  });

  test("download-all freezes the whole library in one request", async () => {
    const before = requests.length;
    const result = await cacheDeckBundle(undefined, { pinned: true });
    assert.equal(result.deckCount, 1);
    assert.equal(result.cardCount, 3);
    assert.equal(requests.length - before, 1, "one round trip for the library");
    assert.equal((await readOfflineReadiness()).deckCount, 1);
  });

  test("offline: the deck list, the deck and the review queue come from the snapshot", async () => {
    goOffline();
    try {
      assert.equal(isProbablyOnline(), false);

      const rows = await loadOfflineSessionList();
      assert.equal(rows.length, 1);
      assert.deepEqual(
        {
          id: rows[0].id,
          cardCount: rows[0].cardCount,
          knownCount: rows[0].knownCount,
          dueCount: rows[0].dueCount,
          trackedCount: rows[0].trackedCount,
        },
        { id: deckId, cardCount: 3, knownCount: 1, dueCount: 1, trackedCount: 2 }
      );

      const deck = await loadDeckForStudy(deckId);
      assert.equal(deck.offline, true);
      assert.equal(deck.session.title, "Offline Deck");
      assert.deepEqual(
        deck.cards.map((card) => card.question),
        ["Question 1?", "Question 2?", "Question 3?"]
      );
      assert.deepEqual(
        deck.progress.map((row) => row.cardId),
        [cardIds[1]]
      );

      // The review queue: the overdue card first, then new material.
      const review = await loadReviewData(null, 20);
      assert.equal(review.offline, true);
      assert.equal(review.counts.due, 1);
      assert.equal(review.counts.tracked, 2);
      assert.equal(review.counts.newCards, 1);
      assert.equal(review.decks.length, 1);
      assert.equal(review.decks[0].title, "Offline Deck");
      assert.deepEqual(
        review.queue.map((card) => card.cardId),
        [cardIds[0], cardIds[2]],
        "overdue first, then the never-reviewed card"
      );
      assert.equal(review.queue[0].state.intervalDays, 0);
      assert.equal(review.queue[0].isNew, false);
      assert.equal(review.queue[1].isNew, true);
      assert.equal(review.queue[1].state, null);

      // A deck-scoped queue (what the quiz's review mode asks for) works too.
      const scoped = await loadReviewData(deckId, 20);
      assert.equal(scoped.sessionId, deckId);
      assert.equal(scoped.queue.length, 2);

      const [due] = await Promise.all([loadDeckDueCount(deckId)]);
      assert.equal(due.due, 1);
      assert.equal(due.offline, true);
    } finally {
      await goOnline();
    }
  });

  test("offline: grades, outcomes and progress are queued, not lost", async () => {
    goOffline();
    try {
      const before = requests.length;

      // 1. a spaced-repetition grade (the card that was due)
      assert.equal(
        await sendOrQueueWrite("/api/review", "POST", {
          reviews: [{ cardId: cardIds[0], sessionId: deckId, grade: "good" }],
        }),
        "queued"
      );
      // 2. a study-mode outcome
      assert.equal(
        await sendOrQueueWrite("/api/stats/results", "POST", {
          results: [
            {
              sessionId: deckId,
              cardId: cardIds[2],
              correct: true,
              mode: "study",
              answeredAt: new Date().toISOString(),
            },
          ],
        }),
        "queued"
      );
      // 3. the "got it" toggle
      assert.equal(
        await sendOrQueueWrite(`/api/sessions/${deckId}`, "PATCH", {
          cardId: cardIds[2],
          isKnown: true,
        }),
        "queued"
      );
      // Progress mirrors the local snapshot immediately (optimistic UI).
      await saveProgressLocally(deckId, cardIds[2], true);
      // The local schedule advances now, so the queue keeps moving offline.
      await applyLocalGrades([{ cardId: cardIds[0], sessionId: deckId, grade: "good" }]);
      await cacheStatsSnapshot({ totals: { answered: 1 } });

      // Nothing of that reached the database.
      const persisted = await pool.query(
        `SELECT count(*)::int AS n FROM card_reviews WHERE user_id = $1 AND card_id = $2 AND review_count > 2`,
        [USER, cardIds[0]]
      );
      assert.equal(persisted.rows[0].n, 0);
      const results = await pool.query(
        `SELECT count(*)::int AS n FROM study_results WHERE user_id = $1`,
        [USER]
      );
      assert.equal(results.rows[0].n, 0);

      assert.equal(await readOutboxCount(), 3);
      const kinds = (await readOutbox()).map((item) => item.kind);
      assert.deepEqual(kinds, ["review", "stats", "progress"], "queued in answered order");

      const srs = await readSrsRecords();
      assert.equal(
        srs.find((row) => row.cardId === cardIds[0]).state.reviewCount,
        3,
        "the local schedule recorded the offline grade"
      );
      assert.equal(countDueNow(srs), 0, "nothing left due offline");
      assert.equal((await readOfflineReadiness()).cardCount, 3);

      const stats = await readStatsSnapshot();
      assert.deepEqual(stats.data, { totals: { answered: 1 } });

      assert.equal(requests.length - before, 0, "offline writes never hit the network");
    } finally {
      await goOnline();
    }
  });

  test("reconnecting drains the outbox into the real database", async () => {
    // The test above already came back online; confirm the module agrees.
    assert.equal(isProbablyOnline(), true);
    const result = await flushOfflineQueue();

    assert.equal(result.networkFailed, false);
    assert.equal(result.authFailed, false);
    assert.equal(result.remaining, 0);
    assert.ok(result.syncedEntries >= 3, `drained ${result.syncedEntries} entries`);
    assert.equal(await readOutboxCount(), 0);

    // The grade: review_count 2 → 3, and the schedule moved into the future.
    const review = await pool.query(
      `SELECT review_count, interval_days, due_at, last_grade FROM card_reviews
        WHERE user_id = $1 AND card_id = $2`,
      [USER, cardIds[0]]
    );
    assert.equal(review.rowCount, 1);
    assert.equal(review.rows[0].review_count, 3);
    assert.equal(review.rows[0].last_grade, "good");
    assert.ok(
      new Date(review.rows[0].due_at).getTime() > Date.now(),
      "graded card is no longer due"
    );

    // The outcome, recorded under the mode it was answered in — plus the
    // "review" result the grade endpoint writes for the card it rescheduled.
    const results = await pool.query(
      `SELECT card_id, correct, mode FROM study_results WHERE user_id = $1 ORDER BY id`,
      [USER]
    );
    assert.deepEqual(
      results.rows.map((row) => [row.card_id, row.correct, row.mode]),
      [
        [cardIds[0], true, "review"],
        [cardIds[2], true, "study"],
      ]
    );

    // The progress toggle.
    const progress = await pool.query(
      `SELECT is_known, attempts FROM card_progress WHERE session_id = $1 AND card_id = $2`,
      [deckId, cardIds[2]]
    );
    assert.equal(progress.rowCount, 1);
    assert.equal(progress.rows[0].is_known, true);

    // And the app sees the synced world again once it refetches.
    const fresh = await loadReviewData(null, 20);
    assert.equal(fresh.offline, false);
    assert.equal(fresh.counts.due, 0, "the server agrees nothing is due");
  });

  test("an empty queue drains without touching the network", async () => {
    const before = requests.length;
    const result = await flushOfflineQueue();
    assert.equal(result.syncedEntries, 0);
    assert.equal(result.remaining, 0);
    assert.equal(requests.length, before);
  });

  test("a dead session keeps the queue instead of dropping it", async () => {
    goOffline();
    await sendOrQueueWrite("/api/review", "POST", {
      reviews: [{ cardId: cardIds[1], sessionId: deckId, grade: "easy" }],
    });
    await goOnline();

    const valid = sessionToken;
    sessionToken = "not-a-real-jwt";
    try {
      const result = await flushOfflineQueue();
      assert.equal(result.authFailed, true);
      assert.equal(result.syncedEntries, 0);
      assert.equal(await readOutboxCount(), 1, "the answer is still safe");
    } finally {
      sessionToken = valid;
    }

    // ...and it goes through once the session works again.
    const retry = await flushOfflineQueue();
    assert.equal(retry.authFailed, false);
    assert.equal(retry.remaining, 0);
    const review = await pool.query(
      `SELECT last_grade FROM card_reviews WHERE user_id = $1 AND card_id = $2`,
      [USER, cardIds[1]]
    );
    assert.equal(review.rows[0].last_grade, "easy");
  });

  test("signing out purges the device copy", async () => {
    assert.ok((await readDecks()).length > 0);
    await purgeOfflineData();
    assert.deepEqual(await readDecks(), []);
    assert.deepEqual(await readSrsRecords(), []);
    assert.equal(await readOutboxCount(), 0);
    assert.equal(await readCachedProfile(), null);
    assert.equal(await readStatsSnapshot(), null);
    assert.equal((await readOfflineReadiness()).deckCount, 0);
  });
});
