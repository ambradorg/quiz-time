import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { notificationPreferences, notifications, pushSubscriptions } from "@/db/schema";
import { NotificationInputError, notificationJson, notificationRoute } from "@/lib/notification-api";
import { pushConfiguration } from "@/lib/push-server";
import {
  DEFAULT_REMINDER_TIME,
  validTime,
  validTimeZone,
  type NotificationInbox,
} from "@/lib/notifications";

const MAX_INBOX = 30;
const MAX_MARK_READ_IDS = 100;

async function readInbox(userId: string): Promise<NotificationInbox> {
  const config = pushConfiguration();
  const [rows, prefs, devices] = await Promise.all([
    db
      .select({
        id: notifications.id,
        dueCount: notifications.dueCount,
        readAt: notifications.readAt,
        createdAt: notifications.createdAt,
      })
      .from(notifications)
      .where(eq(notifications.userId, userId))
      .orderBy(desc(notifications.createdAt))
      .limit(MAX_INBOX),
    db
      .select()
      .from(notificationPreferences)
      .where(eq(notificationPreferences.userId, userId))
      .limit(1),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId)),
  ]);
  const pref = prefs[0];
  return {
    notifications: rows.map((r) => ({
      id: r.id,
      dueCount: r.dueCount,
      readAt: r.readAt ? r.readAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
    })),
    unread: rows.filter((r) => !r.readAt).length,
    preferences: {
      enabled: pref?.enabled ?? false,
      reminderTime: pref?.reminderTime ?? DEFAULT_REMINDER_TIME,
      timeZone: pref?.timeZone ?? "UTC",
    },
    push: {
      configured: config !== null,
      publicKey: config?.publicKey ?? null,
      deviceCount: devices[0]?.count ?? 0,
    },
  };
}

/** GET /api/notifications — inbox, unread count, preferences, push status. */
export const GET = notificationRoute(async (_request, userId) => readInbox(userId));

/**
 * PATCH /api/notifications — change preferences and/or mark items read.
 *
 * Body (all keys optional): { enabled?, reminderTime?, timeZone?,
 * markRead?: "all" | number[] }. Enabling requires at least one registered
 * push device, so the switch can never promise delivery this server can't
 * perform; removing the last device flips `enabled` off server-side.
 */
export const PATCH = notificationRoute(async (request, userId) => {
  const body = await notificationJson(request);
  const patch: Partial<typeof notificationPreferences.$inferInsert> = {};

  if ("enabled" in body) {
    if (typeof body.enabled !== "boolean") throw new NotificationInputError("enabled must be a boolean");
    if (body.enabled) {
      const [devices] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(pushSubscriptions)
        .where(eq(pushSubscriptions.userId, userId));
      if ((devices?.count ?? 0) === 0) {
        return NextResponse.json(
          { error: "Turn on notifications on this device first — there is nothing to deliver to yet." },
          { status: 409 }
        );
      }
    }
    patch.enabled = body.enabled;
  }
  if ("reminderTime" in body) {
    if (!validTime(body.reminderTime)) throw new NotificationInputError("reminderTime must look like HH:MM");
    patch.reminderTime = body.reminderTime;
  }
  if ("timeZone" in body) {
    if (!validTimeZone(body.timeZone)) throw new NotificationInputError("timeZone must be an IANA zone name");
    patch.timeZone = body.timeZone;
  }

  if (Object.keys(patch).length > 0) {
    await db
      .insert(notificationPreferences)
      .values({ userId, ...patch })
      .onConflictDoUpdate({ target: notificationPreferences.userId, set: patch });
  }

  const markRead = body.markRead;
  if (markRead !== undefined) {
    if (markRead === "all") {
      await db
        .update(notifications)
        .set({ readAt: new Date() })
        .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
    } else if (
      Array.isArray(markRead) &&
      markRead.length <= MAX_MARK_READ_IDS &&
      markRead.every((n) => Number.isInteger(n))
    ) {
      if (markRead.length > 0) {
        await db
          .update(notifications)
          .set({ readAt: new Date() })
          .where(
            and(
              eq(notifications.userId, userId),
              inArray(notifications.id, markRead as number[]),
              isNull(notifications.readAt)
            )
          );
      }
    } else {
      throw new NotificationInputError("markRead must be \"all\" or a list of ids");
    }
  }

  return readInbox(userId);
});
