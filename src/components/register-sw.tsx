"use client";

import { useEffect } from "react";

/**
 * Registers the service worker (public/sw.js) so installed home-screen apps
 * pick up every deploy. Production only — a service worker in `next dev`
 * would cache dev assets and make local work confusing.
 */
export function RegisterServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Registration failing (e.g. unsupported context) must never break the app.
    });
  }, []);
  return null;
}
