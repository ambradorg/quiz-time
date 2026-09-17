/**
 * Who is the app owner?
 *
 * Exactly one setting decides it:
 *
 *   OWNER_EMAIL=you@example.com
 *
 * The account that signs in with that email is the owner — the one who gets
 * to see everybody else's presence (see src/lib/presence.ts and the roster in
 * GET /api/presence). Everyone else is a normal user with no access to it.
 *
 * Notes
 *   - Comparison is case- and whitespace-insensitive: Google hands us the
 *     address in whatever case the user typed at sign-up, while the env var is
 *     typed by hand on the server.
 *   - Several addresses are allowed (comma/space/semicolon separated) — handy
 *     for a shared admin account or a staging alias. Empty entries are
 *     ignored, so a trailing comma is harmless.
 *   - Unset (or nothing that looks like an email) means *nobody* is the
 *     owner: the feature stays dark rather than falling open.
 *   - Read on every call, never captured at module scope, so the env var can
 *     be changed without a rebuild (same rule as maintenance mode).
 */

export const OWNER_EMAIL_ENV = "OWNER_EMAIL";

/**
 * Split a raw OWNER_EMAIL value into normalised addresses.
 *
 * Emails never contain whitespace, so commas, semicolons *and* whitespace all
 * work as separators. Anything without an "@" is dropped (a typo'd env var
 * must not accidentally match a login).
 */
export function parseOwnerEmails(raw: string | null | undefined): string[] {
  return (raw ?? "")
    .split(/[,\s;]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.includes("@") && entry.length >= 3);
}

/** The configured owner addresses (empty array = feature disabled). */
export function ownerEmails(): string[] {
  return parseOwnerEmails(process.env[OWNER_EMAIL_ENV]);
}

/**
 * Is this email address an owner? `false` when OWNER_EMAIL is unset, when the
 * email is missing, or when it simply isn't on the list.
 */
export function isOwnerEmail(email: string | null | undefined): boolean {
  const owners = ownerEmails();
  if (owners.length === 0) return false;
  const candidate = email?.trim().toLowerCase() ?? "";
  return candidate.length > 0 && owners.includes(candidate);
}
