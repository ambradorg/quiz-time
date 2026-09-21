import { defineConfig } from "@playwright/test";

// Start the app with its normal startup env, then run npm run test:mascot.
// The public playground uses mocked APIs; no sign-in or database is needed.
export default defineConfig({
  testDir: ".",
  testMatch: "mascot.browser.test.mjs",
  fullyParallel: true,
  use: {
    baseURL: process.env.BASE_URL || "http://localhost:3000",
    serviceWorkers: "block",
    contextOptions: { reducedMotion: "reduce" },
    launchOptions: process.env.CHROMIUM_EXECUTABLE_PATH
      ? {
          executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
          args: ["--no-sandbox", "--disable-dev-shm-usage"],
        }
      : {},
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1280, height: 800 } } },
    { name: "phone", use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    { name: "narrow", use: { viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true } },
    { name: "landscape", use: { viewport: { width: 667, height: 375 }, isMobile: true, hasTouch: true } },
  ],
});
