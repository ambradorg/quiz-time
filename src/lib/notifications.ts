/** Shared, side-effect-free notification rules. */
export const REMINDER_TITLE = "A little review goes a long way";
export const REVIEW_URL = "/?tab=review";
export const MAX_PUSH_DEVICES = 10;
export const DEFAULT_REMINDER_TIME = "19:00";

export function reminderBody(count: number) {
  return `You have ${count} card${count === 1 ? "" : "s"} due. Give your memory a quick refresh.`;
}

export function validTime(value: unknown): value is string {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function validTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 80 || /^[+-]/.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch { return false; }
}

/** Closed push-service allowlist: never turn an authenticated API into SSRF. */
export function validPushEndpoint(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" || u.username || u.password || u.port || u.hash || u.pathname === "/") return false;
    return u.hostname === "fcm.googleapis.com" ||
      u.hostname === "web.push.apple.com" ||
      /^([a-z0-9-]+\.)?push\.services\.mozilla\.com$/.test(u.hostname) ||
      /^[a-z0-9-]+\.notify\.windows\.com$/.test(u.hostname);
  } catch { return false; }
}

/**
 * Cron runs every CRON_WINDOW_MINUTES (see vercel.json), so a preference
 * matches when the user's local clock is inside [reminderTime, +window).
 * The per-day inbox row (not this window) is what prevents double sends.
 */
export const CRON_WINDOW_MINUTES = 10;

/** Wall-clock date + minutes-since-midnight in an IANA zone, from one Intl call. */
export function localScheduleParts(timeZone: string, now: Date): { localDate: string; minutes: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value])
  );
  const hour = Number(parts.hour) % 24; // some engines format midnight as "24"
  return {
    localDate: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: hour * 60 + Number(parts.minute),
  };
}

/**
 * Should the cron tick starting at `now` remind this user? Returns null when
 * the stored preference is unusable (bad zone/time — the row is left alone).
 */
export function reminderWindow(
  reminderTime: string,
  timeZone: string,
  now: Date
): { localDate: string; inWindow: boolean } | null {
  if (!validTime(reminderTime) || !validTimeZone(timeZone)) return null;
  try {
    const { localDate, minutes } = localScheduleParts(timeZone, now);
    const [h, m] = reminderTime.split(":").map(Number);
    const target = h * 60 + m;
    return { localDate, inWindow: minutes >= target && minutes < target + CRON_WINDOW_MINUTES };
  } catch {
    return null; // unknown zone at runtime — skip, never throw from cron
  }
}

export interface NotificationItem {
  id: number;
  dueCount: number;
  readAt: string | null;
  createdAt: string;
}
export interface NotificationSettings {
  enabled: boolean;
  reminderTime: string;
  timeZone: string;
}
export interface NotificationInbox {
  notifications: NotificationItem[];
  unread: number;
  preferences: NotificationSettings;
  push: { configured: boolean; publicKey: string | null; deviceCount: number };
}
