import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { userPresence, users } from "@/db/schema";
import { requireOwner, requireUser } from "@/lib/auth-guard";
import { classifyDbError, type DbFailureKind } from "@/lib/db-errors";
import { isOwnerEmail } from "@/lib/owner";
import { ensurePresenceSchema } from "@/lib/presence-schema";
import {
  ONLINE_WINDOW_SECONDS,
  PRESENCE_LIST_LIMIT,
  isOnline,
  sanitizeActivity,
  sanitizeDevice,
  sortPresence,
  type PresenceEntry,
} from "@/lib/presence";

/**
 * /api/presence — "who's online".
 *
 *   POST  heartbeat from any signed-in browser (every 30 s)
 *   GET   the roster: every account + when it was last seen — OWNER ONLY
 *
 * Both directions are in one route on purpose: the write and the read are the
 * two halves of the same tiny feature, and the owner's own heartbeat comes back
 * with the live count so the app shell doesn't need a second polling loop.
 *
 * Nothing here trusts the client with identity: the heartbeat always writes the
 * *session's* user id, and the roster compares the *session's* email against
 * OWNER_EMAIL (see src/lib/auth-guard.ts → requireOwner).
 *
 * Env is read per request, so OWNER_EMAIL can be changed without a rebuild.
 */
export const dynamic = "force-dynamic";

/**
 * Every failure path answers with the same shape:
 *
 *   { "error": "human sentence", "reason": "missing_table" }
 *
 * `reason` is what the panel turns into advice (src/lib/use-presence.ts) — it
 * is a short fixed string, never the raw Postgres message, so a broken
 * database can't be used to read the server's internals from the browser. The
 * full error still goes to the server log.
 */
const failureResponse = (reason: DbFailureKind | "auth", error: string, status: number) =>
  NextResponse.json({ error, reason }, { status });

/**
 * A classified database failure is the service being unable to do its job
 * right now, which is a 503; only an unclassified one is a plain 500. (The
 * client treats every non-401/403 the same way — it reads `reason`.)
 */
const statusForFailure = (kind: DbFailureKind): number => (kind === "unknown" ? 500 : 503);

/** The sentence that goes with each `reason`. */
const FAILURE_MESSAGE: Record<DbFailureKind | "auth", string> = {
  missing_table: "The database is missing a table this feature needs",
  unreachable: "The server can't reach its database",
  credentials: "The server's database credentials were rejected",
  permission: "The database user isn't allowed to create the table this feature needs",
  auth: "Sign-in isn't configured on the server",
  unknown: "Failed to load who's online",
};

/**
 * Run a database call, and if it fails because `user_presence` isn't in the
 * database yet, create it (idempotently) and run it again — once.
 *
 * This is what stops the roster from dead-ending on "run npm run db:migrate":
 * the migration is a `CREATE TABLE IF NOT EXISTS` plus a guarded FK and index,
 * so the app can safely apply the one table it owns. A missing `users` table,
 * a missing column, or any other failure is rethrown untouched — repairing
 * those is a migration's job, not a request's.
 */
async function withPresenceSchema<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const failure = classifyDbError(error);
    const repairable = failure.kind === "missing_table" && failure.table === "user_presence";
    // force: we have just seen the table missing, so any remembered success is
    // stale (a drop, a restore, a rollback) and the DDL has to run again.
    if (!repairable || !(await ensurePresenceSchema({ force: true }))) throw error;
    return await run();
  }
}

/** Shared failure handling for both handlers: classify, then answer honestly. */
function presenceFailure(where: "GET" | "POST", error: unknown): NextResponse {
  const failure = classifyDbError(error);
  console.error(`${where} /api/presence error:`, error);
  return failureResponse(failure.kind, FAILURE_MESSAGE[failure.kind], statusForFailure(failure.kind));
}

/** How many people are inside the online window right now (database clock). */
async function countOnline(): Promise<number> {
  const [row] = await db
    .select({ online: sql<number>`count(*)::int` })
    .from(userPresence)
    .where(
      sql`${userPresence.lastSeenAt} > now() - (interval '1 second' * ${ONLINE_WINDOW_SECONDS}::int)`
    );
  return row?.online ?? 0;
}

