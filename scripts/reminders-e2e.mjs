#!/usr/bin/env node
/**
 * E2E: the daily review-reminder pipeline (inbox + web push opt-in + cron).
 *
 * Runs entirely in the sandbox: an embedded PGlite database (no Postgres
 * install needed), a spawned `next dev`, and Auth.js session JWTs minted the
 * way scripts/offline-e2e.test.mjs does — so the whole flow is exercised over
 * real HTTP, including the cron endpoint's bearer auth and the push delivery
 * queue (whose sends legitimately fail here: no real push service).
 *
 *   npm run test:reminders-e2e
 *
 * What it proves:
 *   - the inbox API needs a session, and starts empty,
 *   - cron rejects missing/wrong secrets, and creates exactly one inbox row
 *     per user per local day (reruns are no-ops),
 *   - enabling push without a registered device is refused (409),
 *   - subscribe → enable → test-send works, and a cron tick queues a
 *     delivery per device (lease + retry state visible in push_deliveries),
 *   - unsubscribing the last device turns the account's reminder switch off.
 */
import assert from "node:assert/strict";
import { execSync, spawn } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import pg from "pg";
import webpush from "web-push";
import { encode } from "next-auth/jwt";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PG_PORT = 5439;
const APP_PORT = 3111;
const DATABASE_URL = `postgresql://postgres@127.0.0.1:${PG_PORT}/postgres`;
const AUTH_SECRET = "reminders-e2e-secret";
const CRON_SECRET = "reminders-e2e-cron-secret";
const USER = "rem-e2e-user-1";

const sessionToken = await encode({
  token: { userId: USER, sub: USER, email: `${USER}@e2e.local`, name: "Rem E2E", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 },
  secret: AUTH_SECRET,
  salt: "authjs.session-token",
});
const COOKIE = `authjs.session-token=${sessionToken}`;

// Clean up stragglers from earlier crashed runs (this script's own command
// line doesn't contain these patterns, so pkill can't hit itself).
for (const pattern of [`next dev -p ${APP_PORT}`, `dev-pglite-server.mjs ${PG_PORT}`]) {
  try { execSync(`pkill -f '${pattern}' || true`); } catch { /* nothing running */ }
}

