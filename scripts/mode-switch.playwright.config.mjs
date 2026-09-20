import { defineConfig } from "@playwright/test";

// Setup: npx playwright install --with-deps chromium
// Start the app (npm run dev), then run npm run test:mode-switch.
// BASE_URL can target another running instance. API responses are mocked;
// no login or database fixtures are needed, only the app's normal startup env.
// The phone projects are the point: the mode row only overflows on a narrow screen.
export default defineConfig({
  testDir: ".",
  testMatch: "mode-switch.browser.test.mjs",
  fullyParallel: true,
  use: {
    baseURL: process.env.BASE_URL || "http://localhost:3000",
    serviceWorkers: "block",
    launchOptions: process.env.CHROMIUM_EXECUTABLE_PATH
      ? {
          executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
          args: ["--no-sandbox", "--disable-dev-shm-usage"],
        }
      : {},
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1280, height: 800 } } },
    { name: "phone", use: { viewport: { width: 390, height: 740 }, isMobile: true, hasTouch: true } },
    // Narrow enough that the five tabs can never fit, checked without touch
    // emulation so the mouse drag is exercised at this width too.
    { name: "narrow", use: { viewport: { width: 360, height: 740 } } },
  ],
});
