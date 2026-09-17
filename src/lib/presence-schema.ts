import { pool } from "@/db";
import { PRESENCE_SCHEMA_STATEMENTS } from "@/lib/presence-schema-sql";

/**
 * Creating the presence table when it isn't there.
 *
 * `drizzle/0005_presence.sql` is fully idempotent (`CREATE TABLE IF NOT
 * EXISTS`, a `duplicate_object`-guarded FK, `CREATE INDEX IF NOT EXISTS`), so
 * running the same statements at runtime is safe on a fresh database, on one
 * that already has the table, and on production (Supabase) where the same SQL
 * is pasted by hand.
 *
 * Why the app runs them at all: the owner-only roster used to fail with
 * "The server couldn't load the list — usually the database: check DATABASE_URL
 * and that the presence migration has been applied", which asks the owner to
 * run `npm run db:migrate` on a machine that usually isn't theirs (the app runs
 * on a host; the tables live in someone else's Postgres). Creating the one
 * small table this feature owns is the difference between a feature that
 * switches itself on and a support ticket — so the route calls
 * `ensurePresenceSchema()` after a 42P01 on `user_presence` and retries once.
 *
 * Guard rails, because this is DDL from a request path:
 *   - it only ever creates *its own* table (nothing else is touched),
 *   - once it has succeeded it is a boolean read for the life of the process,
 *   - after a failure it backs off for SCHEMA_RETRY_COOLDOWN_MS, so a role
 *     without CREATE can't be hammered with DDL by every heartbeat,
 *   - concurrent requests share one in-flight attempt.
 *
 * Server-only (imports the `pg` pool) — never import this from a component.
 */

/** How long to wait before trying the DDL again after a failed attempt. */
export const SCHEMA_RETRY_COOLDOWN_MS = 60_000;

let ensured = false;
let lastFailureAt = 0;
let inFlight: Promise<boolean> | null = null;

/** Forget the "already done" state — used by tests (and only by tests). */
export function resetPresenceSchemaState(): void {
  ensured = false;
  lastFailureAt = 0;
  inFlight = null;
}

/** Has a previous call in this process already confirmed the table exists? */
export function presenceSchemaEnsured(): boolean {
  return ensured;
}

/** Run the DDL. Never throws: failure is `false` plus a log line. */
async function runStatements(): Promise<boolean> {
  try {
    for (const statement of PRESENCE_SCHEMA_STATEMENTS) {
      await pool.query(statement);
    }
    ensured = true;
    lastFailureAt = 0;
    return true;
  } catch (error) {
    lastFailureAt = Date.now();
    // Not the caller's problem to surface: the query that failed first is the
    // error worth reporting, this one only explains why it wasn't retried.
    console.error("ensurePresenceSchema: could not create user_presence:", error);
    return false;
  }
}

/**
 * Make sure `user_presence` exists. Resolves `true` when the table is there
 * afterwards, `false` when it could not be created (no permission, database
 * unreachable, …) — the caller then reports the original failure.
 *
 * Cheap to call from a request path: after a success it is a boolean read, and
 * failures back off for SCHEMA_RETRY_COOLDOWN_MS.
 *
 * `force` is for the caller that has *just* hit a 42P01: the remembered
 * success is stale by definition (somebody dropped the table), so the DDL runs
 * again. It is still idempotent, and still backed off after a failed attempt.
 */
export async function ensurePresenceSchema({ force = false }: { force?: boolean } = {}): Promise<boolean> {
  if (ensured && !force) return true;
  if (inFlight) return inFlight;
  if (Date.now() - lastFailureAt < SCHEMA_RETRY_COOLDOWN_MS) return false;

  const attempt = runStatements();
  inFlight = attempt;
  try {
    return await attempt;
  } finally {
    inFlight = null;
  }
}