const children = [];
function spawnChild(name, command, args, env = {}) {
  // detached: the dev server spawns a server child of its own — only a
  // process-group kill takes the whole tree down on cleanup.
  const child = spawn(command, args, { cwd: env.QUIZTIME_E2E_MIRROR ?? root, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const log = createWriteStream(`/tmp/reminders-e2e-${name}.log`);
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  child.name = name;
  children.push(child);
  return child;
}
async function waitFor(fn, label, timeoutMs = 120_000) {
  const started = Date.now();
  let last = "";
  for (;;) {
    try {
      last = String(await fn());
      if (last === "true") return;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    if (Date.now() - started > timeoutMs) {
      for (const name of ["pglite", "next"]) {
        try {
          console.error(`── /tmp/reminders-e2e-${name}.log (tail) ──`);
          console.error(readFileSync(`/tmp/reminders-e2e-${name}.log`, "utf8").split("\n").slice(-25).join("\n"));
        } catch { /* no log */ }
      }
      throw new Error(`Timed out waiting for ${label} (last probe: ${last})`);
    }
    await new Promise((r) => setTimeout(r, 700));
  }
}

// ── 1 ── Embedded database + migrations ────────────────────────────────────
// A leftover database from a crashed run would fail the non-idempotent parts
// of old migrations, so a database that answers before we spawn anything gets
// reset to an empty schema first.
let client = new pg.Client({ connectionString: DATABASE_URL });
let reused = true;
try {
  await client.connect();
  await client.query("DROP SCHEMA public CASCADE");
  await client.query("CREATE SCHEMA public");
} catch {
  reused = false;
  client = new pg.Client({ connectionString: DATABASE_URL });
  spawnChild("pglite", process.execPath, [join(root, "scripts/dev-pglite-server.mjs"), String(PG_PORT)]);
  await waitFor(async () => {
    // A pg.Client that failed to connect can't reconnect — mint a fresh one
    // per attempt and keep the first that works.
    try {
      await client.connect();
      return "true";
    } catch {
      client = new pg.Client({ connectionString: DATABASE_URL });
      return false;
    }
  }, "pglite");
}
if (reused) console.log("reusing a leftover test database (reset to empty schema)");
for (const file of readdirSync(join(root, "drizzle")).filter((f) => f.endsWith(".sql")).sort()) {
  await client.query(readFileSync(join(root, "drizzle", file), "utf8"));
}

// ── 2 ── Seed: one user with three overdue cards ───────────────────────────
try {
await client.query(`INSERT INTO users (id, email, name, provider) VALUES ($1, $2, 'Rem E2E', 'google')`, [USER, `${USER}@e2e.local`]);
const { rows: [deck] } = await client.query(
  `INSERT INTO study_sessions (title, source_type, user_id) VALUES ('E2E Deck', 'text', $1) RETURNING id`, [USER]
);
for (let i = 1; i <= 3; i += 1) {
  const { rows: [card] } = await client.query(
    `INSERT INTO flashcards (session_id, question, answer, order_index) VALUES ($1, $2, 'A', $3) RETURNING id`,
    [deck.id, `Q${i}`, i]
  );
  await client.query(
    `INSERT INTO card_reviews (user_id, card_id, session_id, ease, interval_days, due_at)
     VALUES ($1, $2, $3, 2.5, 1, now() - interval '1 hour')`,
    [USER, card.id, deck.id]
  );
}

// ── 3 ── App server with push configured ───────────────────────────────────
// Next.js allows only ONE dev server per project directory (a .next lock),
// so the e2e runs from a mirror of symlinks with its own .next — the main
// checkout's dev server (if any) keeps running undisturbed.
const MIRROR = "/tmp/quiztime-e2e-app";
rmSync(MIRROR, { recursive: true, force: true });
mkdirSync(MIRROR, { recursive: true });
// Real copies for everything the router scans (symlinked src breaks route
// discovery); node_modules stays a symlink (webpack resolves it fine).
for (const entry of ["src", "public", "drizzle", "package.json", "next.config.ts", "tsconfig.json"]) {
  execSync(`cp -R ${JSON.stringify(join(root, entry))} ${JSON.stringify(join(MIRROR, entry))}`);
}
symlinkSync(join(root, "node_modules"), join(MIRROR, "node_modules"));
const vapid = await webpush.generateVAPIDKeys();
spawnChild("next", "npx", ["next", "dev", "--webpack", "-p", String(APP_PORT)], {
  DATABASE_URL,
  AUTH_SECRET,
  AUTH_TRUST_HOST: "true",
  CRON_SECRET,
  VAPID_PUBLIC_KEY: vapid.publicKey,
  VAPID_PRIVATE_KEY: vapid.privateKey,
  VAPID_SUBJECT: "mailto:e2e@quiztime.local",
  QUIZTIME_E2E_MIRROR: MIRROR,
});
const api = async (path, init = {}) => {
  const res = await fetch(`http://127.0.0.1:${APP_PORT}${path}`, {
    ...init,
    headers: {
      cookie: COOKIE,
      origin: `http://127.0.0.1:${APP_PORT}`, // browsers always send this on writes
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
};
await waitFor(async () => {
  const res = await fetch(`http://127.0.0.1:${APP_PORT}/api/notifications`, { headers: { cookie: COOKIE } });
  const text = await res.text();
  return res.status === 200 || `status ${res.status}: ${text.slice(0, 200)}`;
}, "notifications API", 180_000);

// ── 4 ── The flow ──────────────────────────────────────────────────────────
const vapidKeys = () => {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    p256dh: publicKey.export({ type: "spki", format: "der" }).subarray(-65).toString("base64url"),
    auth: randomBytes(16).toString("base64url"),
  };
};

  // Inbox starts empty, and only for the signed-in (no cookie at all here).
  const anon = await fetch(`http://127.0.0.1:${APP_PORT}/api/notifications`);
  assert.equal(anon.status, 401);
  let inbox = (await api("/api/notifications")).body;
  assert.deepEqual(inbox.notifications, []);
  assert.equal(inbox.push.configured, true);
  assert.ok(inbox.push.publicKey);

  // Cron is bearer-protected.
  const cron = (headers) => fetch(`http://127.0.0.1:${APP_PORT}/api/cron/reminders`, { headers }).then((r) => r.status);
  assert.equal(await cron({}), 401);
  assert.equal(await cron({ authorization: "Bearer nope" }), 401);

  // Enabling push before any device exists is refused.
  assert.equal((await api("/api/notifications", { method: "PATCH", body: JSON.stringify({ enabled: true }) })).status, 409);
  // Bad preference values are rejected.
  assert.equal((await api("/api/notifications", { method: "PATCH", body: JSON.stringify({ reminderTime: "25:00" }) })).status, 400);

  // Register a device (structurally valid keys; sends will fail in-sandbox,
  // which is exactly the retry path we want to see), then opt in.
  const keys = vapidKeys();
  const endpoint = "https://fcm.googleapis.com/fcm/send/e2e-device-1";
  const sub = await api("/api/notifications/subscribe", { method: "POST", body: JSON.stringify({ subscription: { endpoint, keys } }) });
  assert.equal(sub.status, 200, JSON.stringify(sub.body));
  assert.equal(sub.body.deviceCount, 1);
  const enabled = await api("/api/notifications", { method: "PATCH", body: JSON.stringify({ enabled: true }) });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.body.preferences.enabled, true);

  // Aim the reminder window at *now* so the cron tick matches it.
  const now = new Date();
  const hhmm = `${String(now.getUTCHours()).padStart(2, "0")}:${String(now.getUTCMinutes()).padStart(2, "0")}`;
  const pref = await api("/api/notifications", { method: "PATCH", body: JSON.stringify({ reminderTime: hhmm, timeZone: "UTC" }) });
  assert.equal(pref.body.preferences.reminderTime, hhmm);

  // The tick: one inbox row + one queued delivery, attempted once.
  const tick = await fetch(`http://127.0.0.1:${APP_PORT}/api/cron/reminders`, { headers: { authorization: `Bearer ${CRON_SECRET}` } });
  assert.equal(tick.status, 200);
  const tickBody = await tick.json();
  assert.equal(tickBody.reminded, 1, JSON.stringify(tickBody));
  assert.equal(tickBody.queued, 1);
  assert.ok(tickBody.sent + tickBody.deferred >= 1, JSON.stringify(tickBody));

  inbox = (await api("/api/notifications")).body;
  assert.equal(inbox.notifications.length, 1);
  assert.equal(inbox.notifications[0].dueCount, 3);
  assert.equal(inbox.unread, 1);

  // Reruns never double-remind (the (user, local day) unique key).
  const tick2 = await (await fetch(`http://127.0.0.1:${APP_PORT}/api/cron/reminders`, { headers: { authorization: `Bearer ${CRON_SECRET}` } })).json();
  assert.equal(tick2.reminded, 0, JSON.stringify(tick2));

  // The delivery row exists and was leased/attempted, not stuck pending-new.
  const { rows: deliveries } = await client.query(`SELECT status, attempts FROM push_deliveries`);
  assert.equal(deliveries.length, 1);
  assert.ok(["sent", "pending", "failed"].includes(deliveries[0].status), deliveries[0].status);
  assert.ok(deliveries[0].attempts >= 1);

  // Test-send reaches the endpoint handler (send itself fails in-sandbox).
  const test = await api("/api/notifications/test", { method: "POST", body: "{}" });
  assert.equal(test.status, 200);
  assert.equal(test.body.devices, 1);

  // Mark-as-read clears the badge.
  const read = await api("/api/notifications", { method: "PATCH", body: JSON.stringify({ markRead: "all" }) });
  assert.equal(read.body.unread, 0);

  // Unsubscribing the last device switches the account back off.
  const unsub = await api("/api/notifications/subscribe", { method: "DELETE", body: JSON.stringify({ endpoint }) });
  assert.equal(unsub.body.deviceCount, 0);
  inbox = (await api("/api/notifications")).body;
  assert.equal(inbox.preferences.enabled, false);

  console.log("reminders e2e: all assertions passed", JSON.stringify(tickBody));
} catch (error) {
  for (const name of ["pglite", "next"]) {
    try {
      console.error(`── /tmp/reminders-e2e-${name}.log (tail) ──`);
      console.error(readFileSync(`/tmp/reminders-e2e-${name}.log`, "utf8").split("\n").slice(-30).join("\n"));
    } catch { /* no log */ }
  }
  throw error;
} finally {
  for (const child of children) {
    try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  }
  await client.end().catch(() => {});
  // give the children a beat to exit so the test runner doesn't hang
  await new Promise((r) => setTimeout(r, 500));
}
