#!/usr/bin/env node
/**
 * E2E: per-user scoping of the stats/results API (P2 — Study Stats).
 *
 * The dev sandbox is offline, so a real Google login can't complete here.
 * Instead we mint Auth.js session JWTs directly with next-auth/jwt's
 * encode() (salt "authjs.session-token" — the cookie salt Auth.js v5 uses
 * for JWT sessions over http) and talk to the API over HTTP, exactly like
 * a browser with a session cookie would.
 *
 * What it proves:
 *   - anonymous requests are rejected (401),
 *   - user A cannot READ user B's decks, stats or recent activity,
 *   - user A cannot WRITE study results into user B's deck/cards,
 *   - valid results are recorded and stats (overall/per-deck/streak) are
 *     computed correctly, including for decks that predate the feature
 *     (zeros, no crash),
 *   - deleting a deck cascades to its study results,
 *   - signing in with an existing email under a *new* Google `sub`
 *     self-heals: the jwt callback re-keys users.id and the user's decks
 *     and study results follow via the ON UPDATE cascade FKs. That case
 *     drives the real jwt callback from src/auth.ts in-process (a real
 *     Google OAuth round-trip can't happen offline).
 *
 * Usage (server on $BASE_URL or spawned automatically). The suite runs
 * under tsx because the re-key case imports src/auth.ts directly:
 *   npm run test:e2e                 # spawns `npm run start` (needs a build)
 *   NPM_CMD=dev npm run test:e2e     # spawns `npm run dev` instead
 *   BASE_URL=http://127.0.0.1:3000 npm run test:e2e   # use a running server
 *
 * Requires DATABASE_URL + AUTH_SECRET in the environment (or .env.local,
 * which Next loads for the spawned server).
 */
import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
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
const USER_A = "e2e-user-a-111111";
const USER_B = "e2e-user-b-222222";
// Account re-keying fixture: same email, old vs new Google `sub`.
const REKEY_OLD = "e2e-rekey-old-000001";
const REKEY_NEW = "e2e-rekey-new-900001";
const REKEY_EMAIL = "e2e-rekey@e2e.local";

/** Mint a session JWT for a user id, the way Auth.js would after Google sign-in. */
const sessionCookieFor = (userId) =>
  encode({
    token: {
      userId,
      sub: userId,
      email: `${userId}@e2e.local`,
      name: `E2E ${userId.slice(-1)}`,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 60 * 60,
      jti: `e2e-${userId}-${Date.now()}`,
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
  // Clean slate for the two e2e users (cascades wipe their decks/results).
  await pool.query(`DELETE FROM users WHERE id IN ($1, $2)`, [USER_A, USER_B]);
  await pool.query(
    `INSERT INTO users (id, email, name, provider) VALUES
       ($1, $2, 'E2E User A', 'google'),
       ($3, $4, 'E2E User B', 'google')`,
    [USER_A, "e2e-user-a@e2e.local", USER_B, "e2e-user-b@e2e.local"]
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
        [sessionId, `A: Question ${i} of deck ${sessionId}?`, `Answer ${i}`, i - 1]
      );
      ids.push(rows[0].id);
    }
    return ids;
  };

  return {
    a1: await mkSession(USER_A, "E2E Deck A1"),
    a2: await mkSession(USER_A, "E2E Deck A2 (untouched — predates stats)"),
    b1: await mkSession(USER_B, "E2E Deck B1"),
    mkCards,
  };
}

let tokenA;
let tokenB;
let deckA1;
let deckA2;
let deckB1;
let cardsA1;
let cardsB1;

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
  deckA1 = fixture.a1;
  deckA2 = fixture.a2;
  deckB1 = fixture.b1;
  cardsA1 = await fixture.mkCards(deckA1, 3);
  // A2 gets cards but is never answered — it stands in for the decks that
  // already existed before this feature (must render as zeros, not break).
  await fixture.mkCards(deckA2, 3);
  cardsB1 = await fixture.mkCards(deckB1, 2);

  tokenA = await sessionCookieFor(USER_A);
  tokenB = await sessionCookieFor(USER_B);
});

