#!/usr/bin/env node
/**
 * E2E: the owner-only "who's online" roster (`/api/presence`).
 *
 * Same harness as scripts/auth-e2e.mjs: Auth.js session JWTs are minted with
 * next-auth/jwt's encode() (salt "authjs.session-token"), so the suite can talk
 * to the real API over HTTP exactly like a browser with a session cookie —
 * no Google round trip needed.
 *
 * What it proves:
 *   - the heartbeat endpoint needs a session (401) and the roster is owner-only
 *     (403 for everybody else, without leaking who the owner is),
 *   - a non-owner heartbeat still records presence, but never returns the count,
 *   - the owner sees every account: those with a fresh heartbeat as online,
 *     stale ones as "N min ago", accounts that never checked in as never-seen,
 *   - the online/offline boundary is the window in src/lib/presence.ts,
 *   - what the client sends is a *label*: activity/device are sanitised, and a
 *     client-supplied timestamp is ignored (ages come from the database clock),
 *   - one row per user (the heartbeat is an upsert), and deleting a user
 *     cascades their presence row away.
 *
 * Usage (server on $BASE_URL or spawned automatically):
 *   OWNER_EMAIL=you@example.com npm run test:presence-e2e
 *   NPM_CMD=dev npm run test:presence-e2e          # spawns `npm run dev`
 *   BASE_URL=http://127.0.0.1:3000 OWNER_EMAIL=you@example.com npm run test:presence-e2e
 *
 * Requires DATABASE_URL, AUTH_SECRET and OWNER_EMAIL in the environment (or
 * .env.local, which the spawned server loads). The owner fixture signs in with
 * the *first* address in OWNER_EMAIL, so the test also proves that the env var
 * — not the database — decides who the owner is.
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
const RAW_OWNER_EMAIL = process.env.OWNER_EMAIL;

assert.ok(AUTH_SECRET, "AUTH_SECRET must be set (same value the server uses)");
assert.ok(DATABASE_URL, "DATABASE_URL must be set (same database the server uses)");
assert.ok(
  RAW_OWNER_EMAIL,
  "OWNER_EMAIL must be set — that is the setting this suite is about (and the spawned server gets it)"
);

/** The address the owner fixture signs in with = the first configured owner. */
const OWNER_FIXTURE_EMAIL = RAW_OWNER_EMAIL.split(/[,\s;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean)[0];

const { ONLINE_WINDOW_SECONDS, MAX_ACTIVITY_LENGTH } = await import("../src/lib/presence.ts");

const COOKIE = "authjs.session-token"; // http (non-secure) cookie name in Auth.js v5
const OWNER = "e2e-owner-000001";
const ONLINE = "e2e-online-000002";
const IDLE = "e2e-idle-000003";
const NEWCOMER = "e2e-new-000004";
const EDGE = "e2e-edge-000005";

const FIXTURES = [OWNER, ONLINE, IDLE, NEWCOMER, EDGE];

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

/** The owner's cookie carries the configured OWNER_EMAIL — that is the whole point. */
const ownerCookie = () =>
  encode({
    token: {
      userId: OWNER,
      sub: OWNER,
      email: OWNER_FIXTURE_EMAIL,
      name: "E2E Owner",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 60 * 60,
      jti: `e2e-owner-${Date.now()}`,
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

const ageOf = async (userId) => {
  const { rows } = await pool.query(
    `SELECT floor(extract(epoch FROM (now() - last_seen_at)))::int AS age FROM user_presence WHERE user_id = $1`,
    [userId]
  );
  return rows[0]?.age ?? null;
};

const rowFor = async (userId) => {
  const { rows } = await pool.query(`SELECT * FROM user_presence WHERE user_id = $1`, [userId]);
  return rows[0] ?? null;
};

async function seed() {
  await pool.query(`DELETE FROM users WHERE id = ANY($1)`, [FIXTURES]);
  for (const id of FIXTURES) {
    const email = id === OWNER ? OWNER_FIXTURE_EMAIL : `${id}@e2e.local`;
    await pool.query(
      `INSERT INTO users (id, email, name, provider) VALUES ($1, $2, $3, 'google')`,
      [id, email, `E2E ${id.slice(-4)}`]
    );
  }

  // IDLE was last seen 5 minutes ago, EDGE just *outside* the online window —
  // the two "offline but recently seen" shapes the roster must tell apart.
  await pool.query(
    `INSERT INTO user_presence (user_id, last_seen_at, activity, device)
     VALUES ($1, now() - interval '5 minutes', 'Studying “Old Deck”', 'Safari · iPad'),
            ($2, now() - ($3 * interval '1 second'), NULL, NULL)`,
    [IDLE, EDGE, ONLINE_WINDOW_SECONDS + 5]
  );
  // OWNER, ONLINE and NEWCOMER start with no presence row at all.
}

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
      // Own process group: `npm run` is a wrapper around the real server, so
      // stopping the test must be able to take the whole group down.
      detached: true,
      env: {
        ...process.env,
        HOSTNAME: "0.0.0.0",
        PORT: String(new URL(BASE_URL).port || 3000),
        // The spawned server must see the same owner configuration.
        OWNER_EMAIL: RAW_OWNER_EMAIL,
      },
      stdio: "inherit",
    });
    await waitForServer();
  }
  await seed();
});

