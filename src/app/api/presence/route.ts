import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { userPresence, users } from "@/db/schema";
import { requireOwner, requireUser } from "@/lib/auth-guard";
import { isOwnerEmail } from "@/lib/owner";
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
  try {
    const guard = await requireUser();
    if (guard instanceof NextResponse) return guard;

    // The body is optional: a bare beat still means "I'm here".
    const body = (await request.json().catch(() => null)) as
      | { activity?: unknown; device?: unknown }
      | null;

    await db
      .insert(userPresence)
      .values({
        userId: guard.user.id,
        activity: sanitizeActivity(body?.activity),
        device: sanitizeDevice(body?.device),
      })
      .onConflictDoUpdate({
        target: userPresence.userId,
        set: {
          // now() (not the app's clock) so the online window is measured
          // entirely inside Postgres — clock skew can never stretch it.
          lastSeenAt: sql`now()`,
          activity: sanitizeActivity(body?.activity),
          device: sanitizeDevice(body?.device),
        },
      });

    return NextResponse.json({
      ok: true,
      online: isOwnerEmail(guard.user.email) ? await countOnline() : null,
    });
  } catch (error) {
    console.error("POST /api/presence error:", error);
    return NextResponse.json({ error: "Failed to record presence" }, { status: 500 });
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
  try {
    const guard = await requireOwner();
    if (guard instanceof NextResponse) return guard;

    const rows = await db
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
      .limit(PRESENCE_LIST_LIMIT);

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
    console.error("GET /api/presence error:", error);
    return NextResponse.json({ error: "Failed to load who's online" }, { status: 500 });
  }
}
