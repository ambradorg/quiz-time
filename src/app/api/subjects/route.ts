import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { subjects, studySessions } from "@/db/schema";
import { and, asc, eq, sql } from "drizzle-orm";
import { requireUser } from "@/lib/auth-guard";

// Same spirit as the deck limits — folders are metadata, keep them tidy.
const MAX_NAME_CHARS = 60;
const MAX_SUBJECTS = 100;

/**
 * The DB unique index is case-sensitive, but "Biology" vs "biology" reads as
 * a duplicate to a human — reject case-insensitive clashes up front with a
 * friendly 409 instead of letting near-identical folders pile up.
 */
async function findDuplicateName(userId: string, name: string, excludeId?: number) {
  const [existing] = await db
    .select({ id: subjects.id, name: subjects.name })
    .from(subjects)
    .where(
      and(
        eq(subjects.userId, userId),
        sql`lower(${subjects.name}) = lower(${name})`,
        excludeId ? sql`${subjects.id} <> ${excludeId}` : undefined
      )
    );
  return existing ?? null;
}

/**
 * GET /api/subjects — the signed-in user's subject folders with live set
 * counts, oldest first (the order the learner created them in). The count
 * comes from one grouped left join, so a subject that only holds deleted
 * decks correctly reports 0.
 */
export async function GET() {
  try {
    const guard = await requireUser();
    if (guard instanceof NextResponse) return guard;

    const rows = await db
      .select({
        id: subjects.id,
        name: subjects.name,
        createdAt: subjects.createdAt,
        // ::int — pg returns bigint as strings (see GET /api/sessions).
        setCount: sql<number>`count(${studySessions.id})::int`,
      })
      .from(subjects)
      .where(eq(subjects.userId, guard.user.id))
      .leftJoin(studySessions, eq(studySessions.subjectId, subjects.id))
      .groupBy(subjects.id)
      .orderBy(asc(subjects.createdAt));

    return NextResponse.json({ subjects: rows });
  } catch (error) {
    console.error("GET /api/subjects error:", error);
    return NextResponse.json({ error: "Failed to load subjects" }, { status: 500 });
  }
}

/**
 * POST /api/subjects — create a subject folder. `{ name: "Biology" }`.
 * Duplicate names for the same account are rejected with a friendly 409
 * (the unique (user_id, name) index is the arbiter, not a pre-check).
 */
export async function POST(request: NextRequest) {
  try {
    const guard = await requireUser();
    if (guard instanceof NextResponse) return guard;

    const body = await request.json();
    const name = typeof body?.name === "string" ? body.name.trim() : "";

    if (!name) {
      return NextResponse.json({ error: "A subject name is required" }, { status: 400 });
    }

    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(subjects)
      .where(eq(subjects.userId, guard.user.id));

    if (count >= MAX_SUBJECTS) {
      return NextResponse.json(
        { error: `That's a lot of folders — please keep it under ${MAX_SUBJECTS}.` },
        { status: 400 }
      );
    }

    if (await findDuplicateName(guard.user.id, name)) {
      return NextResponse.json(
        { error: "You already have a subject with that name" },
        { status: 409 }
      );
    }

    const [subject] = await db
      .insert(subjects)
      .values({
        userId: guard.user.id,
        name: name.slice(0, MAX_NAME_CHARS),
      })
      .returning();

    return NextResponse.json({ success: true, subject: { ...subject, setCount: 0 } });
  } catch (error) {
    // 23505 = unique_violation: the user already has a subject with this name.
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
      return NextResponse.json(
        { error: "You already have a subject with that name" },
        { status: 409 }
      );
    }
    console.error("POST /api/subjects error:", error);
    return NextResponse.json({ error: "Failed to create subject" }, { status: 500 });
  }
}
