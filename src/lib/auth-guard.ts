import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isOwnerEmail } from "@/lib/owner";

export interface AuthedUser {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
}

export type RequireUserResult =
  | { user: AuthedUser }
  | NextResponse;

/**
 * Guard for API routes: resolves to the signed-in user, or a ready-made
 * 401 response when the request is anonymous.
 *
 *   const guard = await requireUser();
 *   if (guard instanceof NextResponse) return guard;
 *   const user = guard.user;
 */
export async function requireUser(): Promise<RequireUserResult> {
  const session = await auth();
  if (session?.user?.id) {
    return {
      user: {
        id: session.user.id,
        name: session.user.name ?? null,
        email: session.user.email ?? null,
        image: session.user.image ?? null,
      },
    };
  }
  return NextResponse.json(
    { error: "Please sign in to continue" },
    { status: 401 }
  );
}

/**
 * Guard for owner-only routes (the "who's online" roster).
 *
 * The check is the *signed-in session's email* against OWNER_EMAIL — never a
 * client-supplied header or query parameter, so nobody can promote themselves
 * by guessing a URL. Anonymous callers get the usual 401; signed-in
 * non-owners get a 403 that doesn't disclose who the owner is.
 *
 *   const guard = await requireOwner();
 *   if (guard instanceof NextResponse) return guard;
 *   const user = guard.user;
 */
export async function requireOwner(): Promise<RequireUserResult> {
  const guard = await requireUser();
  if (guard instanceof NextResponse) return guard;
  if (!isOwnerEmail(guard.user.email)) {
    return NextResponse.json(
      { error: "Only the app owner can see who's online" },
      { status: 403 }
    );
  }
  return guard;
}
