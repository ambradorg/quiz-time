#!/usr/bin/env node
/**
 * Tests for the "who's online" presence model (src/lib/presence.ts) and the
 * owner-email rules (src/lib/owner.ts) — no database, no network, no server.
 *
 * The cases encode the product promises behind the owner's roster:
 *
 *   - OWNER_EMAIL decides who is the owner: exact address, case/whitespace
 *     insensitive, a list is allowed, a typo or an empty value means *nobody*
 *     (the feature fails closed),
 *   - a heartbeat keeps somebody online for the window (90 s) and no longer,
 *   - what the client sends is only ever a *label*: control characters, tabs
 *     and runaway length are stripped before it reaches the database,
 *   - the roster sorts the way it reads: online first, then most recent,
 *   - user agents turn into a two-part label, never a raw UA string.
 *
 * Usage:
 *   npm run test:presence
 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";

const {
  MAX_ACTIVITY_LENGTH,
  MAX_DEVICE_LENGTH,
  ONLINE_WINDOW_SECONDS,
  describeDevice,
  displayName,
  formatLastSeen,
  formatOnlineCount,
  initialsFor,
  isOnline,
  sanitizeActivity,
  sanitizeDevice,
  sortPresence,
} = await import("../src/lib/presence.ts");

const { isOwnerEmail, ownerEmails, parseOwnerEmails, OWNER_EMAIL_ENV } = await import(
  "../src/lib/owner.ts"
);

/** Build a roster entry with sensible defaults for the assertions below. */
const entry = (over) => ({
  id: over.id ?? over.name ?? "id",
  name: over.name ?? null,
  email: over.email ?? null,
  image: over.image ?? null,
  isOwner: over.isOwner ?? false,
  online: over.online ?? isOnline(over.lastSeenSecondsAgo ?? null),
  lastSeenSecondsAgo: over.lastSeenSecondsAgo ?? null,
  activity: over.activity ?? null,
  device: over.device ?? null,
  ...over,
});

describe("presence: owner email", () => {
  test("a single address is parsed and normalised", () => {
    assert.deepEqual(parseOwnerEmails("  Boss@Example.COM "), ["boss@example.com"]);
  });

  test("a list may be comma-, semicolon- or space-separated", () => {
    assert.deepEqual(parseOwnerEmails("a@b.com, c@d.com"), ["a@b.com", "c@d.com"]);
    assert.deepEqual(parseOwnerEmails("a@b.com;c@d.com"), ["a@b.com", "c@d.com"]);
    assert.deepEqual(parseOwnerEmails("a@b.com  c@d.com"), ["a@b.com", "c@d.com"]);
    // Trailing separators are harmless (they are how people edit env vars).
    assert.deepEqual(parseOwnerEmails("a@b.com,"), ["a@b.com"]);
  });

  test("entries that aren't addresses are ignored", () => {
    assert.deepEqual(parseOwnerEmails("boss@example.com,not-an-email"), ["boss@example.com"]);
    assert.deepEqual(parseOwnerEmails("nope"), []);
    assert.deepEqual(parseOwnerEmails(""), []);
    assert.deepEqual(parseOwnerEmails(undefined), []);
  });

  test("isOwnerEmail() compares the signed-in email with the configured owner", () => {
    const previous = process.env[OWNER_EMAIL_ENV];
    try {
      process.env[OWNER_EMAIL_ENV] = "Owner@Example.com";
      assert.equal(isOwnerEmail("owner@example.com"), true);
      assert.equal(isOwnerEmail("  OWNER@EXAMPLE.COM  "), true);
      assert.equal(isOwnerEmail("someone@example.com"), false);
      assert.equal(isOwnerEmail(null), false);
      assert.equal(isOwnerEmail(undefined), false);
      // No "ends with", no local-part-only matches.
      assert.equal(isOwnerEmail("owner@example.com.evil"), false);
      assert.equal(isOwnerEmail("evil+owner@example.com"), false);
      assert.equal(isOwnerEmail("owner@sub.example.com"), false);
    } finally {
      if (previous === undefined) delete process.env[OWNER_EMAIL_ENV];
      else process.env[OWNER_EMAIL_ENV] = previous;
    }
  });

  test("an unset or unusable OWNER_EMAIL makes nobody the owner (fails closed)", () => {
    const previous = process.env[OWNER_EMAIL_ENV];
    try {
      delete process.env[OWNER_EMAIL_ENV];
      assert.deepEqual(ownerEmails(), []);
      assert.equal(isOwnerEmail("anyone@example.com"), false);

      process.env[OWNER_EMAIL_ENV] = "   ";
      assert.equal(isOwnerEmail("anyone@example.com"), false);

      process.env[OWNER_EMAIL_ENV] = "typo-without-at-sign";
      assert.equal(isOwnerEmail("typo-without-at-sign"), false);
    } finally {
      if (previous === undefined) delete process.env[OWNER_EMAIL_ENV];
      else process.env[OWNER_EMAIL_ENV] = previous;
    }
  });
});

describe("presence: online window", () => {
  test("inside the window counts as online, outside it doesn't", () => {
    assert.equal(isOnline(0), true);
    assert.equal(isOnline(ONLINE_WINDOW_SECONDS), true);
    assert.equal(isOnline(ONLINE_WINDOW_SECONDS + 1), false);
    assert.equal(isOnline(60 * 60), false);
  });

  test("never-seen and nonsense ages are not online", () => {
    assert.equal(isOnline(null), false);
    assert.equal(isOnline(undefined), false);
    assert.equal(isOnline(-5), false);
    assert.equal(isOnline(Number.NaN), false);
  });

  test("a heartbeat every 30 s survives one and even two missed beats", () => {
    // Three heartbeats fit inside the window: 3 × 30 s ≤ 90 s means a flaky
    // connection (one missed beat) never flickers the user offline.
    assert.ok(3 * 30 <= ONLINE_WINDOW_SECONDS);
    assert.equal(isOnline(30), true);
    assert.equal(isOnline(60), true);
    assert.equal(isOnline(30 * 3), true);
  });
});

