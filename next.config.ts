import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow live-reload from hosted dev previews (e.g. *.e2b.app sandboxes).
  // Dev-only: this has no effect on production builds.
  allowedDevOrigins: ["*.e2b.app", "*.arena.ai", "localhost"],
  experimental: {
    serverActions: {
      bodySizeLimit: "50mb",
    },
  },
  async headers() {
    return [
      {
        // The service worker script must always be revalidated, never
        // served from cache, so browsers detect new versions immediately.
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
};

export default nextConfig;
