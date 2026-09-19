import { eq } from "drizzle-orm";
import { db } from "@/db";
import { pushSubscriptions } from "@/db/schema";
import { notificationRoute } from "@/lib/notification-api";
import { isRateLimited } from "@/lib/rate-limit";
import { parseSubscription, pushErrorStatus, sendPush } from "@/lib/push-server";
import { REMINDER_TITLE, REVIEW_URL } from "@/lib/notifications";

/**
 * POST /api/notifications/test — send one "you're all set" push to every
 * device this account registered, so opting in ends with visible proof
 * instead of a promise. Dead endpoints (404/410) are pruned on the spot.
 */
export const POST = notificationRoute(async (_request, userId) => {
  if (isRateLimited(`push-test:${userId}`)) {
    return Response.json({ error: "Too many test notifications — try again in a few minutes." }, { status: 429 });
  }
  const devices = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
  if (devices.length === 0) {
    return Response.json({ error: "No devices registered yet — turn notifications on first." }, { status: 409 });
  }

  const payload = {
    title: REMINDER_TITLE,
    body: "Test notification — QuizTime can reach you here. 🎉",
    url: REVIEW_URL,
    tag: "quiztime-test",
  };

  let sent = 0;
  let failed = 0;
  for (const device of devices) {
    const subscription = parseSubscription({ endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } });
    if (!subscription) {
      await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, device.id));
      failed += 1;
      continue;
    }
    try {
      await sendPush(subscription, payload);
      await db.update(pushSubscriptions).set({ lastTestAt: new Date() }).where(eq(pushSubscriptions.id, device.id));
      sent += 1;
    } catch (error) {
      const status = pushErrorStatus(error);
      if (status === 404 || status === 410) {
        await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, device.id));
      }
      failed += 1;
    }
  }
  return { ok: sent > 0, sent, failed, devices: devices.length };
}, true);
