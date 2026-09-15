"use client";

/**
 * React bindings for offline mode.
 *
 * The three hooks the app shell needs:
 *   - `useOnlineStatus()`  – "is the network usable right now?" (browser signal
 *     *and* recent request outcomes, so a captive portal counts as offline)
 *   - `useOfflineIdentity()` – "who is signed in?" with the cached profile as
 *     the offline answer, so the app can open without reaching the server
 *   - `useOutbox()` – the pending-writes chip + manual "sync now"
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  bindConnectivityListeners,
  cacheProfile,
  flushOfflineQueue,
  isOfflineMode,
  isProbablyOnline,
  profileFromUser,
  readCachedProfile,
  readOutboxCount,
  subscribeConnectivity,
  subscribeOutbox,
  type FlushResult,
  type OfflineProfile,
} from "./offline";

/** The profile shape Auth.js hands to `useSession()`. */
export interface SessionUser {
  id?: string;
  name?: string | null;
  email?: string | null;
  image?: string | null;
}

/**
 * Live connectivity state.
 *
 * `useSyncExternalStore` is the right primitive here: connectivity is an
 * external store (browser events + the outcome of recent requests), and the
 * server snapshot ("assume online") keeps hydration honest — no setState in an
 * effect, no flash of "offline" markup on a healthy connection.
 */
export function useOnlineStatus(): boolean {
  return useSyncExternalStore(
    (onStoreChange) => {
      bindConnectivityListeners();
      return subscribeConnectivity(onStoreChange);
    },
    () => isProbablyOnline(),
    () => true
  );
}

export interface AppIdentity {
  /** Session user, or the cached profile when we're offline. */
  user: SessionUser | null;
  /** True when `user` came from the offline cache rather than the session. */
  offline: boolean;
  /** False only while the very first session lookup is still in flight. */
  ready: boolean;
  /** A profile is cached on this device — offline is possible after sign-out. */
  hasCachedProfile: boolean;
  /** When the cached profile was last confirmed online. */
  cachedAt: string | null;
}

/**
 * Resolve *who is signed in*, offline included.
 *
 * Auth.js can only answer that with a network round trip, so:
 *   1. a live session user always wins (and refreshes the cache),
 *   2. offline (or explicitly in offline mode) the cached profile signs the
 *      user in — that is what "open my account offline" means,
 *   3. otherwise the app is genuinely signed out.
 *
 * `ready` keeps the login splash from flashing while those are being sorted
 * out, with a short grace period so an offline start never hangs on a request
 * that can't succeed.
 */
export function useOfflineIdentity({
  user,
  status,
}: {
  user: SessionUser | null | undefined;
  status: "loading" | "authenticated" | "unauthenticated";
}): AppIdentity {
  // `undefined` = still reading the cache, `null` = nothing cached.
  const [profile, setProfile] = useState<OfflineProfile | null | undefined>(undefined);
  const [graceOver, setGraceOver] = useState(false);
  const online = useOnlineStatus();

  useEffect(() => {
    let alive = true;
    void readCachedProfile().then((cached) => {
      if (alive) setProfile(cached);
    });
    const timer = setTimeout(() => setGraceOver(true), 700);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);

  // Keep the cache warm while we have a real session — a side effect only, so
  // the live user comes straight from `useSession` rather than a mirror state
  // (which would also mean a second render on every profile update).
  useEffect(() => {
    if (!user?.id) return;
    void cacheProfile(profileFromUser(user));
  }, [user?.id, user?.name, user?.email, user?.image]); // eslint-disable-line react-hooks/exhaustive-deps

  return useMemo(() => {
    const sessionUser = user?.id ? user : null;
    const canUseCache =
      !sessionUser && Boolean(profile) && (isOfflineMode() || !online || !isProbablyOnline());
    const resolved = sessionUser
      ? sessionUser
      : canUseCache && profile
        ? { id: profile.id, name: profile.name, email: profile.email, image: profile.image }
        : null;

    return {
      user: resolved,
      offline: Boolean(!sessionUser && resolved),
      ready:
        Boolean(sessionUser) ||
        status !== "loading" ||
        (graceOver && Boolean(profile) && (!online || isOfflineMode())),
      // A live session counts as cached: the effect above is writing it.
      hasCachedProfile: Boolean(profile) || Boolean(sessionUser),
      cachedAt: profile?.savedAt ?? null,
    };
  }, [user, profile, status, online, graceOver]);
}

export interface OutboxState {
  /** How many study answers / grades are waiting to sync. */
  count: number;
  syncing: boolean;
  online: boolean;
  flush: () => Promise<FlushResult & { remaining: number }>;
}

/** Pending-writes state for the "N waiting to sync" chip. */
export function useOutbox(): OutboxState {
  const online = useOnlineStatus();
  const [count, setCount] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const inFlight = useRef(false);

  const refresh = useCallback(() => {
    void readOutboxCount().then(setCount);
  }, []);

  useEffect(() => {
    refresh();
    return subscribeOutbox(refresh);
  }, [refresh]);

  const flush = useCallback(async () => {
    if (inFlight.current) {
      return { syncedEntries: 0, remaining: count } as FlushResult & { remaining: number };
    }
    inFlight.current = true;
    setSyncing(true);
    try {
      const result = await flushOfflineQueue();
      setCount(result.remaining);
      return result;
    } finally {
      inFlight.current = false;
      setSyncing(false);
      refresh();
    }
  }, [count, refresh]);

  const value = useMemo(
    () => ({ count, syncing, online, flush }),
    [count, syncing, online, flush]
  );
  return value;
}