after(async () => {
  await pool.query(`DELETE FROM users WHERE id = ANY($1)`, [FIXTURES]);
  await pool.end();
  if (spawned?.pid) {
    // Kill the group (npm + the server it started), otherwise an orphaned
    // next-server keeps the port — and this process — alive.
    try {
      process.kill(-spawned.pid, "SIGTERM");
    } catch {
      spawned.kill("SIGTERM");
    }
  }
});

// ── Tests ────────────────────────────────────────────────────────────────────
describe("presence: access control", () => {
  test("anonymous callers get 401 on both the heartbeat and the roster", async () => {
    assert.equal((await api("/api/presence")).status, 401);
    assert.equal((await api("/api/presence", { method: "POST", body: {} })).status, 401);
  });

  test("a signed-in non-owner gets 403 from the roster", async () => {
    const r = await api("/api/presence", { cookie: await sessionCookieFor(ONLINE) });
    assert.equal(r.status, 403);
    // …and the refusal must not disclose who the owner is.
    const body = JSON.stringify(r.data);
    assert.ok(!body.includes(OWNER_FIXTURE_EMAIL), "the 403 leaks the owner's address");
    assert.ok(!body.toLowerCase().includes("owner_email"));
  });

  test("a non-owner heartbeat is recorded but never returns the count", async () => {
    const r = await api("/api/presence", {
      method: "POST",
      cookie: await sessionCookieFor(ONLINE),
      body: { activity: "Reviewing due cards", device: "Chrome · macOS" },
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
    assert.equal(r.data.online, null, "only the owner may read the live count");

    const row = await rowFor(ONLINE);
    assert.ok(row, "the heartbeat should have created a presence row");
    assert.equal(row.activity, "Reviewing due cards");
    assert.equal(row.device, "Chrome · macOS");
    assert.ok((await ageOf(ONLINE)) <= 5, "the row should be fresh");
  });
});

describe("presence: heartbeat is an upsert of labels only", () => {
  test("beating twice keeps exactly one row per user", async () => {
    const cookie = await sessionCookieFor(ONLINE);
    await api("/api/presence", { method: "POST", cookie, body: { activity: "First" } });
    await api("/api/presence", { method: "POST", cookie, body: { activity: "Second" } });

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM user_presence WHERE user_id = $1`,
      [ONLINE]
    );
    assert.equal(rows[0].n, 1);
  });

  test("activity is sanitised (control characters, length) before storage", async () => {
    const r = await api("/api/presence", {
      method: "POST",
      cookie: await sessionCookieFor(NEWCOMER),
      body: {
        activity: `Studying\u0000\u0007${"x".repeat(400)}`,
        device: "Chrome\n·\tWindows",
      },
    });
    assert.equal(r.status, 200);

    const row = await rowFor(NEWCOMER);
    assert.ok(row);
    assert.doesNotMatch(row.activity, /[\u0000-\u001f\u007f]/);
    assert.ok(row.activity.length <= MAX_ACTIVITY_LENGTH);
    assert.equal(row.device, "Chrome · Windows");
  });

  test("a client-supplied timestamp is ignored — the age comes from the database", async () => {
    const r = await api("/api/presence", {
      method: "POST",
      cookie: await sessionCookieFor(NEWCOMER),
      body: { activity: "Trying to time travel", lastSeenAt: "2000-01-01T00:00:00.000Z" },
    });
    assert.equal(r.status, 200);

    const age = await ageOf(NEWCOMER);
    assert.ok(age !== null && age <= 5, `expected a fresh row, got an age of ${age}s`);
  });
});

describe("presence: the owner's roster", () => {
  test("the owner's heartbeat returns the live count", async () => {
    const r = await api("/api/presence", {
      method: "POST",
      cookie: await ownerCookie(),
      body: { activity: "Checking stats", device: "Chrome · macOS" },
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
    assert.equal(typeof r.data.online, "number");
    assert.ok(r.data.online >= 2, "the owner + the online fixture should be inside the window");
  });

  test("the owner sees every account, with the right online/offline split", async () => {
    const r = await api("/api/presence", { cookie: await ownerCookie() });
    assert.equal(r.status, 200);
    assert.equal(r.data.windowSeconds, ONLINE_WINDOW_SECONDS);

    const byId = new Map(r.data.users.map((u) => [u.id, u]));
    const mine = (id) => {
      const user = byId.get(id);
      assert.ok(user, `${id} is missing from the roster (${r.data.users.length} rows)`);
      return user;
    };

    // Fresh heartbeat → online.
    assert.equal(mine(ONLINE).online, true);
    assert.ok(mine(ONLINE).lastSeenSecondsAgo <= 5);
    // The owner's own heartbeat counts too, and is flagged as the owner.
    assert.equal(mine(OWNER).online, true);
    assert.equal(mine(OWNER).isOwner, true);
    // 5 minutes old → offline with a usable "how long ago".
    assert.equal(mine(IDLE).online, false);
    assert.ok(mine(IDLE).lastSeenSecondsAgo >= 295 && mine(IDLE).lastSeenSecondsAgo <= 305);
    assert.equal(mine(IDLE).activity, "Studying “Old Deck”");
    // Just outside the window → offline (the boundary is not "roughly 90 s").
    assert.equal(mine(EDGE).online, false);
    assert.ok(mine(EDGE).lastSeenSecondsAgo > ONLINE_WINDOW_SECONDS);
    // Beat seconds ago in the tests above → online.
    assert.equal(mine(NEWCOMER).online, true);
    // Non-owners are never marked as the owner.
    assert.equal(mine(ONLINE).isOwner, false);
    assert.equal(mine(IDLE).isOwner, false);

    // Online first, then most recent — the order the panel renders.
    const onlineFlags = r.data.users.map((u) => u.online);
    assert.deepEqual(onlineFlags, [...onlineFlags].sort((a, b) => Number(b) - Number(a)));
    assert.equal(r.data.online, onlineFlags.filter(Boolean).length);
  });

  test("an account that never checked in is online=false with a null age", async () => {
    await pool.query(`DELETE FROM user_presence WHERE user_id = $1`, [EDGE]);
    const r = await api("/api/presence", { cookie: await ownerCookie() });
    const edge = r.data.users.find((u) => u.id === EDGE);
    assert.equal(edge.online, false);
    assert.equal(edge.lastSeenSecondsAgo, null);
    assert.equal(edge.activity, null);
  });

  test("crossing the window flips a user from online to offline", async () => {
    // Just inside the window…
    await pool.query(
      `UPDATE user_presence SET last_seen_at = now() - ($2 * interval '1 second') WHERE user_id = $1`,
      [IDLE, ONLINE_WINDOW_SECONDS - 5]
    );
    let r = await api("/api/presence", { cookie: await ownerCookie() });
    assert.equal(r.data.users.find((u) => u.id === IDLE).online, true);

    // …and just outside it.
    await pool.query(
      `UPDATE user_presence SET last_seen_at = now() - ($2 * interval '1 second') WHERE user_id = $1`,
      [IDLE, ONLINE_WINDOW_SECONDS + 5]
    );
    r = await api("/api/presence", { cookie: await ownerCookie() });
    assert.equal(r.data.users.find((u) => u.id === IDLE).online, false);
  });

  test("the roster count follows what is inside the window", async () => {
    // Leave only the owner online: push every other fixture outside the window.
    await pool.query(
      `UPDATE user_presence SET last_seen_at = now() - interval '1 day' WHERE user_id = ANY($1)`,
      [[ONLINE, IDLE, NEWCOMER, EDGE]]
    );
    const before = await api("/api/presence", { cookie: await ownerCookie() });
    assert.equal(before.data.online, 1, "only the owner should be online now");

    // A single heartbeat brings one of them back.
    await api("/api/presence", { method: "POST", cookie: await sessionCookieFor(ONLINE) });
    const after = await api("/api/presence", { cookie: await ownerCookie() });
    assert.equal(after.data.online, 2);
  });

  test("deleting a user cascades their presence row away", async () => {
    await api("/api/presence", { method: "POST", cookie: await sessionCookieFor(NEWCOMER) });
    assert.ok(await rowFor(NEWCOMER), "fixture should have a presence row");

    await pool.query(`DELETE FROM users WHERE id = $1`, [NEWCOMER]);
    assert.equal(await rowFor(NEWCOMER), null, "the presence row outlived its user");
  });
});
