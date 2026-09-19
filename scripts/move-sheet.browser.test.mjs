import { test, expect } from "@playwright/test";

for (const folderCount of [1, 30]) {
  test(`move a set with ${folderCount} subject folders`, async ({ page, isMobile }) => {
    const subjects = Array.from({ length: folderCount }, (_, i) => ({
      id: i + 1, name: `Subject ${i + 1}`, setCount: 0,
    }));
    const session = {
      id: 1, title: "Biology revision", subjectId: null, cardCount: 10,
      knownCount: 0, sourceType: "manual", createdAt: "2026-01-01T00:00:00Z",
    };
    await page.addInitScript(() => {
      sessionStorage.setItem("quiztime-mascot-greeted:move-sheet-test", "1");
      localStorage.setItem("quiztime:course-asked", "1");
      localStorage.setItem("quiztime-install-dismissed", "1");
    });
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      let json = {};
      if (path === "/api/auth/session") {
        json = { user: { id: "move-sheet-test", name: "Test Student" }, expires: "2099-01-01T00:00:00Z" };
      } else if (path === "/api/subjects") {
        json = { subjects };
      } else if (path === "/api/sessions") {
        json = { sessions: [session] };
      } else if (path === "/api/sessions/1" && route.request().method() === "PATCH") {
        session.subjectId = route.request().postDataJSON().subjectId;
        json = { success: true, session };
      } else if (path === "/api/profile") {
        json = { course: "Biology" };
      } else if (path === "/api/review") {
        json = { counts: { due: 0 }, cards: [] };
      }
      await route.fulfill({ json });
    });

    await page.goto("/");
    await page.getByRole("button", { name: "My Sets", exact: true }).click();
    // Keep the deck row clear of the folder grid; the sheet still lists every folder.
    await page.getByPlaceholder("Search subjects or sets").fill("Biology");
    const opener = page.getByRole("button", { name: "Move Biology revision to a subject", exact: true });
    await opener.click();
    const dialog = page.getByRole("dialog", { name: "Move Biology revision to a subject" });
    await expect(dialog).toBeVisible();
    const save = dialog.getByRole("button", { name: "Move here", exact: true });
    await expect(save).toBeDisabled();

    // Visibility alone misses the regression: the fixed nav covered the button.
    // Hit-testing its centre proves it isn't hidden behind another element.
    await expect.poll(() => save.evaluate((button) => {
      const r = button.getBoundingClientRect();
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return r.top >= 0 && r.bottom <= innerHeight && button.contains(top);
    })).toBe(true);

    if (folderCount > 1) {
      const scroll = dialog.locator("[data-move-sheet-scroll]");
      const pageScroll = await page.evaluate(() => scrollY);
      if (isMobile) {
        const cdp = await page.context().newCDPSession(page);
        const box = await scroll.boundingBox();
        const x = box.x + box.width / 2;
        const bottom = box.y + box.height - 10;
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchStart", touchPoints: [{ x, y: bottom }],
        });
        for (let step = 1; step <= 5; step++) {
          await cdp.send("Input.dispatchTouchEvent", {
            type: "touchMove", touchPoints: [{ x, y: bottom - step * (box.height - 20) / 5 }],
          });
        }
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await cdp.detach();
      } else {
        await scroll.hover();
        await page.mouse.wheel(0, 2000);
      }
      await expect.poll(() => scroll.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
      expect(await page.evaluate(() => scrollY)).toBe(pageScroll);
    }
    await dialog.getByRole("button", { name: `Subject ${folderCount} 0 sets`, exact: true }).click();
    await expect(save).toBeEnabled();
    const moved = page.waitForRequest((request) =>
      request.url().endsWith("/api/sessions/1") && request.method() === "PATCH");
    await save.click();
    expect((await moved).postDataJSON()).toEqual({ subjectId: folderCount });
    await expect(dialog).toBeHidden();
    await expect.poll(() => page.evaluate(() => ({
      html: document.documentElement.style.overflow,
      body: document.body.style.overflow,
    }))).toEqual({ html: "", body: "" });

    // The backdrop also dismisses the sheet and releases the scroll lock.
    await opener.click();
    await expect(dialog).toBeVisible();
    await page.mouse.click(5, 5);
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("button", { name: "My Sets", exact: true })).toBeEnabled();
  });
}
