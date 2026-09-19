import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { cardReviews, notificationPreferences, notifications, pushDeliveries, pushSubscriptions } from "@/db/schema";
import { validCronAuthorization, parseSubscription, pushErrorStatus, sendPush } from "@/lib/push-server";
import {
  REMINDER_TITLE,
  REVIEW_URL,
  localScheduleParts,
  reminderBody,
  reminderWindow,
} from "@/lib/notifications";

/** Deliveries one cron tick will attempt — keeps runs inside serverless limits. */
const MAX_SENDS_PER_RUN = 20;
/** A leased delivery nobody may touch again for this long (ms). */
const LEASE_MS = 90_000;
/** Backoff between attempts: 5 min, then 10 min, then give up. */
const RETRY_MS = 5 * 60_000;
const MAX_ATTEMPTS = 3;

/**
 * GET|POST /api/cron/reminders — the daily "your cards are due" nudge.
 *
 * Protected by `Authorization: Bearer $CRON_SECRET` (Vercel Cron sends it
 * automatically; see vercel.json for the schedule). One run:
 *
 *   1. finds everybody with due cards,
 *   2. writes one inbox row per user per *local* day (the unique
 *      (user, date) key is what makes reruns and overlapping cron ticks
 *      harmless — a day reminds exactly once),
 *   3. queues a push delivery per opted-in device,
 *   4. drains the delivery queue with leases + bounded retries, pruning
 *      endpoints the push service reports as gone (404/410).
 *
 * Users who never touched notification settings still get the inbox row
 * (first tick of the UTC day with due cards); push only ever goes to
 * accounts that explicitly opted in.
 */
async function runReminders(request: NextRequest) {
  if (!validCronAuthorization(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const utcDate = localScheduleParts("UTC", now).localDate;
  const pushReady = Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT);

  // 1 ── Who has work waiting? One grouped query over the schedule table.
  const dueRows = await db
    .select({
      userId: cardReviews.userId,
      dueCount: sql<number>`count(*)::int`,
    })
    .from(cardReviews)
    .where(lte(cardReviews.dueAt, now))
    .groupBy(cardReviews.userId);

  // 2 ── Preferences decide *when* (and whether) to push.
  const prefRows = await db.select().from(notificationPreferences);
  const prefs = new Map(prefRows.map((p) => [p.userId, p]));

  let reminded = 0;
  let queued = 0;
  for (const row of dueRows) {
    if (!row.userId || row.dueCount <= 0) continue;
    const pref = prefs.get(row.userId);
    const window = pref
      ? reminderWindow(pref.reminderTime, pref.timeZone, now)
      : { localDate: utcDate, inWindow: true };
    if (!window?.inWindow) continue;

    // One row per (user, local day): the conflict guard IS the dedupe.
    const [created] = await db
      .insert(notifications)
      .values({ userId: row.userId, localDate: window.localDate, dueCount: row.dueCount })
      .onConflictDoNothing({ target: [notifications.userId, notifications.localDate] })
      .returning({ id: notifications.id });
    if (!created) continue; // already reminded today
    reminded += 1;

    if (!pushReady || !pref?.enabled) continue;
    const devices = await db
      .select({ id: pushSubscriptions.id })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, row.userId));
    if (devices.length === 0) continue;
    await db
      .insert(pushDeliveries)
      .values(devices.map((d) => ({ notificationId: created.id, subscriptionId: d.id })))
      .onConflictDoNothing();
    queued += devices.length;
  }

  // 3 ── Drain the queue (this run's fresh deliveries plus older retries).
  // A fresh clock: deliveries queued milliseconds ago have nextAttemptAt =
  // their insert time, which is *after* the run's start timestamp.
  const sent = await drainDeliveries(new Date(), pushReady);

  return NextResponse.json({
    ok: true,
    at: now.toISOString(),
    checked: dueRows.length,
    reminded,
    queued,
    sent: sent.sent,
    pruned: sent.pruned,
    deferred: sent.deferred,
  });
}

/**
 * Lease → send → settle, one delivery at a time. The lease update is the
 * concurrency guard: two overlapping cron runs can't both win the same row,
 * and a run that dies mid-send leaves an expired lease behind, not a lock.
 */
async function drainDeliveries(now: Date, pushReady: boolean) {
  const result = { sent: 0, pruned: 0, deferred: 0 };
  if (!pushReady) return result;

  const queue = await db
    .select({
      deliveryId: pushDeliveries.id,
      attempts: pushDeliveries.attempts,
      endpoint: pushSubscriptions.endpoint,
      p256dh: pushSubscriptions.p256dh,
      auth: pushSubscriptions.auth,
      subscriptionId: pushSubscriptions.id,
      notificationId: notifications.id,
      localDate: notifications.localDate,
      dueCount: notifications.dueCount,
    })
    .from(pushDeliveries)
    .innerJoin(pushSubscriptions, eq(pushSubscriptions.id, pushDeliveries.subscriptionId))
    .innerJoin(notifications, eq(notifications.id, pushDeliveries.notificationId))
    .where(
      and(
        inArray(pushDeliveries.status, ["pending", "failed"]),
        lte(pushDeliveries.nextAttemptAt, now),
        or(isNull(pushDeliveries.leaseUntil), lt(pushDeliveries.leaseUntil, now))
      )
    )
    .orderBy(pushDeliveries.id)
    .limit(MAX_SENDS_PER_RUN);

  for (const item of queue) {
    const [lease] = await db
      .update(pushDeliveries)
      .set({ leaseUntil: new Date(now.getTime() + LEASE_MS), attempts: item.attempts + 1 })
      .where(
        and(
          eq(pushDeliveries.id, item.deliveryId),
          or(isNull(pushDeliveries.leaseUntil), lt(pushDeliveries.leaseUntil, now))
        )
      )
      .returning({ id: pushDeliveries.id, attempts: pushDeliveries.attempts });
    if (!lease) continue; // another run got there first

    const subscription = parseSubscription({
      endpoint: item.endpoint,
      keys: { p256dh: item.p256dh, auth: item.auth },
    });
    if (!subscription) {
      await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, item.subscriptionId));
      await db.update(pushDeliveries).set({ status: "gone", leaseUntil: null }).where(eq(pushDeliveries.id, item.deliveryId));
      result.pruned += 1;
      continue;
    }

    try {
      await sendPush(subscription, {
        title: REMINDER_TITLE,
        body: reminderBody(item.dueCount),
        url: REVIEW_URL,
        tag: `quiztime-review-${item.localDate}`,
        notificationId: item.notificationId,
      });
      await db
        .update(pushDeliveries)
        .set({ status: "sent", sentAt: new Date(), leaseUntil: null })
        .where(eq(pushDeliveries.id, item.deliveryId));
      result.sent += 1;
    } catch (error) {
      const status = pushErrorStatus(error);
      if (status === 404 || status === 410) {
        // The browser threw the subscription away (site data cleared,
        // permission revoked long ago): nothing will ever deliver again.
        await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, item.subscriptionId));
        await db.update(pushDeliveries).set({ status: "gone", leaseUntil: null }).where(eq(pushDeliveries.id, item.deliveryId));
        result.pruned += 1;
        continue;
      }
      const attempts = lease.attempts;
      await db
        .update(pushDeliveries)
        .set({
          status: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
          nextAttemptAt: new Date(now.getTime() + RETRY_MS * attempts),
          leaseUntil: null,
        })
        .where(eq(pushDeliveries.id, item.deliveryId));
      result.deferred += 1;
    }
  }
  return result;
}

export const GET = runReminders;
export const POST = runReminders;
