#!/usr/bin/env node
/**
 * E2E: deck & card editing API (rename, manual decks, card CRUD + reorder).
 *
 * Same offline pattern as scripts/auth-e2e.mjs: the dev sandbox cannot
 * complete a real Google login, so Auth.js session JWTs are minted directly
 * with next-auth/jwt's encode() (salt "authjs.session-token") and the API is
 * exercised over HTTP, exactly like a browser with a session cookie would.
 *
 * What it proves:
 *   - anonymous edits are rejected (401) and foreign decks 404,
 *   - PATCH /api/sessions/[id] renames a deck (title/summary), keeps the
 *     legacy {cardId, isKnown} progress path working, and validates input,
 *   - PUT /api/sessions/[id]/cards bulk-saves the card list: edited cards
 *     keep their id (study progress + SRS schedules survive), new cards are
 *     inserted, omitted cards are deleted (with cascade), and the array
 *     order becomes the new order_index,
 *   - PUT validates: empty list, blank question/answer, duplicate ids and
 *     ids from another deck are all rejected,
 *   - POST /api/sessions creates a manual deck (sourceType "manual").
 *
 * Usage (server on $BASE_URL or spawned automatically):
 *   npm run test:deck-editor                       # spawns `npm run start` (needs a build)
 *   NPM_CMD=dev npm run test:deck-editor           # spawns `npm run dev` instead
 *   BASE_URL=http://127.0.0.1:3000 npm run test:deck-editor
 *
 * Requires DATABASE_URL + AUTH_SECRET in the environment (or .env.local,
 * which Next loads for the spawned server).
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
const USER_A = "deckedit-user-a-111111";
const USER_B = "deckedit-user-b-222222";

/** Mint a session JWT for a user id, the way Auth.js would after Google sign-in. */
const sessionCookieFor = (userId) =>
  encode({
    token: {
      userId,
      sub: userId,
      email: `${userId}@e2e.local`,
      name: `DeckEdit ${userId.slice(-1)}`,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 60 * 60,
      jti: `deckedit-${userId}-${Date.now()}`,
    },
    secret: AUTH_SECRET,
    salt: "authjs.session-token",
  });

// ── HTTP helper ──────────────────────────────────────────────────────────────
async function api(path, { method = "GET", body, cookie } = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: `${COOKIE}=${cookie}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, data };
}

// ── Database fixture ─────────────────────────────────────────────────────────
const pool = new pg.Pool({ connectionString: DATABASE_URL });

async function seed() {
  // Clean slate (cascades wipe decks, cards, progress, reviews, results).
  await pool.query(`DELETE FROM users WHERE id IN ($1, $2)`, [USER_A, USER_B]);
  await pool.query(
    `INSERT INTO users (id, email, name, provider) VALUES
       ($1, $2, 'DeckEdit A', 'google'),
       ($3, $4, 'DeckEdit B', 'google')`,
    [USER_A, "deckedit-a@e2e.local", USER_B, "deckedit-b@e2e.local"]
  );

  const mkSession = async (userId, title) => {
    const { rows } = await pool.query(
      `INSERT INTO study_sessions (title, source_type, user_id) VALUES ($1, 'text', $2) RETURNING id`,
      [title, userId]
    );
    return rows[0].id;
  };
  const mkCards = async (sessionId, n) => {
    const ids = [];
    for (let i = 1; i <= n; i++) {
      const { rows } = await pool.query(
        `INSERT INTO flashcards (session_id, question, answer, difficulty, order_index)
         VALUES ($1, $2, $3, 'medium', $4) RETURNING id`,
        [sessionId, `Question ${i} of deck ${sessionId}?`, `Answer ${i}`, i - 1]
      );
      ids.push(rows[0].id);
    }
    return ids;
  };

  return {
    deckA: await mkSession(USER_A, "DeckEdit Deck A"),
    deckB: await mkSession(USER_B, "DeckEdit Deck B"),
    mkCards,
  };
}

let tokenA;
let tokenB;
let deckA;
let deckB;
let cardsA;

let spawned = null;
async function waitForServer(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/api/health`);
      if (res.ok || res.status === 401) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`server at ${BASE_URL} never came up`);
}

before(async () => {
  // Reuse a running server if there is one, otherwise spawn our own.
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

  const fixture = await seed();
  deckA = fixture.deckA;
  deckB = fixture.deckB;
  cardsA = await fixture.mkCards(deckA, 3);
  await fixture.mkCards(deckB, 1);

  tokenA = await sessionCookieFor(USER_A);
  tokenB = await sessionCookieFor(USER_B);
});

after(async () => {
  await pool.query(`DELETE FROM users WHERE id IN ($1, $2)`, [USER_A, USER_B]);
  await pool.end();
  if (spawned) spawned.kill("SIGTERM");
});

