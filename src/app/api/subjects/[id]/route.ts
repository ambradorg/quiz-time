import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { subjects } from "@/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { requireUser } from "@/lib/auth-guard";

const MAX_NAME_CHARS = 60;

/** Case-insensitive name clash with a DIFFERENT folder of the same user. */
async function findDuplicateName(userId: string, name: string, excludeId: number) {
  const [existing] = await db
    .select({ id: subjects.id })
    .from(subjects)
    .where(
      and(
        eq(subjects.userId, userId),
        sql`lower(${subjects.name}) = lower(${name})`,
        sql`${subjects.id} <> ${excludeId}`
      )
    );
  return existing ?? null;
}

/**
 * Load a subject only if it belongs to the signed-in user — same pattern as
 * the deck editor's `loadOwnedSession`, so a foreign folder is
 * indistinguishable from a missing one.
 */
async function loadOwnedSubject(subjectId: number, userId: string) {
  const [subject] = await db
    .select()
    .from(subjects)
    .where(and(eq(subjects.id, subjectId), eq(subjects.userId, userId)));
  return subject ?? null;
}

/**
 * PATCH /api/subjects/[id] — rename a subject folder. `{ name: "Bio 101" }`.
 * The sets inside follow automatically (they point at the folder, which
 * never moves).
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const guard = await requireUser();
    if (guard instanceof NextResponse) return guard;

    const { id } = await params;
    const subjectId = parseInt(id, 10);
    const subject = Number.isInteger(subjectId) ? await loadOwnedSubject(subjectId, guard.user.id) : null;
    if (!subject) {
      return NextResponse.json({ error: "Subject not found" }, { status: 404 });
    }

    const body = await request.json();
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name) {
      return NextResponse.json({ error: "A subject name is required" }, { status: 400 });
    }

    if (await findDuplicateName(guard.user.id, name, subjectId)) {
      return NextResponse.json(
        { error: "You already have a subject with that name" },
        { status: 409 }
      );
    }

    const [updated] = await db
      .update(subjects)
      .set({ name: name.slice(0, MAX_NAME_CHARS) })
      .where(eq(subjects.id, subjectId))
      .returning();

    return NextResponse.json({ success: true, subject: updated });
  } catch (error) {
    // 23505 = unique_violation: another folder already uses that name.
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
      return NextResponse.json(
        { error: "You already have a subject with that name" },
        { status: 409 }
      );
    }
    console.error("PATCH /api/subjects/[id] error:", error);
    return NextResponse.json({ error: "Failed to rename subject" }, { status: 500 });
  }
}

/**
 * DELETE /api/subjects/[id] — delete a subject folder. The sets inside are
 * NOT deleted: the FK is `ON DELETE SET NULL`, so they simply fall back to
 * "All Sets". The client confirms before calling, and warns about the count.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const guard = await requireUser();
    if (guard instanceof NextResponse) return guard;

    const { id } = await params;
    const subjectId = parseInt(id, 10);
    const subject = Number.isInteger(subjectId) ? await loadOwnedSubject(subjectId, guard.user.id) : null;
    if (!subject) {
      return NextResponse.json({ error: "Subject not found" }, { status: 404 });
    }

    await db.delete(subjects).where(eq(subjects.id, subjectId));

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("DELETE /api/subjects/[id] error:", error);
    return NextResponse.json({ error: "Failed to delete subject" }, { status: 500 });
  }
}
