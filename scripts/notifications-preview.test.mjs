import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "@playwright/test";

// Start the dev server first. No database connection or signed-in account needed.
// Optional: PREVIEW_BASE_URL and CHROMIUM_EXECUTABLE_PATH for hosted test runners.
test("notification concept: filters, read state, preferences, actions, and mobile", async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE_PATH
      ? {
          executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
          args: ["--no-sandbox", "--disable-dev-shm-usage"],
        }
      : {}),
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(
      `${process.env.PREVIEW_BASE_URL || "http://localhost:3000"}/notifications-preview`,
    );
    await page
      .getByRole("heading", { name: "Notifications", exact: false })
      .waitFor();
    const panel = page.locator("#notification-panel");
    assert.equal(await panel.locator("article").count(), 4);
    await page.getByRole("button", { name: "Unread 3", exact: true }).click();
    assert.equal(await panel.locator("article").count(), 3);
    await page
      .getByRole("button", {
        name: "Mark A little review goes a long way as read",
        exact: true,
      })
      .click();
    assert.equal(await panel.locator("article").count(), 2);
    await page
      .getByRole("button", { name: "Notifications, 2 unread" })
      .waitFor();
    await page
      .getByRole("button", { name: "Mark all read", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "You’re all caught up!" })
      .waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "Notifications, 0 unread" })
        .count(),
      1,
    );
    await page.getByRole("button", { name: "See all updates" }).click();
    assert.equal(await panel.locator("article").count(), 4);

    await page.getByRole("button", { name: "Reset demo" }).click();
    await page
      .getByRole("button", { name: "Review 12 cards", exact: true })
      .click();
    await page.getByRole("heading", { name: "Your daily review" }).waitFor();
    await page.getByRole("button", { name: "Back to notifications" }).click();
    await page
      .getByRole("button", { name: "Notifications, 2 unread" })
      .waitFor();
    await page
      .getByRole("button", { name: "Notification preferences" })
      .click();
    const reminders = page.getByRole("switch", {
      name: "Study reminders",
      exact: true,
    });
    assert.equal(await reminders.getAttribute("aria-checked"), "true");
    await reminders.click();
    assert.equal(await reminders.getAttribute("aria-checked"), "false");
    await page.getByRole("button", { name: "Back to inbox" }).click();
    await page
      .getByRole("button", { name: "Notification preferences" })
      .click();
    assert.equal(await reminders.getAttribute("aria-checked"), "false");
    await page.getByRole("button", { name: "Close notifications" }).click();
    assert.equal(await panel.count(), 0);
    assert.equal(
      await page
        .getByRole("button", { name: "Notifications, 2 unread" })
        .evaluate((el) => el === document.activeElement),
      true,
    );
    await page.getByRole("button", { name: "Notifications, 2 unread" }).click();
    await page.getByRole("button", { name: "Close notifications" }).focus();
    await page.keyboard.press("Escape");
    assert.equal(await panel.count(), 0);
    await page.getByRole("button", { name: "Reset demo" }).click();

    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
        `No horizontal overflow at ${width}px`,
      );
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Unread 3", exact: true }).click();
    await page
      .getByRole("button", { name: "Mark all read", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "You’re all caught up!" })
      .waitFor();
    assert.deepEqual(errors, [], "No browser runtime errors");
  } finally {
    await browser.close();
  }
});