// ── Tests ────────────────────────────────────────────────────────────────────
describe("deck editing API", () => {
  test("anonymous edits are rejected", async () => {
    const patch = await api(`/api/sessions/${deckA}`, {
      method: "PATCH",
      body: { title: "Hacked" },
    });
    assert.equal(patch.status, 401);

    const put = await api(`/api/sessions/${deckA}/cards`, {
      method: "PUT",
      body: { cards: [{ question: "q", answer: "a" }] },
    });
    assert.equal(put.status, 401);
  });

  test("a foreign deck cannot be renamed or rewritten (404)", async () => {
    const patch = await api(`/api/sessions/${deckA}`, {
      method: "PATCH",
      body: { title: "Not yours" },
      cookie: tokenB,
    });
    assert.equal(patch.status, 404);

    const put = await api(`/api/sessions/${deckA}/cards`, {
      method: "PUT",
      body: { cards: [{ id: cardsA[0], question: "q", answer: "a" }] },
      cookie: tokenB,
    });
    assert.equal(put.status, 404);
  });

  test("PATCH renames a deck and edits its summary", async () => {
    const res = await api(`/api/sessions/${deckA}`, {
      method: "PATCH",
      body: { title: "  Renamed Deck ✨  ", summary: "Hand-edited summary" },
      cookie: tokenA,
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.success, true);
    assert.equal(res.data.session.title, "Renamed Deck ✨");
    assert.equal(res.data.session.summary, "Hand-edited summary");

    const loaded = await api(`/api/sessions/${deckA}`, { cookie: tokenA });
    assert.equal(loaded.data.session.title, "Renamed Deck ✨");
  });

  test("PATCH rejects an empty title and caps long ones", async () => {
    const blank = await api(`/api/sessions/${deckA}`, {
      method: "PATCH",
      body: { title: "   " },
      cookie: tokenA,
    });
    assert.equal(blank.status, 400);

    const long = await api(`/api/sessions/${deckA}`, {
      method: "PATCH",
      body: { title: "x".repeat(300) },
      cookie: tokenA,
    });
    assert.equal(long.status, 200);
    assert.equal(long.data.session.title.length, 120);
  });

  test("legacy PATCH progress path still works", async () => {
    const res = await api(`/api/sessions/${deckA}`, {
      method: "PATCH",
      body: { cardId: cardsA[0], isKnown: true },
      cookie: tokenA,
    });
    assert.equal(res.status, 200);
    const { rows } = await pool.query(
      `SELECT is_known FROM card_progress WHERE card_id = $1 AND session_id = $2`,
      [cardsA[0], deckA]
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].is_known, true);
  });

  test("PUT bulk-saves cards: edit keeps id (progress + SRS survive), add, delete cascades, reorder", async () => {
    // Give card 2 an SRS schedule and a study result — both must survive an edit.
    await pool.query(
      `INSERT INTO card_reviews (user_id, session_id, card_id, ease, reps, review_count)
       VALUES ($1, $2, $3, 2.4, 3, 5)`,
      [USER_A, deckA, cardsA[1]]
    );
    await pool.query(
      `INSERT INTO study_results (user_id, session_id, card_id, correct, mode)
       VALUES ($1, $2, $3, true, 'study')`,
      [USER_A, deckA, cardsA[1]]
    );
    // Card 3 will be deleted — its progress row must cascade away.
    await pool.query(
      `INSERT INTO card_progress (card_id, session_id, is_known) VALUES ($1, $2, false)`,
      [cardsA[2], deckA]
    );

    // New order: [edited card2, brand-new card, card1]; card3 is dropped.
    const res = await api(`/api/sessions/${deckA}/cards`, {
      method: "PUT",
      body: {
        cards: [
          { id: cardsA[1], question: "Edited question?", answer: "Edited answer", hint: "  ", difficulty: "hard" },
          { question: "Fresh card?", answer: "Fresh answer", difficulty: "easy" },
          { id: cardsA[0], question: "Question 1 of deck " + deckA + "?", answer: "Answer 1" },
        ],
      },
      cookie: tokenA,
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.cards.length, 3);

    const saved = res.data.cards; // ordered by order_index
    // 1) Reorder + edit: card2 is now first, updated, blank hint → null.
    assert.equal(saved[0].id, cardsA[1]);
    assert.equal(saved[0].question, "Edited question?");
    assert.equal(saved[0].answer, "Edited answer");
    assert.equal(saved[0].hint, null);
    assert.equal(saved[0].difficulty, "hard");
    assert.equal(saved[0].orderIndex, 0);
    // 2) New card inserted second.
    assert.ok(!cardsA.includes(saved[1].id));
    assert.equal(saved[1].question, "Fresh card?");
    assert.equal(saved[1].difficulty, "easy");
    assert.equal(saved[1].orderIndex, 1);
    // 3) card1 kept its id, now last.
    assert.equal(saved[2].id, cardsA[0]);
    assert.equal(saved[2].orderIndex, 2);

    // card3 was deleted.
    const gone = await pool.query(`SELECT 1 FROM flashcards WHERE id = $1`, [cardsA[2]]);
    assert.equal(gone.rowCount, 0);
    // Its progress cascaded away.
    const orphanProgress = await pool.query(
      `SELECT 1 FROM card_progress WHERE card_id = $1`,
      [cardsA[2]]
    );
    assert.equal(orphanProgress.rowCount, 0);

    // Edited card kept its history: SRS schedule and study result still there.
    const review = await pool.query(
      `SELECT ease, reps FROM card_reviews WHERE card_id = $1`,
      [cardsA[1]]
    );
    assert.equal(review.rowCount, 1);
    assert.ok(Math.abs(review.rows[0].ease - 2.4) < 1e-6);
    const result = await pool.query(
      `SELECT 1 FROM study_results WHERE card_id = $1`,
      [cardsA[1]]
    );
    assert.equal(result.rowCount, 1);

    // GET returns the same order.
    const loaded = await api(`/api/sessions/${deckA}`, { cookie: tokenA });
    assert.deepEqual(
      loaded.data.cards.map((c) => c.id),
      saved.map((c) => c.id)
    );
  });

  test("PUT validates the payload", async () => {
    const empty = await api(`/api/sessions/${deckA}/cards`, {
      method: "PUT",
      body: { cards: [] },
      cookie: tokenA,
    });
    assert.equal(empty.status, 400);

    const blankQuestion = await api(`/api/sessions/${deckA}/cards`, {
      method: "PUT",
      body: { cards: [{ question: "  ", answer: "a" }] },
      cookie: tokenA,
    });
    assert.equal(blankQuestion.status, 400);

    const duplicate = await api(`/api/sessions/${deckA}/cards`, {
      method: "PUT",
      body: {
        cards: [
          { id: cardsA[0], question: "q1", answer: "a1" },
          { id: cardsA[0], question: "q2", answer: "a2" },
        ],
      },
      cookie: tokenA,
    });
    assert.equal(duplicate.status, 400);

    // An id from a different deck must be refused, not adopted.
    const foreign = await api(`/api/sessions/${deckA}/cards`, {
      method: "PUT",
      body: { cards: [{ id: 999999, question: "q", answer: "a" }] },
      cookie: tokenA,
    });
    assert.equal(foreign.status, 404);

    // A failed PUT changes nothing.
    const loaded = await api(`/api/sessions/${deckA}`, { cookie: tokenA });
    assert.equal(loaded.data.cards.length, 3);
    assert.equal(loaded.data.cards[0].question, "Edited question?");
  });

  test("PUT rejects more than 200 cards", async () => {
    const cards = Array.from({ length: 201 }, (_, i) => ({
      question: `q${i}`,
      answer: `a${i}`,
    }));
    const res = await api(`/api/sessions/${deckA}/cards`, {
      method: "PUT",
      body: { cards },
      cookie: tokenA,
    });
    assert.equal(res.status, 400);
  });

  test("manual decks: POST creates one with sourceType 'manual'", async () => {
    const res = await api("/api/sessions", {
      method: "POST",
      body: {
        title: "My Hand-Built Deck",
        sourceType: "manual",
        summary: "No AI involved",
        cards: [
          { question: "Capital of France?", answer: "Paris", difficulty: "easy" },
          { question: "2 + 2?", answer: "4", hint: "count fingers", difficulty: "easy" },
        ],
      },
      cookie: tokenA,
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.success, true);
    assert.equal(res.data.session.sourceType, "manual");
    assert.equal(res.data.session.cardCount, 2);
    assert.equal(res.data.cards.length, 2);
    assert.equal(res.data.cards[1].hint, "count fingers");

    // It shows up in the deck list with the right counts.
    const list = await api("/api/sessions", { cookie: tokenA });
    const listed = list.data.sessions.find((s) => s.id === res.data.session.id);
    assert.ok(listed, "manual deck appears in GET /api/sessions");
    assert.equal(listed.title, "My Hand-Built Deck");
    assert.equal(listed.cardCount, 2);

    // And it can be renamed + edited like any other deck.
    const rename = await api(`/api/sessions/${res.data.session.id}`, {
      method: "PATCH",
      body: { title: "My Hand-Built Deck v2" },
      cookie: tokenA,
    });
    assert.equal(rename.status, 200);
    assert.equal(rename.data.session.title, "My Hand-Built Deck v2");

    const rewrite = await api(`/api/sessions/${res.data.session.id}/cards`, {
      method: "PUT",
      body: {
        cards: [
          { id: res.data.cards[1].id, question: "3 + 3?", answer: "6" },
          { question: "Capital of Japan?", answer: "Tokyo" },
        ],
      },
      cookie: tokenA,
    });
    assert.equal(rewrite.status, 200);
    assert.equal(rewrite.data.cards[0].question, "3 + 3?");
    assert.equal(rewrite.data.cards.length, 2);
  });
});
