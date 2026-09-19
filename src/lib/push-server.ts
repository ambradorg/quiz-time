import webpush from "web-push";
import { timingSafeEqual, ECDH } from "node:crypto";
import { validPushEndpoint } from "./notifications";

export function pushConfiguration() {
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  const subject = process.env.VAPID_SUBJECT?.trim();
  if (!publicKey || !privateKey || !subject || !process.env.CRON_SECRET) return null;
  try {
    // Validate without global setVapidDetails state (safe across requests).
    webpush.generateRequestDetails({
      endpoint: "https://fcm.googleapis.com/fcm/send/config-check",
      keys: { p256dh: publicKey, auth: "AAAAAAAAAAAAAAAAAAAAAA" },
    }, undefined, { vapidDetails: { subject, publicKey, privateKey } });
    return { subject, publicKey, privateKey };
  } catch { return null; }
}

export function validCronAuthorization(header: string | null) {
  const secret = process.env.CRON_SECRET;
  if (!secret || !header) return false;
  const actual = Buffer.from(header);
  const expected = Buffer.from(`Bearer ${secret}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function parseSubscription(value: unknown): webpush.PushSubscription | null {
  if (!value || typeof value !== "object") return null;
  const sub = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  const key = sub.keys?.p256dh;
  const auth = sub.keys?.auth;
  if (!validPushEndpoint(sub.endpoint) || typeof key !== "string" || typeof auth !== "string") return null;
  if (!/^[A-Za-z0-9_-]{87}=?$/.test(key) || !/^[A-Za-z0-9_-]{22}={0,2}$/.test(auth)) return null;
  try {
    const bytes = Buffer.from(key, "base64url");
    if (bytes.length !== 65 || bytes[0] !== 4 || Buffer.from(auth, "base64url").length !== 16) return null;
    ECDH.convertKey(bytes, "prime256v1");
    return { endpoint: sub.endpoint, keys: { p256dh: key, auth } };
  } catch { return null; }
}

export async function sendPush(subscription: webpush.PushSubscription, payload: object) {
  const config = pushConfiguration();
  if (!config) throw new Error("Push not configured");
  if (!validPushEndpoint(subscription.endpoint)) throw new Error("Invalid push service");
  return webpush.sendNotification(subscription, JSON.stringify(payload), {
    vapidDetails: config,
    TTL: 60 * 60, // Old study counts should not arrive days later.
    urgency: "normal",
    timeout: 8000,
  });
}

export function pushErrorStatus(error: unknown): number {
  return error && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 0;
}
