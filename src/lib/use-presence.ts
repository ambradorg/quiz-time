"use client";

/**
 * React bindings for presence — the two halves of "who's online":
 *
 *   usePresenceHeartbeat()  every signed-in browser checks in every 30 s,
 *                           carrying a short label of what it is looking at
 *   usePresenceRoster()     the owner polls the roster (and the live count)
 *
 * Both are best-effort: presence must never break studying. A failed heartbeat
 * is swallowed (the next one catches up), and a failed roster poll leaves the
 * previous list on screen instead of blanking it.
 *
 * The rules live in src/lib/presence.ts (pure + unit-tested); this file only
 * wires them to the network and to React.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  HEARTBEAT_INTERVAL_MS,
  MIN_HEARTBEAT_GAP_MS,
  describeDevice,
  type PresenceEntry,
} from "./presence";

/** How often the owner's open panel refreshes the roster. */
export const ROSTER_POLL_INTERVAL_MS = 20_000;

export interface PresenceRoster {
  online: number;
  total: number;
  windowSeconds: number;
  users: PresenceEntry[];
}

/** Why the roster couldn't be read — the UI turns these into copy. */
export type PresenceError = "forbidden" | "unreachable" | null;

const ROSTER_URL = "/api/presence";

/**
 * One roster read: the network call, with every failure folded into a value.
 * Kept as a plain module function (not a callback in the hook) so starting a
 * poll from an effect stays a fetch the effect can fire and forget.
 */
async function fetchPresenceRoster(): Promise<PresenceRoster | PresenceError> {
  try {
    const res = await fetch(ROSTER_URL, { cache: "no-store" });
    if (!res.ok) {
      // 403 = the session's email isn't OWNER_EMAIL (env changed since the page
      // was rendered, or a stale client flag). 401 lands here too when the
      // session expired — "forbidden" hides the panel either way.
      return res.status === 401 || res.status === 403 ? "forbidden" : "unreachable";
    }
    return (await res.json()) as PresenceRoster;
  } catch {
    // Offline, or the server is unreachable.
    return "unreachable";
  }
}

/**
 * Send a heartbeat now, then every HEARTBEAT_INTERVAL_MS while the tab is
 * visible. Going away is free: stop beating and the online window expires.
 *
 * `activity` is read from a ref, so changing it (navigating between tabs,
 * opening a deck) never restarts the interval — the activity effect below just
 * fires an extra beat, throttled by MIN_HEARTBEAT_GAP_MS so clicking around
 * can't hammer the endpoint.
 */
export function usePresenceHeartbeat({
  enabled,
  activity,
}: {
  /** Signed in *and* online — no point beating into a dead connection. */
  enabled: boolean;
  /** Short label of what the user is looking at, or null for nothing to say. */
  activity: string | null;
}): void {
  const activityRef = useRef(activity);
  const lastSentRef = useRef(0);
  const inFlightRef = useRef(false);

  useEffect(() => {
    activityRef.current = activity;
  }, [activity]);

  const beat = useCallback(async ({ force = false }: { force?: boolean } = {}) => {
    if (inFlightRef.current) return;
    const now = Date.now();
    if (!force && now - lastSentRef.current < MIN_HEARTBEAT_GAP_MS) return;
    inFlightRef.current = true;
    lastSentRef.current = now;
    try {
      await fetch(ROSTER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          activity: activityRef.current,
          device: typeof navigator === "undefined" ? null : describeDevice(navigator.userAgent),
        }),
        cache: "no-store",
      });
    } catch {
      // Offline, or the request was cut off — presence is best-effort and the
      // next beat catches up. Never surface this to the user.
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  // Check in on arrival, then keep the window alive. Background tabs stop
  // beating; coming back to the tab checks in immediately.
  useEffect(() => {
    if (!enabled) return;
    void beat({ force: true });

    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void beat();
    }, HEARTBEAT_INTERVAL_MS);

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void beat();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [enabled, beat]);

  // The label changed — reflect it right away (throttled by `beat`).
  useEffect(() => {
    if (!enabled) return;
    void beat();
  }, [enabled, activity, beat]);
}

/**
 * The owner's live roster. Polls while `enabled`, pauses in background tabs
 * (the interval keeps ticking but skips hidden ones) and refetches the moment
 * the tab comes back. `refresh()` is for the panel's refresh button.
 */
export function usePresenceRoster({ enabled }: { enabled: boolean }): {
  roster: PresenceRoster | null;
  loading: boolean;
  error: PresenceError;
  refresh: () => Promise<void>;
} {
  const [roster, setRoster] = useState<PresenceRoster | null>(null);
  const [error, setError] = useState<PresenceError>(null);
  const aliveRef = useRef(true);

  /**
   * Fold one result into state. A failed poll only sets the error: the list
   * already on screen stays there, so a blip never empties the panel.
   */
  const apply = useCallback((result: PresenceRoster | PresenceError) => {
    if (!aliveRef.current) return;
    if (typeof result === "string" || result === null) {
      setError(result ?? "unreachable");
      return;
    }
    setRoster(result);
    setError(null);
  }, []);

  /** Manual refresh (the panel's button) — same read, awaited by the caller. */
  const refresh = useCallback(async () => {
    apply(await fetchPresenceRoster());
  }, [apply]);

  // Derived: still waiting on the very first answer. Manual refreshes are the
  // panel's own business (it owns that spinner) — polling is invisible.
  const loading = enabled && roster === null && error === null;

  useEffect(() => {
    aliveRef.current = true;
    if (!enabled) return;

    void fetchPresenceRoster().then(apply);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void fetchPresenceRoster().then(apply);
    }, ROSTER_POLL_INTERVAL_MS);

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void fetchPresenceRoster().then(apply);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      aliveRef.current = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [enabled, apply]);

  return { roster, loading, error, refresh };
}
