import { defineConfig } from "@playwright/test";

// Setup: npx playwright install --with-deps chromium
// Start the app (npm run dev), then run npm run test:move-sheet.
// BASE_URL can target another running instance. API responses are mocked;
// no login or database fixtures are needed, only the app's normal startup env.
export default defineConfig({
  testDir: ".",
  testMatch: "move-sheet.browser.test.mjs",
  fullyParallel: true,
  use: {
    baseURL: process.env.BASE_URL || "http://localhost:3000",
    serviceWorkers: "block",
    launchOptions: process.env.CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH, args: ["--no-sandbox"] }
      : {},
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1280, height: 800 } } },
    { name: "phone", use: { viewport: { width: 390, height: 664 }, isMobile: true, hasTouch: true } },
    { name: "landscape", use: { viewport: { width: 667, height: 375 }, isMobile: true, hasTouch: true } },
  ],
});
