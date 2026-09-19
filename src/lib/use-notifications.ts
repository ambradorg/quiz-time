"use client";

/**
 * React bindings for the notification center + web push opt-in.
 *
 * Best-effort by design (same spirit as use-presence): a failed poll keeps
 * the last good inbox on screen, and every push action reports a plain
 * Error message the panel can show verbatim — notifications must never
 * break studying.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { NotificationInbox } from "./notifications";

const API = "/api/notifications";
/** How often an open app refreshes the inbox while signed in. */
export const INBOX_POLL_INTERVAL_MS = 60_000;

export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

async function call(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetch(path, {
    cache: "no-store",
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    ...init,
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : `Request failed (${res.status})`);
  return data;
}

export type PushBlockReason = "unsupported" | "denied" | "not-configured" | null;

export function useNotifications({ enabled }: { enabled: boolean }) {
  const [inbox, setInbox] = useState<NotificationInbox | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const aliveRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const data = (await call(API)) as unknown as NotificationInbox;
      if (aliveRef.current) {
        setInbox(data);
        setError(null);
      }
    } catch {
      /* keep the last good inbox — the bell just stays as it was */
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    // Subscribe-on-mount: the state update happens in the fetch callback,
    // which is exactly what effects are for — the rule just can't see that.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, INBOX_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [enabled, refresh]);

  const markRead = useCallback(
    async (markRead: "all" | number[]) => {
      setBusy(true);
      try {
        const data = (await call(API, { method: "PATCH", body: JSON.stringify({ markRead }) })) as unknown as NotificationInbox;
        setInbox(data);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't update notifications");
      } finally {
        setBusy(false);
      }
    },
    []
  );

  const savePreferences = useCallback(async (patch: { enabled?: boolean; reminderTime?: string; timeZone?: string }) => {
    setBusy(true);
    try {
      const data = (await call(API, { method: "PATCH", body: JSON.stringify(patch) })) as unknown as NotificationInbox;
      setInbox(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save notification settings");
      throw err;
    } finally {
      setBusy(false);
    }
  }, []);

  /**
   * The whole opt-in, in order: permission → subscription → server row →
   * account switch. Each step's failure message is user-actionable.
   */
  const enablePush = useCallback(async () => {
    setBusy(true);
    try {
      if (!pushSupported()) throw new Error("This browser can't show notifications.");
      const current = (inbox as NotificationInbox | null)?.push;
      const publicKey = current?.publicKey ?? ((await call(API)) as unknown as NotificationInbox).push.publicKey;
      if (!publicKey) throw new Error("Push isn't configured on the server yet (VAPID keys missing).");

      if (Notification.permission === "denied") {
        throw new Error("Notifications are blocked in your browser settings — allow them for this site first.");
      }
      if (Notification.permission === "default") {
        const permission = await Notification.requestPermission();
        if (permission !== "granted") throw new Error("Permission not granted — nothing was turned on.");
      }

      const registration = await navigator.serviceWorker.ready;
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        });
      }
      await call(`${API}/subscribe`, { method: "POST", body: JSON.stringify({ subscription: subscription.toJSON() }) });
      await savePreferences({ enabled: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't turn notifications on");
    } finally {
      setBusy(false);
    }
  }, [inbox, savePreferences]);

  const disablePush = useCallback(async () => {
    setBusy(true);
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        const endpoint = subscription.endpoint;
        await subscription.unsubscribe().catch(() => {});
        await call(`${API}/subscribe`, { method: "DELETE", body: JSON.stringify({ endpoint }) });
      }
      await savePreferences({ enabled: false });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't turn notifications off");
    } finally {
      setBusy(false);
    }
  }, [savePreferences]);

  const sendTest = useCallback(async () => {
    setBusy(true);
    try {
      const result = await call(`${API}/test`, { method: "POST", body: "{}" });
      if (!result.ok) throw new Error("The push service didn't accept the test — try re-enabling notifications.");
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Test notification failed");
      throw err;
    } finally {
      setBusy(false);
    }
  }, []);

  /** Why the opt-in switch can't be offered right now, if it can't. */
  let blocked: PushBlockReason = null;
  if (inbox && !inbox.push.configured) blocked = "not-configured";
  else if (pushSupported() && typeof Notification !== "undefined" && Notification.permission === "denied") blocked = "denied";
  else if (!pushSupported()) blocked = "unsupported";

  return { inbox, error, busy, blocked, refresh, markRead, savePreferences, enablePush, disablePush, sendTest };
}