/**
 * POST /api/presence — one heartbeat.
 *
 * Body (both optional):
 *   { "activity": "Studying “Cell Biology”", "device": "Chrome · macOS" }
 *
 * The row is upserted, so the payload is never more than one small write per
 * user per heartbeat. Returns `{ ok: true, online }` where `online` is the
 * current count for the owner and `null` for everybody else.
 */
export async function POST(request: Request) {
  // The sign-in check is kept out of the database error path: an Auth.js
  // misconfiguration is not a database problem, and saying so is the whole
  // point of `reason`.
  let guard: Awaited<ReturnType<typeof requireUser>>;
  try {
    guard = await requireUser();
  } catch (error) {
    console.error("POST /api/presence: sign-in check failed:", error);
    return failureResponse("auth", FAILURE_MESSAGE.auth, 500);
  }
  if (guard instanceof NextResponse) return guard;

  // Captured in locals: the closures below would otherwise lose the narrowing
  // that says `guard` isn't a response.
  const { id: userId, email } = guard.user;

  // The body is optional: a bare beat still means "I'm here".
  const body = (await request.json().catch(() => null)) as
    | { activity?: unknown; device?: unknown }
    | null;
  const activity = sanitizeActivity(body?.activity);
  const device = sanitizeDevice(body?.device);

  try {
    await withPresenceSchema(() =>
      db
        .insert(userPresence)
        .values({ userId, activity, device })
        .onConflictDoUpdate({
          target: userPresence.userId,
          set: {
            // now() (not the app's clock) so the online window is measured
            // entirely inside Postgres — clock skew can never stretch it.
            lastSeenAt: sql`now()`,
            activity,
            device,
          },
        })
    );

    return NextResponse.json({
      ok: true,
      online: isOwnerEmail(email) ? await withPresenceSchema(countOnline) : null,
    });
  } catch (error) {
    return presenceFailure("POST", error);
  }
}

/**
 * GET /api/presence — the owner's roster.
 *
 * Every account is listed once, whether or not it has ever checked in, with
 * `lastSeenSecondsAgo` measured by the database (`now()` minus the row) rather
 * than by sending a timestamp the client could misinterpret in another
 * timezone. `online` is derived from that age + ONLINE_WINDOW_SECONDS.
 *
 * Anyone who isn't the owner gets a 403 — see requireOwner.
 */
export async function GET() {
  let guard: Awaited<ReturnType<typeof requireOwner>>;
  try {
    guard = await requireOwner();
  } catch (error) {
    // Auth.js itself failed (missing AUTH_SECRET, a bad cookie secret, …).
    // Not a database problem, so it must not be reported as one.
    console.error("GET /api/presence: sign-in check failed:", error);
    return failureResponse("auth", FAILURE_MESSAGE.auth, 500);
  }
  if (guard instanceof NextResponse) return guard;

  try {
    const rows = await withPresenceSchema(() =>
      db
        .select({
          id: users.id,
          name: users.name,
          email: users.email,
          image: users.image,
          activity: userPresence.activity,
          device: userPresence.device,
          // Seconds since the last heartbeat, floored, never negative. `null`
          // means this account has no presence row yet (never opened the app
          // since the feature shipped).
          lastSeenSecondsAgo: sql<
            number | null
          >`case when ${userPresence.lastSeenAt} is null then null else greatest(0, floor(extract(epoch from (now() - ${userPresence.lastSeenAt}))))::int end`,
        })
        .from(users)
        // LEFT join: accounts that never checked in are still worth showing the
        // owner (as "never seen"), so they must survive the join.
        .leftJoin(userPresence, eq(userPresence.userId, users.id))
        .orderBy(sql`${userPresence.lastSeenAt} desc nulls last`, users.createdAt)
        .limit(PRESENCE_LIST_LIMIT)
    );

    const entries: PresenceEntry[] = rows.map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      image: row.image,
      isOwner: isOwnerEmail(row.email),
      online: isOnline(row.lastSeenSecondsAgo),
      lastSeenSecondsAgo: row.lastSeenSecondsAgo,
      activity: row.activity,
      device: row.device,
    }));

    const sorted = sortPresence(entries);

    return NextResponse.json({
      online: sorted.filter((entry) => entry.online).length,
      total: sorted.length,
      windowSeconds: ONLINE_WINDOW_SECONDS,
      users: sorted,
    });
  } catch (error) {
    return presenceFailure("GET", error);
  }
}