describe("presence: sanitising what the client sends", () => {
  test("activity labels are trimmed and collapsed", () => {
    assert.equal(sanitizeActivity("  Studying  “Cell   Biology” "), "Studying “Cell Biology”");
    assert.equal(sanitizeActivity("line one\nline two"), "line one line two");
    assert.equal(sanitizeActivity("tab\there"), "tab here");
    assert.equal(sanitizeActivity(""), null);
    assert.equal(sanitizeActivity("   "), null);
    assert.equal(sanitizeActivity(null), null);
    assert.equal(sanitizeActivity(undefined), null);
    assert.equal(sanitizeActivity({ evil: true }), null);
    assert.equal(sanitizeActivity(42), null);
  });

  test("control characters never reach the database", () => {
    const nasty = `Studying\u0000\u0007\u001b[31mred`;
    const cleaned = sanitizeActivity(nasty);
    assert.ok(cleaned);
    assert.doesNotMatch(cleaned, /[\u0000-\u001f\u007f]/);
    assert.match(cleaned, /Studying/);
  });

  test("labels are capped — the roster row stays one line", () => {
    const long = "x".repeat(500);
    const activity = sanitizeActivity(long);
    const device = sanitizeDevice(long);
    assert.ok(activity.length <= MAX_ACTIVITY_LENGTH);
    assert.ok(device.length <= MAX_DEVICE_LENGTH);
    assert.ok(activity.endsWith("…"));
  });
});

describe("presence: device labels", () => {
  const UA = {
    chromeMac:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    safariIphone:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    chromeAndroid:
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
    firefoxWindows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0",
    edgeWindows:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
  };

  test("browsers and platforms are recognised", () => {
    assert.equal(describeDevice(UA.chromeMac), "Chrome · macOS");
    assert.equal(describeDevice(UA.safariIphone), "Safari · iPhone");
    assert.equal(describeDevice(UA.chromeAndroid), "Chrome · Android");
    assert.equal(describeDevice(UA.firefoxWindows), "Firefox · Windows");
    // Chromium browsers must not be reported as Chrome/Safari.
    assert.equal(describeDevice(UA.edgeWindows), "Edge · Windows");
  });

  test("unknown or missing user agents yield nothing rather than junk", () => {
    assert.equal(describeDevice(null), null);
    assert.equal(describeDevice(undefined), null);
    assert.equal(describeDevice(""), null);
    assert.equal(describeDevice("   "), null);
    assert.equal(describeDevice("curl/8.5.0"), null);
  });
});

describe("presence: how the roster reads", () => {
  test("ages become short, human labels", () => {
    assert.equal(formatLastSeen(0), "just now");
    assert.equal(formatLastSeen(59), "just now");
    assert.equal(formatLastSeen(60), "1 min ago");
    assert.equal(formatLastSeen(60 * 5 + 12), "5 min ago");
    assert.equal(formatLastSeen(60 * 60 * 3), "3 hr ago");
    assert.equal(formatLastSeen(60 * 60 * 24), "yesterday");
    assert.equal(formatLastSeen(60 * 60 * 24 * 4), "4 days ago");
    assert.equal(formatLastSeen(60 * 60 * 24 * 400), "over a month ago");
  });

  test("never-seen users say so", () => {
    assert.equal(formatLastSeen(null), "never");
    assert.equal(formatLastSeen(undefined), "never");
    assert.equal(formatLastSeen(Number.NaN), "never");
  });

  test("the count headline reads naturally", () => {
    assert.equal(formatOnlineCount(0), "Nobody online");
    assert.equal(formatOnlineCount(1), "1 online");
    assert.equal(formatOnlineCount(7), "7 online");
  });

  test("names fall back to the email, then to a neutral label", () => {
    assert.equal(displayName({ name: "Ada Lovelace", email: "ada@x.com" }), "Ada Lovelace");
    assert.equal(displayName({ name: "   ", email: "ada@x.com" }), "ada");
    assert.equal(displayName({ name: null, email: null }), "Someone");
    assert.equal(initialsFor("John Lloyd Ambrad"), "JA");
    assert.equal(initialsFor("Ada"), "A");
    assert.equal(initialsFor("   "), "?");
  });

  test("online people come first, inside that by name, then by recency", () => {
    const sorted = sortPresence([
      entry({ name: "Old", lastSeenSecondsAgo: 60 * 60 * 24 }),
      entry({ name: "Zoe", lastSeenSecondsAgo: 10, online: true }),
      entry({ name: "Never", lastSeenSecondsAgo: null }),
      entry({ name: "Ada", lastSeenSecondsAgo: 20, online: true }),
      entry({ name: "Recent", lastSeenSecondsAgo: 60 * 3 }),
    ]);

    assert.deepEqual(
      sorted.map((e) => e.name),
      ["Ada", "Zoe", "Recent", "Old", "Never"]
    );
  });

  test("sorting never mutates the caller's array", () => {
    const original = [entry({ name: "A", lastSeenSecondsAgo: 500 }), entry({ name: "B", lastSeenSecondsAgo: 1 })];
    const before = original.map((e) => e.name);
    sortPresence(original);
    assert.deepEqual(original.map((e) => e.name), before);
  });
});
