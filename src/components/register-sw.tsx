"use client";

import { useEffect } from "react";

/**
 * Registers the service worker (public/sw.js).
 *
 * The worker does three things: it caches the app shell so an installed
 * QuizTime opens with no network, it caches `/api/auth/session` (the one
 * request Auth.js makes by itself, without which "signed in offline" is
 * impossible), and it replays the offline outbox through Background Sync.
 *
 * In development it is registered as `/sw.js?dev=1`: the worker then keeps the
 * shell cacheable for offline testing but lets every request hit the dev
 * server first, so a cached chunk can never mask your changes. Registration
 * failures are swallowed — offline mode degrades to the in-app cache.
 */
export function RegisterServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const isDev = process.env.NODE_ENV !== "production";
    const scriptUrl = isDev ? "/sw.js?dev=1" : "/sw.js";
    void navigator.serviceWorker
      .register(scriptUrl, { updateViaCache: "none" })
      .then((registration) => registration.update())
      .catch(() => {
        // Unsupported context (or an insecure origin) — the app still works.
      });
  }, []);
  return null;
}
