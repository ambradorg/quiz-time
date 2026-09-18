import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { requireUser } from "@/lib/auth-guard";

// A course is a short label ("BS Pharmacy"), not a paragraph.
const MAX_COURSE_LEN = 80;

/**
 * GET /api/profile → { course: string | null }
 *
 * The signed-in user's course, set in the first-login course picker.
 * `null` means "not chosen yet" (or they skipped it).
 */
export async function GET() {
  const guard = await requireUser();
  if (guard instanceof NextResponse) return guard;

  const [row] = await db
    .select()
    .from(users)
    .where(eq(users.id, guard.user.id))
    .limit(1);
  return NextResponse.json({ course: row?.course ?? null });
}

/**
 * PATCH /api/profile  { course: string } | { course: null }
 *
 * Sets (or clears) the user's course. Trims and length-caps the value;
 * an empty string is treated as clearing, so the UI can't strand a
 * user behind a blank course.
 */
export async function PATCH(request: NextRequest) {
  const guard = await requireUser();
  if (guard instanceof NextResponse) return guard;

  let body: { course?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const raw = body.course;
  if (raw !== null && raw !== undefined && raw !== "" && typeof raw !== "string") {
    return NextResponse.json({ error: "course must be a string or null" }, { status: 400 });
  }

  const course =
    raw === null || raw === undefined || raw === "" ? null : (raw as string).trim().slice(0, MAX_COURSE_LEN);

  const [row] = await db
    .update(users)
    .set({ course })
    .where(eq(users.id, guard.user.id))
    .returning();
  return NextResponse.json({ course: row?.course ?? course });
}
