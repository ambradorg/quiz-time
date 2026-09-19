import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { notificationPreferences, pushSubscriptions } from "@/db/schema";
import { NotificationInputError, notificationJson, notificationRoute } from "@/lib/notification-api";
import { parseSubscription } from "@/lib/push-server";
import { MAX_PUSH_DEVICES } from "@/lib/notifications";

/**
 * POST /api/notifications/subscribe — register this browser for push.
 *
 * Body: { subscription: { endpoint, keys: { p256dh, auth } } } straight from
 * PushSubscription.toJSON(). The endpoint is unique globally: a device that
 * signs in with a different account moves to the new owner instead of
 * double-registering. Devices beyond MAX_PUSH_DEVICES drop oldest-first so
 * the newest phone always works.
 */
export const POST = notificationRoute(async (request, userId) => {
  const body = await notificationJson(request);
  const subscription = parseSubscription(body.subscription);
  if (!subscription) throw new NotificationInputError("That push subscription doesn't look valid");

  const existing = await db
    .select({ id: pushSubscriptions.id, userId: pushSubscriptions.userId })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.endpoint, subscription.endpoint))
    .limit(1);

  if (existing.length === 1) {
    await db
      .update(pushSubscriptions)
      .set({ userId, p256dh: subscription.keys.p256dh, auth: subscription.keys.auth })
      .where(eq(pushSubscriptions.id, existing[0].id));
  } else {
    await db.insert(pushSubscriptions).values({
      userId,
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
    });
  }

  // Other accounts that still list this endpoint would push to a device that
  // now belongs to this user — drop their stale row.
  await db
    .delete(pushSubscriptions)
    .where(andEndpointOtherUser(subscription.endpoint, userId));

  // Keep the device list bounded: oldest subscriptions fall off first.
  const devices = await db
    .select({ id: pushSubscriptions.id })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId))
    .orderBy(asc(pushSubscriptions.createdAt), asc(pushSubscriptions.id));
  const excess = devices.length - MAX_PUSH_DEVICES;
  if (excess > 0) {
    await db
      .delete(pushSubscriptions)
      .where(
        inIds(devices.slice(0, excess).map((d) => d.id))
      );
  }

  const [count] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId));
  return { ok: true, deviceCount: count?.count ?? 0 };
}, true);

/**
 * DELETE /api/notifications/subscribe — forget this browser.
 *
 * Body: { endpoint }. Losing the last device turns the account's reminder
 * switch off server-side, so a silent account never looks "on".
 */
export const DELETE = notificationRoute(async (request, userId) => {
  const body = await notificationJson(request);
  const endpoint = body.endpoint;
  if (typeof endpoint !== "string" || !endpoint.startsWith("https://")) {
    throw new NotificationInputError("endpoint must be an https URL");
  }
  await db
    .delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint)));

  const devices = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId));
  if ((devices[0]?.count ?? 0) === 0) {
    await db
      .update(notificationPreferences)
      .set({ enabled: false })
      .where(eq(notificationPreferences.userId, userId));
  }
  return { ok: true, deviceCount: devices[0]?.count ?? 0 };
}, true);

// Small helpers keep the handlers above readable.
function andEndpointOtherUser(endpoint: string, userId: string) {
  return and(eq(pushSubscriptions.endpoint, endpoint), ne(pushSubscriptions.userId, userId));
}
function inIds(ids: number[]) {
  return inArray(pushSubscriptions.id, ids);
}