after(async () => {
  await pool.query(`DELETE FROM users WHERE id = ANY($1)`, [
    [USER_A, USER_B, REKEY_OLD, REKEY_NEW],
  ]);
  await pool.end();
  if (spawned) spawned.kill("SIGTERM");
});

// ── Tests ────────────────────────────────────────────────────────────────────
describe("anonymous access", () => {
  test("GET /api/stats requires a session", async () => {
    const r = await api("/api/stats");
    assert.equal(r.status, 401);
  });

  test("POST /api/stats/results requires a session", async () => {
    const r = await api("/api/stats/results", {
      method: "POST",
      body: { results: [{ sessionId: deckA1, cardId: cardsA1[0], correct: true }] },
    });
    assert.equal(r.status, 401);
  });
});

describe("cross-user scoping (user A vs user B)", () => {
  test("A cannot see B's deck in GET /api/sessions", async () => {
    const r = await api("/api/sessions", { cookie: tokenA });
    assert.equal(r.status, 200);
    const ids = r.data.sessions.map((s) => s.id);
    assert.ok(ids.includes(deckA1) && ids.includes(deckA2));
    assert.ok(!ids.includes(deckB1), "B's deck leaked into A's session list");
  });

  test("A cannot load B's deck directly", async () => {
    const r = await api(`/api/sessions/${deckB1}`, { cookie: tokenA });
    assert.equal(r.status, 404);
  });

  test("A cannot record results into B's deck", async () => {
    const r = await api("/api/stats/results", {
      method: "POST",
      cookie: tokenA,
      body: { results: [{ sessionId: deckB1, cardId: cardsB1[0], correct: true }] },
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.recorded, 0);
    assert.equal(r.data.invalid.length, 1);
    assert.match(r.data.invalid[0].reason, /Session not found/);

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM study_results WHERE session_id = $1`,
      [deckB1]
    );
    assert.equal(rows[0].n, 0, "A managed to write into B's deck");
  });

  test("A cannot record B's card under A's own deck id", async () => {
    const r = await api("/api/stats/results", {
      method: "POST",
      cookie: tokenA,
      body: { results: [{ sessionId: deckA1, cardId: cardsB1[0], correct: true }] },
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.recorded, 0);
    assert.match(r.data.invalid[0].reason, /Card not found in this session/);
  });

  test("mixed batch: A's valid row is recorded, B's rows are rejected", async () => {
    const r = await api("/api/stats/results", {
      method: "POST",
      cookie: tokenA,
      body: {
        results: [
          { sessionId: deckA1, cardId: cardsA1[0], correct: true, mode: "study" },
          { sessionId: deckB1, cardId: cardsB1[0], correct: true, mode: "exam" },
          { sessionId: deckB1, cardId: cardsB1[1], correct: false, mode: "exam" },
        ],
      },
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.recorded, 1);
    assert.equal(r.data.invalid.length, 2);

    const { rows } = await pool.query(
      `SELECT user_id, card_id, correct, mode FROM study_results WHERE session_id = $1`,
      [deckA1]
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].user_id, USER_A);
    assert.equal(rows[0].card_id, cardsA1[0]);
    assert.equal(rows[0].correct, true);
    assert.equal(rows[0].mode, "study");
  });
});

describe("recording & validation", () => {
  test("empty results array is rejected", async () => {
    const r = await api("/api/stats/results", { method: "POST", cookie: tokenA, body: { results: [] } });
    assert.equal(r.status, 400);
  });

  test("bad shapes are rejected per-entry", async () => {
    const r = await api("/api/stats/results", {
      method: "POST",
      cookie: tokenA,
      body: {
        results: [
          { sessionId: "x", cardId: 1, correct: true },
          { sessionId: deckA1, cardId: cardsA1[1], correct: "yes" },
          { sessionId: deckA1, cardId: cardsA1[1], correct: false, mode: "cheating" },
        ],
      },
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.recorded, 1, "the well-formed entry should still be recorded");
    assert.equal(r.data.invalid.length, 2);
    // Unknown mode falls back to 'study' rather than being rejected.
    const { rows } = await pool.query(
      `SELECT mode FROM study_results WHERE card_id = $1`,
      [cardsA1[1]]
    );
    assert.equal(rows[0].mode, "study");
  });

  test("batches over 100 are rejected", async () => {
    const results = Array.from({ length: 101 }, () => ({
      sessionId: deckA1,
      cardId: cardsA1[0],
      correct: true,
    }));
    const r = await api("/api/stats/results", { method: "POST", cookie: tokenA, body: { results } });
    assert.equal(r.status, 400);
  });
});

describe("stats correctness", () => {
  test("A's stats reflect A's answers only", async () => {
    // Add two more answers for A (one wrong) in exam mode.
    await api("/api/stats/results", {
      method: "POST",
      cookie: tokenA,
      body: {
        results: [
          { sessionId: deckA1, cardId: cardsA1[2], correct: false, mode: "exam" },
          { sessionId: deckA1, cardId: cardsA1[2], correct: true, mode: "exam" },
        ],
      },
    });

    const r = await api("/api/stats", { cookie: tokenA });
    assert.equal(r.status, 200);
    const { overall, decks, recent } = r.data;

    // A now has 4 answers: cardsA1[0] ✅, cardsA1[1] ❌, cardsA1[2] ❌ + ✅
    assert.equal(overall.totalAnswers, 4);
    assert.equal(overall.correctAnswers, 2);
    assert.equal(overall.incorrectAnswers, 2);
    assert.equal(overall.cardsStudied, 3);
    assert.equal(overall.studySessions, 1);
    assert.equal(overall.accuracy, 50);
    assert.equal(overall.streak, 1, "answers today ⇒ streak of 1");
    assert.ok(overall.lastStudiedAt);

    // Per deck: A1 has data, A2 (predates the feature) shows zeros.
    const a1 = decks.find((d) => d.sessionId === deckA1);
    const a2 = decks.find((d) => d.sessionId === deckA2);
    assert.ok(a1 && a2, "both of A's decks must be listed");
    assert.equal(a1.cardCount, 3);
    assert.equal(a1.studiedCount, 3);
    assert.equal(a1.answerCount, 4);
    assert.equal(a1.correctCount, 2);
    assert.equal(a1.mastery, 100);
    assert.equal(a1.accuracy, 50);
    assert.ok(a1.lastStudiedAt);
    assert.equal(a2.cardCount, 3);
    assert.equal(a2.studiedCount, 0);
    assert.equal(a2.answerCount, 0);
    assert.equal(a2.mastery, 0);
    assert.equal(a2.accuracy, null);
    assert.equal(a2.lastStudiedAt, null);

    // Recent activity: newest first, A's data only.
    assert.ok(recent.length >= 4);
    assert.ok(
      recent.every((x) => x.deckTitle.startsWith("E2E Deck A")),
      "recent activity leaked another user's deck"
    );
    const times = recent.map((x) => new Date(x.answeredAt).getTime());
    assert.deepEqual(times, [...times].sort((a, b) => b - a), "recent must be newest first");
  });

  test("B sees zeros for A's activity and none of A's decks", async () => {
    const r = await api("/api/stats", { cookie: tokenB });
    assert.equal(r.status, 200);
    const { overall, decks, recent } = r.data;
    assert.equal(overall.totalAnswers, 0);
    assert.equal(overall.cardsStudied, 0);
    assert.equal(overall.streak, 0);
    assert.equal(overall.accuracy, null);
    assert.deepEqual(
      decks.map((d) => d.sessionId),
      [deckB1],
      "B must see exactly B's deck"
    );
    assert.equal(decks[0].studiedCount, 0);
    assert.deepEqual(recent, []);
  });

  test("deleting a deck cascades to its study results", async () => {
    const del = await api(`/api/sessions/${deckA2}`, { method: "DELETE", cookie: tokenA });
    assert.equal(del.status, 200);
    const r = await api("/api/stats", { cookie: tokenA });
    assert.ok(!r.data.decks.some((d) => d.sessionId === deckA2));
  });
});

describe("daily streak", () => {
  const insertDay = (userId, sessionId, cardId, iso) =>
    pool.query(
      `INSERT INTO study_results (user_id, session_id, card_id, correct, mode, answered_at)
       VALUES ($1, $2, $3, true, 'study', $4::timestamp)`,
      [userId, sessionId, cardId, iso]
    );

  const utcDay = (offsetDays) => {
    const d = new Date(Date.now() + offsetDays * 86_400_000);
    return d.toISOString().slice(0, 10);
  };

  test("3 consecutive days ending today ⇒ streak 3", async () => {
    await pool.query(`DELETE FROM study_results WHERE user_id = $1`, [USER_A]);
    await insertDay(USER_A, deckA1, cardsA1[0], `${utcDay(-2)} 10:00:00`);
    await insertDay(USER_A, deckA1, cardsA1[1], `${utcDay(-1)} 10:00:00`);
    await insertDay(USER_A, deckA1, cardsA1[2], `${utcDay(0)} 10:00:00`);

    const r = await api("/api/stats", { cookie: tokenA });
    assert.equal(r.data.overall.streak, 3);
  });

  test("studied yesterday but not today ⇒ streak survives", async () => {
    await pool.query(`DELETE FROM study_results WHERE user_id = $1`, [USER_A]);
    await insertDay(USER_A, deckA1, cardsA1[0], `${utcDay(-2)} 10:00:00`);
    await insertDay(USER_A, deckA1, cardsA1[1], `${utcDay(-1)} 10:00:00`);

    const r = await api("/api/stats", { cookie: tokenA });
    assert.equal(r.data.overall.streak, 2);
  });

  test("a missed day resets the streak", async () => {
    await pool.query(`DELETE FROM study_results WHERE user_id = $1`, [USER_A]);
    await insertDay(USER_A, deckA1, cardsA1[0], `${utcDay(-3)} 10:00:00`);
    // gap at -2
    await insertDay(USER_A, deckA1, cardsA1[1], `${utcDay(-1)} 10:00:00`);
    await insertDay(USER_A, deckA1, cardsA1[2], `${utcDay(0)} 10:00:00`);

    const r = await api("/api/stats", { cookie: tokenA });
    assert.equal(r.data.overall.streak, 2, "only yesterday+today are consecutive");
  });

  test("last study 3 days ago ⇒ streak 0", async () => {
    await pool.query(`DELETE FROM study_results WHERE user_id = $1`, [USER_A]);
    await insertDay(USER_A, deckA1, cardsA1[0], `${utcDay(-3)} 10:00:00`);

    const r = await api("/api/stats", { cookie: tokenA });
    assert.equal(r.data.overall.streak, 0);
  });

  test("multiple answers on the same day count once", async () => {
    await pool.query(`DELETE FROM study_results WHERE user_id = $1`, [USER_A]);
    await insertDay(USER_A, deckA1, cardsA1[0], `${utcDay(0)} 08:00:00`);
    await insertDay(USER_A, deckA1, cardsA1[1], `${utcDay(0)} 12:00:00`);
    await insertDay(USER_A, deckA1, cardsA1[2], `${utcDay(0)} 20:00:00`);

    const r = await api("/api/stats", { cookie: tokenA });
    assert.equal(r.data.overall.streak, 1);
  });
});

describe("account re-keying (same email, new Google sub)", () => {
  let rekeyDeck;
  let rekeyCard;

  before(async () => {
    // Pre-seed a user under the OLD Google id, with a deck, a card and a
    // recorded answer — everything must survive the re-key.
    await pool.query(`DELETE FROM users WHERE id = ANY($1) OR email = $2`, [
      [REKEY_OLD, REKEY_NEW],
      REKEY_EMAIL,
    ]);
    await pool.query(
      `INSERT INTO users (id, email, name, provider) VALUES ($1, $2, 'E2E Rekey', 'google')`,
      [REKEY_OLD, REKEY_EMAIL]
    );
    const deck = await pool.query(
      `INSERT INTO study_sessions (title, source_type, user_id)
       VALUES ('E2E Rekey Deck', 'text', $1) RETURNING id`,
      [REKEY_OLD]
    );
    rekeyDeck = deck.rows[0].id;
    const card = await pool.query(
      `INSERT INTO flashcards (session_id, question, answer, difficulty, order_index)
       VALUES ($1, 'Rekey question?', 'Rekey answer', 'medium', 0) RETURNING id`,
      [rekeyDeck]
    );
    rekeyCard = card.rows[0].id;
    await pool.query(
      `INSERT INTO study_results (user_id, session_id, card_id, correct, mode)
       VALUES ($1, $2, $3, true, 'study')`,
      [REKEY_OLD, rekeyDeck, rekeyCard]
    );
  });

  test("sign-in with the same email under a new sub self-heals instead of crashing", async () => {
    // Drive the real jwt callback from src/auth.ts the way Auth.js does
    // right after a Google sign-in: same email, but a different `sub`.
    // Before the fix this threw Postgres 23505 (users_email_unique) and
    // the user landed on the Configuration error page.
    const { authConfig } = await import("../src/auth.ts");
    const token = {};
    await authConfig.callbacks.jwt({
      token,
      user: {
        id: REKEY_NEW,
        email: REKEY_EMAIL,
        name: "E2E Rekey",
        image: null,
      },
    });

    // Login succeeded and the token is pinned to the NEW id.
    assert.equal(token.userId, REKEY_NEW, "login must self-heal and pin the new id");

    // Exactly one user row for the email, now under the new id.
    const u = await pool.query(`SELECT id, email FROM users WHERE email = $1`, [REKEY_EMAIL]);
    assert.equal(u.rows.length, 1);
    assert.equal(u.rows[0].id, REKEY_NEW);
    const gone = await pool.query(`SELECT count(*)::int AS n FROM users WHERE id = $1`, [REKEY_OLD]);
    assert.equal(gone.rows[0].n, 0, "old user row must be gone after re-key");

    // The deck (and its cards/results) followed the id via ON UPDATE cascade.
    const s = await pool.query(`SELECT user_id, title FROM study_sessions WHERE id = $1`, [rekeyDeck]);
    assert.equal(s.rows.length, 1, "deck must still exist");
    assert.equal(s.rows[0].user_id, REKEY_NEW, "deck must follow the new user id");
    const res = await pool.query(
      `SELECT user_id FROM study_results WHERE session_id = $1 AND card_id = $2`,
      [rekeyDeck, rekeyCard]
    );
    assert.equal(res.rows.length, 1);
    assert.equal(res.rows[0].user_id, REKEY_NEW, "study results must follow the new user id");
  });

  test("the deck is usable under the new identity", async () => {
    const newCookie = await sessionCookieFor(REKEY_NEW);
    const oldCookie = await sessionCookieFor(REKEY_OLD);

    // Signed in as the new id: the deck shows up and loads.
    const list = await api("/api/sessions", { cookie: newCookie });
    assert.equal(list.status, 200);
    assert.ok(
      list.data.sessions.some((s) => s.id === rekeyDeck),
      "re-keyed deck must be listed under the new identity"
    );
    const one = await api(`/api/sessions/${rekeyDeck}`, { cookie: newCookie });
    assert.equal(one.status, 200);
    assert.equal(one.data.session.title, "E2E Rekey Deck");
    assert.equal(one.data.cards.length, 1);

    // The old identity no longer owns anything (moved, not copied).
    const stale = await api("/api/sessions", { cookie: oldCookie });
    assert.equal(stale.status, 200);
    assert.ok(
      !stale.data.sessions.some((s) => s.id === rekeyDeck),
      "deck must not remain under the old identity"
    );
  });
});

// ─── Spaced repetition (P4) ──────────────────────────────────────────────────
/**
 * `/api/review` is the only place where the app *writes* scheduling state, so
 * these are the promises worth locking down:
 *   - the queue is the learner's own cards (never another user's),
 *   - grades walk the SM-2 schedule exactly as src/lib/srs.ts documents,
 *   - a review is also a study result (stats/streak stay consistent),
 *   - overdue cards surface in the queue and on the deck badges,
 *   - the schedule is a card_reviews row, and it dies with the deck.
 *
 * The fixture is created here rather than reusing the earlier decks: other
 * suites create and delete their own, and exact numbers are the point.
 */
describe("spaced repetition (/api/review)", () => {
  let deck; // a deck owned by user A
  let cards; // its three cards

  before(async () => {
    const { rows } = await pool.query(
      `INSERT INTO study_sessions (title, source_type, user_id)
       VALUES ('E2E Review Deck', 'text', $1) RETURNING id`,
      [USER_A]
    );
    deck = rows[0].id;
    cards = [];
    for (let i = 1; i <= 3; i++) {
      const res = await pool.query(
        `INSERT INTO flashcards (session_id, question, answer, difficulty, order_index)
         VALUES ($1, $2, $3, 'medium', $4) RETURNING id`,
        [deck, `Review question ${i}?`, `Review answer ${i}`, i - 1]
      );
      cards.push(res.rows[0].id);
    }
  });

  const grade = (cookie, reviews) =>
    api("/api/review", { method: "POST", cookie, body: { reviews } });

  test("anonymous requests are rejected", async () => {
    const list = await api("/api/review");
    assert.equal(list.status, 401);
    const write = await api("/api/review", {
      method: "POST",
      body: { reviews: [{ cardId: 1, sessionId: 1, grade: "good" }] },
    });
    assert.equal(write.status, 401);
  });

  test("the queue is scoped to the user and starts with brand-new cards", async () => {
    const mine = await api("/api/review", { cookie: tokenA });
    assert.equal(mine.status, 200);
    assert.equal(mine.data.counts.due, 0, "nothing has been reviewed yet");
    assert.equal(mine.data.counts.tracked, 0);

    const queued = mine.data.queue.map((c) => c.cardId);
    for (const id of cards) assert.ok(queued.includes(id), `card ${id} is queued`);
    const first = mine.data.queue.find((c) => c.cardId === cards[0]);
    assert.equal(first.isNew, true);
    assert.equal(first.state, null, "no schedule yet");
    assert.equal(first.deckTitle, "E2E Review Deck");
    assert.equal(mine.data.counts.newIntroducedToday, 0, "no card has been introduced yet");

    // B's queue never contains A's cards.
    const theirs = await api("/api/review", { cookie: tokenB });
    const ids = theirs.data.queue.map((c) => c.cardId);
    assert.ok(!ids.some((id) => cards.includes(id)), "B must not see A's cards");
    assert.ok(ids.includes(cardsB1[0]));
  });

  test("grading walks the learning steps and then graduates the card", async () => {
    // 1st Good → the 10-minute learning step (never scheduled as "days").
    const first = await grade(tokenA, [{ cardId: cards[0], sessionId: deck, grade: "good" }]);
    assert.equal(first.status, 200);
    assert.equal(first.data.recorded, 1);
    assert.deepEqual(first.data.skipped, []);
    assert.equal(first.data.results[0].intervalDays, 0);
    assert.equal(first.data.results[0].dueLabel, "in 10 min");
    assert.equal(first.data.results[0].state.ease, 2.5);

    const row = await pool.query(
      `SELECT ease, interval_days, reps, lapses, review_count, last_grade, due_at
         FROM card_reviews WHERE user_id = $1 AND card_id = $2`,
      [USER_A, cards[0]]
    );
    assert.equal(row.rows.length, 1, "the schedule is persisted");
    assert.equal(row.rows[0].interval_days, 0);
    assert.equal(row.rows[0].reps, 0);
    assert.equal(row.rows[0].review_count, 1);
    assert.equal(row.rows[0].last_grade, "good");

    // The card now waits in the future, so it leaves the queue…
    const queued = await api("/api/review", { cookie: tokenA });
    assert.ok(!queued.data.queue.some((c) => c.cardId === cards[0]), "not due for 10 minutes");
    assert.equal(queued.data.counts.tracked, 1);

    // …but an overdue card is in the queue, and counted as due.
    await pool.query(
      `UPDATE card_reviews SET due_at = now() - interval '2 days' WHERE user_id = $1 AND card_id = $2`,
      [USER_A, cards[0]]
    );
    const due = await api("/api/review", { cookie: tokenA });
    const overdue = due.data.queue.find((c) => c.cardId === cards[0]);
    assert.ok(overdue, "an overdue card is queued");
    assert.equal(overdue.isNew, false);
    assert.equal(due.data.counts.due, 1);
    assert.equal(overdue.state.reviewCount, 1);

    // 2nd Good → graduates to a 1-day interval at the default ease.
    const second = await grade(tokenA, [{ cardId: cards[0], sessionId: deck, grade: "good" }]);
    assert.equal(second.data.results[0].intervalDays, 1);
    assert.equal(second.data.results[0].dueLabel, "tomorrow");
    assert.equal(second.data.results[0].state.reps, 1);

    // 3rd Good → 1 day × ease.
    const third = await grade(tokenA, [{ cardId: cards[0], sessionId: deck, grade: "good" }]);
    assert.equal(third.data.results[0].intervalDays, Math.round(1 * 2.5));
    assert.equal(third.data.results[0].dueLabel, "in 3 days");
  });

  test("Again on a graduated card is a lapse: relearn soon, with a lower ease", async () => {
    const lapsed = await grade(tokenA, [{ cardId: cards[0], sessionId: deck, grade: "again" }]);
    assert.equal(lapsed.data.recorded, 1);
    assert.equal(lapsed.data.results[0].intervalDays, 0);
    assert.equal(lapsed.data.results[0].dueLabel, "in 10 min");
    assert.equal(lapsed.data.results[0].state.lapses, 1);
    assert.equal(lapsed.data.results[0].state.reps, 0);
    assert.equal(lapsed.data.results[0].state.ease, 2.3, "ease drops by 0.2 (floor 1.3)");

    // Graduating again keeps the harder ease: 1 day × 2.3 = 2 days.
    const regraduated = await grade(tokenA, [{ cardId: cards[0], sessionId: deck, grade: "good" }]);
    assert.equal(regraduated.data.results[0].intervalDays, 1);
    const grown = await grade(tokenA, [{ cardId: cards[0], sessionId: deck, grade: "good" }]);
    assert.equal(grown.data.results[0].intervalDays, Math.round(1 * 2.3));
    assert.equal(grown.data.results[0].dueLabel, "in 2 days");
  });

  test("Easy skips the learning steps and Hard grows slowly", async () => {
    const easy = await grade(tokenA, [{ cardId: cards[1], sessionId: deck, grade: "easy" }]);
    assert.equal(easy.data.results[0].intervalDays, 4, "Easy graduates a new card to 4 days");
    assert.ok(easy.data.results[0].state.ease > 2.5);

    const hard = await grade(tokenA, [{ cardId: cards[1], sessionId: deck, grade: "hard" }]);
    assert.equal(hard.data.results[0].intervalDays, Math.max(1, Math.round(4 * 1.2)));
    assert.ok(hard.data.results[0].state.ease < easy.data.results[0].state.ease);
  });

  test("A cannot grade B's cards, and mixed batches report the skips", async () => {
    const attack = await grade(tokenA, [{ cardId: cardsB1[0], sessionId: deckB1, grade: "good" }]);
    assert.equal(attack.status, 200);
    assert.equal(attack.data.recorded, 0);
    assert.equal(attack.data.skipped.length, 1);
    assert.match(attack.data.skipped[0].reason, /Session not found/);

    // A foreign card must not have been scheduled for anybody.
    const rows = await pool.query(`SELECT count(*)::int AS n FROM card_reviews WHERE card_id = $1`, [
      cardsB1[0],
    ]);
    assert.equal(rows.rows[0].n, 0, "a foreign card is never written");

    // A card id that isn't in the claimed deck is rejected too.
    const mismatched = await grade(tokenA, [
      { cardId: cardsB1[0], sessionId: deck, grade: "good" },
    ]);
    assert.equal(mismatched.data.recorded, 0);
    assert.match(mismatched.data.skipped[0].reason, /Card not found in this session/);

    // Mixed batch: A's entry is recorded, B's is skipped.
    const mixed = await grade(tokenA, [
      { cardId: cards[2], sessionId: deck, grade: "good" },
      { cardId: cardsB1[0], sessionId: deckB1, grade: "good" },
    ]);
    assert.equal(mixed.data.recorded, 1);
    assert.equal(mixed.data.skipped.length, 1);
  });

  test("bad shapes are rejected per entry (and a whole batch can't be empty)", async () => {
    const empty = await api("/api/review", { method: "POST", cookie: tokenA, body: { reviews: [] } });
    assert.equal(empty.status, 400);

    const bad = await grade(tokenA, [
      { cardId: cards[2], sessionId: deck, grade: "perfect" },
      { cardId: "nope", sessionId: deck, grade: "good" },
      { cardId: cards[2], sessionId: deck, grade: "easy" },
    ]);
    assert.equal(bad.status, 200);
    assert.equal(bad.data.recorded, 1, "the one valid entry still lands");
    assert.equal(bad.data.skipped.length, 2);
    assert.match(bad.data.skipped[0].reason, /grade must be/);
    assert.match(bad.data.skipped[1].reason, /integers/);
  });

  test("reviews are study results too: stats, streak and the activity feed", async () => {
    const stats = await api("/api/stats", { cookie: tokenA });
    assert.equal(stats.status, 200);
    assert.ok(stats.data.overall.reviewsTracked >= 3, "scheduled cards are counted");
    assert.equal(stats.data.overall.dueNow, 0, "everything is scheduled in the future");
    assert.equal(stats.data.overall.lapses, 1, "the one 'Again' was a lapse");
    assert.ok(stats.data.overall.nextDueAt, "…and the next due date is known");

    const rows = await pool.query(
      `SELECT count(*) filter (where correct)::int AS correct,
              count(*) filter (where not correct)::int AS wrong,
              count(*)::int AS total
         FROM study_results WHERE user_id = $1 AND mode = 'review'`,
      [USER_A]
    );
    assert.equal(rows.rows[0].wrong, 1, "only the 'Again' counts as a miss");
    assert.ok(rows.rows[0].total >= 6, "every graded card became a study result");

    const feed = stats.data.recent.filter((r) => r.mode === "review");
    assert.ok(feed.length > 0, "recent activity includes review answers");
    assert.ok(feed.every((r) => r.deckTitle === "E2E Review Deck"));

    const deckStat = stats.data.decks.find((d) => d.sessionId === deck);
    assert.ok(deckStat, "the reviewed deck is in the stats list");
    assert.equal(deckStat.trackedCount, 3, "all three cards are in rotation");
    assert.equal(deckStat.dueCount, 0);

    // The daily new-card budget is reported honestly (3 cards, 20/day).
    const queue = await api("/api/review", { cookie: tokenA });
    assert.ok(queue.data.counts.newIntroducedToday >= 3, "introduced cards are counted");
  });

  test("deck badges and the ?sessionId filter follow the schedule", async () => {
    const list = await api("/api/sessions", { cookie: tokenA });
    assert.equal(list.status, 200);
    const badge = list.data.sessions.find((s) => s.id === deck);
    assert.equal(badge.trackedCount, 3, "cards in rotation are counted per deck");
    assert.equal(badge.dueCount, 0);

    // Force a card due again → the deck badge and the queue agree.
    await pool.query(
      `UPDATE card_reviews SET due_at = now() - interval '1 hour' WHERE user_id = $1 AND card_id = $2`,
      [USER_A, cards[1]]
    );
    const badged = await api("/api/sessions", { cookie: tokenA });
    assert.equal(badged.data.sessions.find((s) => s.id === deck).dueCount, 1);

    const oneDeck = await api(`/api/review?sessionId=${deck}`, { cookie: tokenA });
    assert.equal(oneDeck.data.counts.due, 1);
    assert.equal(oneDeck.data.queue.length, 1);
    assert.equal(oneDeck.data.queue[0].cardId, cards[1]);
    assert.ok(oneDeck.data.queue[0].dueAt, "due cards expose their schedule");

    // A deck filter never widens the scope: B's deck id under A's cookie is empty.
    const foreign = await api(`/api/review?sessionId=${deckB1}`, { cookie: tokenA });
    assert.equal(foreign.status, 200);
    assert.deepEqual(foreign.data.queue, []);
    assert.equal(foreign.data.counts.due, 0);
  });

  test("deleting a deck cascades to its review schedules", async () => {
    const before = await pool.query(
      `SELECT count(*)::int AS n FROM card_reviews WHERE session_id = $1`,
      [deck]
    );
    assert.equal(before.rows[0].n, 3);

    const del = await api(`/api/sessions/${deck}`, { method: "DELETE", cookie: tokenA });
    assert.equal(del.status, 200);

    const gone = await pool.query(`SELECT count(*)::int AS n FROM card_reviews WHERE session_id = $1`, [
      deck,
    ]);
    assert.equal(gone.rows[0].n, 0, "schedules follow the deck out");

    // …and the user's counters drop back to zero.
    const stats = await api("/api/stats", { cookie: tokenA });
    assert.equal(stats.data.overall.reviewsTracked, 0);
  });
});
