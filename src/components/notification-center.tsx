"use client";

/**
 * The in-app notification center: the bell's inbox (daily "cards due"
 * reminders written by /api/cron/reminders) plus the web-push opt-in —
 * reminder time, test send, and what each device permission means.
 *
 * Lives as an overlay sheet so studying is never interrupted: nothing here
 * opens on its own, and the only navigation is the user tapping a reminder.
 */
import { useEffect, useRef } from "react";
import { BellRing, Brain, CloudOff, Settings2, X } from "lucide-react";
import type { useNotifications } from "@/lib/use-notifications";
import type { NotificationItem } from "@/lib/notifications";

export interface NotificationCenterProps {
  open: boolean;
  onClose: () => void;
  onOpenReview: () => void;
  notifications: ReturnType<typeof useNotifications>;
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const mins = Math.round((Date.now() - then) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function prettyTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const date = new Date();
  date.setHours(h, m, 0, 0);
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export default function NotificationCenter({ open, onClose, onOpenReview, notifications }: NotificationCenterProps) {
  const { inbox, error, busy, blocked, markRead, savePreferences, enablePush, disablePush, sendTest } = notifications;
  const closeRef = useRef<HTMLButtonElement>(null);

  // Sheet behaviour: Escape closes, focus starts on the close button.
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const items: NotificationItem[] = inbox?.notifications ?? [];
  const unread = inbox?.unread ?? 0;
  const prefs = inbox?.preferences;
  const enabled = Boolean(prefs?.enabled);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const openReminder = (id: number) => {
    void markRead([id]);
    onClose();
    onOpenReview();
  };

  return (
    <div className="nc-scrim" onClick={onClose} role="presentation">
      <section
        className="nc-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Notifications"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="nc-head">
          <div>
            <h2 className="nc-title">
              <BellRing size={18} aria-hidden /> Notifications
            </h2>
            <p className="nc-sub">
              {unread > 0 ? `${unread} new update${unread === 1 ? "" : "s"}` : "You're all caught up"}
            </p>
          </div>
          <button ref={closeRef} className="nc-close" onClick={onClose} aria-label="Close notifications">
            <X size={18} />
          </button>
        </header>

        <div className="nc-list">
          {items.length === 0 ? (
            <p className="nc-empty">
              <Brain size={22} aria-hidden />
              Reminders about cards due for review will appear here.
            </p>
          ) : (
            items.map((item) => (
              <button
                key={item.id}
                className={`nc-item${item.readAt ? "" : " nc-unread"}`}
                onClick={() => openReminder(item.id)}
              >
                <span className="nc-item-icon" aria-hidden>
                  <Brain size={16} />
                </span>
                <span className="nc-item-body">
                  <strong>A little review goes a long way</strong>
                  <span>
                    {item.dueCount} card{item.dueCount === 1 ? "" : "s"} due. Give your memory a quick refresh.
                  </span>
                  <em>{relativeTime(item.createdAt)}</em>
                </span>
                {!item.readAt && <span className="nc-dot" aria-label="Unread" />}
              </button>
            ))
          )}
          {unread > 0 && (
            <button className="nc-markall" onClick={() => void markRead("all")} disabled={busy}>
              Mark all as read
            </button>
          )}
        </div>

        <div className="nc-settings">
          <h3 className="nc-settings-title">
            <Settings2 size={15} aria-hidden /> Review reminders, even away from QuizTime
          </h3>

          {blocked === "not-configured" && (
            <p className="nc-note nc-note-warn">
              <CloudOff size={14} aria-hidden /> Push isn’t configured on this server yet — the inbox above still
              works.
            </p>
          )}
          {blocked === "unsupported" && (
            <p className="nc-note nc-note-warn">This browser can’t receive push notifications; the inbox above still works.</p>
          )}
          {blocked === "denied" && (
            <p className="nc-note nc-note-warn">
              Notifications are blocked for this site in your browser settings. Allow them, then flip the switch.
            </p>
          )}
          {error && <p className="nc-note nc-note-warn">{error}</p>}

          <label className="nc-row">
            <span className="nc-row-label">
              <strong>Daily reminder</strong>
              <small>
                {enabled && prefs
                  ? `On — every day at ${prettyTime(prefs.reminderTime)} (${zone})`
                  : "Off — reminders stay inside the app"}
              </small>
            </span>
            <button
              role="switch"
              aria-checked={enabled}
              aria-label="Daily review reminder push notifications"
              className={`nc-switch${enabled ? " on" : ""}`}
              disabled={busy || blocked !== null}
              onClick={() => {
                if (enabled) void disablePush();
                else void enablePush().catch(() => {});
              }}
            >
              <span className="nc-knob" />
            </button>
          </label>

          <label className="nc-row">
            <span className="nc-row-label">
              <strong>Reminder time</strong>
              <small>Your device’s time zone ({zone})</small>
            </span>
            <input
              className="nc-time"
              type="time"
              value={prefs?.reminderTime ?? "19:00"}
              disabled={busy}
              onChange={(event) => {
                const reminderTime = event.target.value;
                if (/^([01]\d|2[0-3]):[0-5]\d$/.test(reminderTime)) {
                  void savePreferences({ reminderTime, timeZone: zone }).catch(() => {});
                }
              }}
            />
          </label>

          <div className="nc-row">
            <span className="nc-row-label">
              <strong>Check it works</strong>
              <small>Sends one test notification to this account’s devices</small>
            </span>
            <button
              className="btn btn-secondary btn-sm"
              disabled={busy || !enabled}
              onClick={() => void sendTest().catch(() => {})}
            >
              Send test
            </button>
          </div>

          <p className="nc-fine">
            One quiet nudge a day, only when cards are due. On iPhone/iPad, add QuizTime to your Home Screen first;
            delivery always follows your device’s own notification settings.
          </p>
        </div>
      </section>
    </div>
  );
}
