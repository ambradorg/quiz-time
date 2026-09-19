#!/usr/bin/env node
/**
 * Unit tests for the notification rules (src/lib/notifications.ts) and the
 * push guard rails (src/lib/push-server.ts). No database, no network: these
 * are the pure decisions cron and the API routes rely on.
 *
 *   npm run test:notifications
 */
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  CRON_WINDOW_MINUTES,
  REMINDER_TITLE,
  localScheduleParts,
  reminderBody,
  reminderWindow,
  validPushEndpoint,
  validTime,
  validTimeZone,
} from "../src/lib/notifications.ts";
import { parseSubscription, validCronAuthorization } from "../src/lib/push-server.ts";

// ── Input validation ────────────────────────────────────────────────────────
test("reminder times must be HH:MM wall-clock", () => {
  assert.ok(validTime("07:05"));
  assert.ok(validTime("23:59"));
  assert.ok(!validTime("24:00"));
  assert.ok(!validTime("7:05"));
  assert.ok(!validTime("19:05:00"));
  assert.ok(!validTime("nope"));
  assert.ok(!validTime(null));
});

test("time zones must be real IANA zones", () => {
  assert.ok(validTimeZone("Asia/Manila"));
  assert.ok(validTimeZone("UTC"));
  assert.ok(!validTimeZone("UTC+8"));
  assert.ok(!validTimeZone("Not/AZone"));
  assert.ok(!validTimeZone(""));
});

test("push endpoints are restricted to known push services", () => {
  assert.ok(validPushEndpoint("https://fcm.googleapis.com/fcm/send/abc123"));
  assert.ok(validPushEndpoint("https://web.push.apple.com/abc123"));
  assert.ok(validPushEndpoint("https://updates.push.services.mozilla.com/wpush/v1/abc"));
  assert.ok(validPushEndpoint("https://hk1.notify.windows.com/w/abc"));
  // Not push services — an authenticated API must never become an SSRF hose.
  assert.ok(!validPushEndpoint("http://fcm.googleapis.com/fcm/send/abc"));
  assert.ok(!validPushEndpoint("https://127.0.0.1:8443/evil"));
  assert.ok(!validPushEndpoint("https://user:pw@fcm.googleapis.com/fcm/send/abc"));
  assert.ok(!validPushEndpoint("https://fcm.googleapis.com:8443/fcm/send/abc"));
  assert.ok(!validPushEndpoint("https://fcm.googleapis.com/"));
  assert.ok(!validPushEndpoint("not a url"));
});

test("reminder copy pluralises", () => {
  assert.equal(reminderBody(1), "You have 1 card due. Give your memory a quick refresh.");
  assert.equal(reminderBody(12), "You have 12 cards due. Give your memory a quick refresh.");
  assert.ok(REMINDER_TITLE.length > 0);
});

// ── Local-time windowing (the cron decision) ────────────────────────────────
test("localScheduleParts reads the wall clock in the user's zone", () => {
  const now = new Date("2026-09-19T12:34:00Z");
  assert.deepEqual(localScheduleParts("UTC", now), { localDate: "2026-09-19", minutes: 12 * 60 + 34 });
  // Manila is UTC+8: same instant, different day-of-clock.
  assert.deepEqual(localScheduleParts("Asia/Manila", now), { localDate: "2026-09-19", minutes: 20 * 60 + 34 });
  // And west of UTC the date can roll back a day.
  assert.deepEqual(localScheduleParts("America/New_York", new Date("2026-09-19T02:00:00Z")), {
    localDate: "2026-09-18",
    minutes: 22 * 60,
  });
});

test("reminderWindow matches the configured window exactly once per day", () => {
  const at = (hhmm) => {
    const [h, m] = hhmm.split(":").map(Number);
    return new Date(Date.UTC(2026, 8, 19, h, m) - 8 * 3600_000); // Manila wall clock hh:mm
  };
  const pref = { reminderTime: "19:00", timeZone: "Asia/Manila" };
  assert.equal(reminderWindow(pref.reminderTime, pref.timeZone, at("18:59")).inWindow, false);
  assert.equal(reminderWindow(pref.reminderTime, pref.timeZone, at("19:00")).inWindow, true);
  assert.equal(reminderWindow(pref.reminderTime, pref.timeZone, at("19:09")).inWindow, true);
  assert.equal(reminderWindow(pref.reminderTime, pref.timeZone, at("19:10")).inWindow, false);
  assert.equal(reminderWindow(pref.reminderTime, pref.timeZone, at("19:00")).localDate, "2026-09-19");
  assert.equal(CRON_WINDOW_MINUTES, 10); // matches the scheduler cadence (.github/workflows/reminders-cron.yml)
  // Garbage in, null out — cron skips, never throws.
  assert.equal(reminderWindow("nope", "Asia/Manila", at("19:00")), null);
  assert.equal(reminderWindow("19:00", "Not/AZone", at("19:00")), null);
});

// ── Subscription parsing (the SSRF/key guard) ───────────────────────────────
function rawKeys() {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const p256dh = publicKey
    .export({ type: "spki", format: "der" })
    .subarray(-65)
    .toString("base64url");
  const auth = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
  return { p256dh, auth };
}

test("parseSubscription accepts a real P-256 key and rejects the rest", () => {
  const { p256dh, auth } = rawKeys();
  const endpoint = "https://fcm.googleapis.com/fcm/send/abc123";
  assert.ok(parseSubscription({ endpoint, keys: { p256dh, auth } }));
  assert.equal(parseSubscription({ endpoint: "https://evil.example.com/x", keys: { p256dh, auth } }), null);
  assert.equal(parseSubscription({ endpoint, keys: { p256dh: p256dh.slice(0, 80), auth } }), null);
  assert.equal(parseSubscription({ endpoint, keys: { p256dh, auth: "AAAA" } }), null);
  assert.equal(parseSubscription({ endpoint, keys: {} }), null);
  assert.equal(parseSubscription(null), null);
  assert.equal(parseSubscription("nope"), null);
});

test("cron authorization is a constant-time bearer check", () => {
  process.env.CRON_SECRET = "s3cret-value";
  assert.equal(validCronAuthorization("Bearer s3cret-value"), true);
  assert.equal(validCronAuthorization("Bearer wrong"), false);
  assert.equal(validCronAuthorization("s3cret-value"), false);
  assert.equal(validCronAuthorization(null), false);
  delete process.env.CRON_SECRET;
  assert.equal(validCronAuthorization("Bearer s3cret-value"), false);
});
