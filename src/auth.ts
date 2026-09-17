import NextAuth, { type NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users, type User } from "@/db/schema";
import { isOwnerEmail } from "@/lib/owner";

/**
 * Auth.js (v5) — Google OAuth with JWT sessions.
 *
 * JWT (not database) sessions keep every request stateless, which suits
 * serverless hosting. On first sign-in we upsert the profile into our
 * own `users` table and pin the user id into the token, so API routes
 * can scope every query to the signed-in user.
 *
 * Self-healing re-key: Google can hand us a *new* `sub` for an email we
 * already have on file (workspace migrations, restored accounts, …). The
 * plain upsert then trips `users_email_unique` (Postgres 23505) and the
 * user lands on the Configuration error page. Instead we catch that, find
 * the existing row by email and UPDATE its `id` to the new `sub` — the
 * user FKs are `ON UPDATE CASCADE`, so that single statement moves every
 * deck and study result to the new id, and login succeeds.
 */

/**
 * Postgres SQLSTATE 23505 = unique-constraint violation. drizzle wraps the
 * pg error in a DrizzleQueryError with the original on `.cause`, so walk
 * the cause chain rather than only looking at the top-level error.
 */
const isUniqueViolation = (err: unknown): boolean => {
  let current: unknown = err;
  while (current && typeof current === "object") {
    if ((current as { code?: unknown }).code === "23505") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
};

/**
 * Recovery path for the 23505 above: the email already belongs to a user
 * row with a different provider id. Re-key that row to the incoming id and
 * refresh the profile fields; returns the updated row (or `undefined` if no
 * row matched the email, meaning the conflict came from somewhere else and
 * the caller should rethrow).
 */
async function rekeyUserByEmail(next: {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  provider: string;
}): Promise<User | undefined> {
  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.email, next.email))
    .limit(1);
  if (!existing || existing.id === next.id) return undefined;

  // ON UPDATE cascade on study_sessions.user_id and study_results.user_id
  // moves the user's decks and history along with the id.
  const [moved] = await db
    .update(users)
    .set({
      id: next.id,
      name: next.name,
      image: next.image,
      provider: next.provider,
    })
    .where(eq(users.id, existing.id))
    .returning();
  return moved;
}

export const authConfig = {
  providers: [
    Google({
      clientId: process.env.AUTH_GOOGLE_ID ?? "",
      clientSecret: process.env.AUTH_GOOGLE_SECRET ?? "",
    }),
  ],
  session: { strategy: "jwt" },
  // The app runs behind proxies (Vercel, preview tunnels, local e2e), where
  // the Host header doesn't match a configured AUTH_URL. Without this,
  // Auth.js v5 throws UntrustedHost and every auth() call — and therefore
  // every signed-in API route — fails with 401/500.
  trustHost: true,
  pages: {
    signIn: "/login",
  },
  callbacks: {
    async jwt({ token, user }) {
      // `user` is only present on the first callback right after sign-in.
      // (In Auth.js v5 types, `id` is optional — Google always provides it.)
      if (user && user.id) {
        // `provider` lives on the AdapterUser half of the union.
        const provider = (user as { provider?: string }).provider ?? "google";
        // Google always sends an email for accounts it lets you sign in
        // with, but fall back to a synthetic one so the NOT NULL column
        // never breaks a login.
        const email = user.email ?? `${user.id}@${provider}.local`;
        let row: User | undefined;
        try {
          [row] = await db
            .insert(users)
            .values({
              id: user.id,
              email,
              name: user.name ?? null,
              image: user.image ?? null,
              provider,
            })
            .onConflictDoUpdate({
              target: users.id,
              set: {
                email,
                name: user.name ?? null,
                image: user.image ?? null,
              },
            })
            .returning();
        } catch (err) {
          if (!isUniqueViolation(err)) throw err;
          // Same email, new Google `sub` — re-key the existing account so
          // the user keeps their decks instead of hitting the error page.
          row = await rekeyUserByEmail({
            id: user.id,
            email,
            name: user.name ?? null,
            image: user.image ?? null,
            provider,
          });
          // The conflict wasn't a stale user row after all — surface it.
          if (!row) throw err;
        }
        if (row) token.userId = row.id;
      }
      return token;
    },
    session({ session, token }) {
      if (session.user && token.userId) {
        session.user.id = token.userId;
      }
      // Owner flag for the UI (the "who's online" roster only renders for the
      // owner). It is computed from the signed-in email + OWNER_EMAIL on every
      // session read — never stored in the JWT, so changing the env var takes
      // effect on the next request instead of at the next sign-in. This is a
      // convenience flag only: /api/presence re-checks it server-side.
      if (session.user) {
        session.user.isOwner = isOwnerEmail(session.user.email);
      }
      return session;
    },
  },
} satisfies NextAuthConfig;

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);

// ── Type augmentation ───────────────────────────────────────────────────────
declare module "next-auth" {
  interface Session {
    user: {
      id?: string;
      name?: string | null;
      email?: string | null;
      image?: string | null;
      /** Signed in with the address in OWNER_EMAIL — see src/lib/owner.ts. */
      isOwner?: boolean;
    };
  }
}

declare module "@auth/core/jwt" {
  interface JWT {
    userId?: string;
  }
}
