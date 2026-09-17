/**
 * Who's online — the presence model behind the owner's roster.
 *
 * The idea is deliberately boring: every signed-in browser sends a tiny
 * heartbeat to `POST /api/presence` every `HEARTBEAT_INTERVAL_MS`, and a user
 * counts as **online** while their last heartbeat is younger than
 * `ONLINE_WINDOW_SECONDS`. Nobody holds a socket open, nothing needs Redis,
 * and an abruptly closed tab drops off the list on its own — which is what you
 * want on serverless hosting.
 *
 *   heartbeat every 30 s  →  considered online for 90 s
 *
 * The 3× gap means two missed beats (a flaky mobile connection, a suspended
 * laptop, a deploy) don't make someone flicker offline.
 *
 * This module is pure and dependency-free on purpose:
 *   - the API route uses the sanitisers + sorting,
 *   - the client hook uses the interval constants + the device label,
 *   - `scripts/presence.test.mjs` unit-tests all of it without a database.
 *
 * It is imported from both server and client code, so it must never touch
 * `process.env`, `pg` or anything else that only exists on one side.
 */

/** How often a signed-in browser checks in. */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/** How long a heartbeat keeps somebody "online" before they drop off. */
export const ONLINE_WINDOW_SECONDS = 90;

/**
 * Never send two heartbeats closer together than this. Tab switches and
 * visibility changes fire a beat early (so activity labels feel live) — this
 * is what stops a user clicking around from hammering the endpoint.
 */
export const MIN_HEARTBEAT_GAP_MS = 5_000;

/** Backstop so a user cannot store a novel in `activity` / `device`. */
export const MAX_ACTIVITY_LENGTH = 60;
export const MAX_DEVICE_LENGTH = 40;

/** Upper bound on the roster payload (the owner's list is never unbounded). */
export const PRESENCE_LIST_LIMIT = 200;

/** One person in the roster, as the API and the UI speak about them. */
export interface PresenceEntry {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
  /** True when this is the owner's own row. */
  isOwner: boolean;
  /** Last heartbeat is inside the online window. */
  online: boolean;
  /**
   * Age of the last heartbeat in seconds, from the *database* clock (`now()`
   * minus the row), so client/server clock skew can never make somebody look
   * online forever. `null` = this account has never checked in.
   */
  lastSeenSecondsAgo: number | null;
  /** What they were looking at ("Studying 'Cell Biology'"), if known. */
  activity: string | null;
  /** Coarse device label ("Chrome · macOS") — never a full user-agent string. */
  device: string | null;
}

/** True while a heartbeat this old still counts as online. */
export function isOnline(
  secondsAgo: number | null | undefined,
  windowSeconds: number = ONLINE_WINDOW_SECONDS
): boolean {
  return typeof secondsAgo === "number" && secondsAgo >= 0 && secondsAgo <= windowSeconds;
}

/**
 * Keep only characters that are safe to render and reason about: no control
 * characters, no newlines/tabs, no runaway length. Non-strings become `null`
 * (the column is nullable), and an empty result means "nothing to show"
 * rather than an empty string in the database.
 */
function cleanText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const stripped = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!stripped) return null;
  return stripped.length > maxLength ? `${stripped.slice(0, maxLength - 1).trimEnd()}…` : stripped;
}

/** Sanitise the client-supplied "what are they doing" label. */
export function sanitizeActivity(value: unknown): string | null {
  return cleanText(value, MAX_ACTIVITY_LENGTH);
}

/** Sanitise the client-supplied device label. */
export function sanitizeDevice(value: unknown): string | null {
  return cleanText(value, MAX_DEVICE_LENGTH);
}

/**
 * Turn a user-agent string into a short, human label — "Chrome · Windows",
 * "Safari · iPhone". Deliberately coarse: the owner needs to tell devices
 * apart, not fingerprint anybody. Returns `null` when the UA is missing or
 * unrecognisable (the client then just omits the device line).
 */
export function describeDevice(userAgent: string | null | undefined): string | null {
  if (typeof userAgent !== "string" || !userAgent.trim()) return null;

  const browser = browserName(userAgent);
  const platform = platformName(userAgent);
  const parts = [browser, platform].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : null;
}

function browserName(ua: string): string | null {
  // Order matters: every Chromium browser also claims Chrome, and Chrome
  // claims Safari.
  if (/\bEdg[A-Za-z]*\//.test(ua)) return "Edge";
  if (/\bOPR\/|\bOpera\b/.test(ua)) return "Opera";
  if (/\bSamsungBrowser\//.test(ua)) return "Samsung Internet";
  if (/\bFirefox\/|\bFxiOS\//.test(ua)) return "Firefox";
  if (/\bCriOS\//.test(ua)) return "Chrome";
  if (/\bChrome\/|\bChromium\//.test(ua)) return "Chrome";
  if (/\bSafari\//.test(ua)) return "Safari";
  return null;
}

function platformName(ua: string): string | null {
  if (/\biPhone\b/.test(ua)) return "iPhone";
  if (/\biPad\b/.test(ua)) return "iPad";
  if (/\bAndroid\b/.test(ua)) return "Android";
  if (/\bCrOS\b/.test(ua)) return "ChromeOS";
  if (/\bWindows\b/.test(ua)) return "Windows";
  if (/\bMac OS X\b|\bMacintosh\b/.test(ua)) return "macOS";
  if (/\bLinux\b/.test(ua)) return "Linux";
  return null;
}

/**
 * Human age of a heartbeat: "just now", "4 min ago", "3 hr ago", "2 days ago".
 * Relative on purpose — the roster only ever needs to answer "how long has it
 * been?", and relative text dodges every timezone question.
 */
export function formatLastSeen(secondsAgo: number | null | undefined): string {
  if (typeof secondsAgo !== "number" || !Number.isFinite(secondsAgo) || secondsAgo < 0) {
    return "never";
  }
  if (secondsAgo < 60) return "just now";
  const minutes = Math.floor(secondsAgo / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return "over a month ago";
}

/**
 * Roster order: online people first (alphabetically, so the list doesn't
 * shuffle between polls), then everybody else by how recently they were seen.
 */
export function sortPresence(entries: PresenceEntry[]): PresenceEntry[] {
  return [...entries].sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    if (a.online && b.online) return displayName(a).localeCompare(displayName(b));
    const aAge = a.lastSeenSecondsAgo ?? Number.POSITIVE_INFINITY;
    const bAge = b.lastSeenSecondsAgo ?? Number.POSITIVE_INFINITY;
    if (aAge !== bAge) return aAge - bAge;
    return displayName(a).localeCompare(displayName(b));
  });
}

/** What to show in the roster: name, else the email's local part, else "Someone". */
export function displayName(entry: Pick<PresenceEntry, "name" | "email">): string {
  const name = entry.name?.trim();
  if (name) return name;
  const email = entry.email?.trim();
  if (email) return email.split("@")[0];
  return "Someone";
}

/** "3 online" / "1 online" / "Nobody online" — the roster headline. */
export function formatOnlineCount(count: number): string {
  if (count <= 0) return "Nobody online";
  return `${count} online`;
}

/** Initials for the avatar fallback ("John Lloyd Ambrad" → "JA"). */
export function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0].charAt(0);
  const last = parts.length > 1 ? parts[parts.length - 1].charAt(0) : "";
  return `${first}${last}`.toUpperCase();
}
