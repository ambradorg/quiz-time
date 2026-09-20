import { test, expect } from "@playwright/test";

/**
 * The quiz mode row: five labelled tabs, and a phone that can't fit them.
 *
 * Regression: every tab was `flex: 1` (basis 0%, shrink 1), so at phone width
 * they shrank to their minimum, the row overflowed the card, and `body`'s
 * `overflow-x: hidden` sliced the last tab ("Review") in half — unreachable,
 * because nothing could scroll it into view. The row is a sideways scroller now,
 * so a tab that doesn't fit has to stay whole and stay *reachable*:
 *
 *   - no label is ever cut inside its pill
 *   - whatever sticks out is scrollable, not clipped
 *   - dragging/flicking sideways scrolls it, and picking a tab still takes one
 */

const SESSION = {
  id: 1,
  title: "Introduction to Artificial Intelligence",
  sourceType: "manual",
  summary: "Foundational definitions and history",
  cardCount: 6,
  createdAt: "2026-01-01T00:00:00Z",
};

const ANSWERS = [
  "Artificial Intelligence",
  "John McCarthy",
  "The Turing Test",
  "Biological neurons",
  "Machine learning",
  "Acts to maximise a reward",
];

const CARDS = ANSWERS.map((answer, i) => ({
  id: i + 1,
  question: `Question ${i + 1} of the AI primer?`,
  answer,
  hint: null,
  difficulty: "medium",
  orderIndex: i,
}));

/** Three due cards: the Review tab carries a badge, i.e. it is at its widest. */
const DUE_CARDS = CARDS.slice(0, 3).map((card) => ({
  cardId: card.id,
  sessionId: SESSION.id,
  question: card.question,
  answer: card.answer,
  hint: null,
  difficulty: card.difficulty,
  deckTitle: SESSION.title,
  isNew: true,
  dueAt: null,
  state: null,
}));

const TABS = ["Study", "Exam", "Identify", "Enumerate", "Review"];

async function openDeckInStudyMode(page) {
  await page.addInitScript(() => {
    sessionStorage.setItem("quiztime-mascot-greeted:mode-switch-test", "1");
    localStorage.setItem("quiztime:course-asked", "1");
    localStorage.setItem("quiztime-install-dismissed", "1");
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let json = {};
    if (path === "/api/auth/session") {
      json = { user: { id: "mode-switch-test", name: "Test Student" }, expires: "2099-01-01T00:00:00Z" };
    } else if (path === "/api/subjects") {
      json = { subjects: [] };
    } else if (path === "/api/sessions") {
      json = { sessions: [SESSION] };
    } else if (path === "/api/sessions/1") {
      json = { session: SESSION, cards: CARDS, progress: [] };
    } else if (path === "/api/profile") {
      json = { course: "AI 101" };
    } else if (path === "/api/config") {
      json = { hasApiKey: true, demoLogin: false, signedIn: true };
    } else if (path === "/api/notifications") {
      json = {
        notifications: [],
        unread: 0,
        preferences: { enabled: false, reminderTime: "19:00", timeZone: "UTC" },
        push: { configured: false, publicKey: null, deviceCount: 0 },
      };
    } else if (path === "/api/review") {
      json = {
        now: new Date().toISOString(),
        counts: { due: 3, learning: 0, tracked: 6, newCards: 3, newRemainingToday: 10, newPerDay: 10 },
        nextDueAt: null,
        decks: [],
        queue: DUE_CARDS,
      };
    }
    await route.fulfill({ json });
  });

  await page.goto("/");
  // The nav tab is driven directly: at 320px the Home page's promo card hangs
  // over the fixed nav (unrelated to this row) and would swallow the click.
  await page.getByRole("button", { name: "My Sets", exact: true }).evaluate((el) => el.click());
  await page.getByText(SESSION.title).click();
  // The mode row only exists once a mode has been picked from the picker.
  await page.getByRole("button", { name: /Study Mode/ }).click();
  await expect(page.locator(".mode-switch")).toBeVisible();
}

/** Row + tabs as the browser laid them out — no assumptions about the fix. */
function rowState(page) {
  return page.locator(".mode-switch").evaluate((bar) => {
    const box = bar.getBoundingClientRect();
    const tabs = Array.from(bar.children, (tab) => {
      const rect = tab.getBoundingClientRect();
      return {
        text: tab.textContent.trim(),
        // Text shaved off inside the pill (nowrap means this is clipping).
        labelClipped: tab.scrollWidth - tab.clientWidth,
        // How far the tab pokes past the row's own right edge.
        pokesOut: Math.max(0, Math.round(rect.right - box.right)),
      };
    });
    return {
      tabs,
      overflow: Math.round(bar.scrollWidth - bar.clientWidth),
      overflowX: getComputedStyle(bar).overflowX,
    };
  });
}

/** Scroll `index` into the row's viewport and report where it ended up. */
function revealTab(page, index) {
  return page.locator(".mode-switch").evaluate(
    (bar, i) => {
      const tab = bar.children[i];
      const centre = tab.offsetLeft + tab.offsetWidth / 2;
      const max = bar.scrollWidth - bar.clientWidth;
      bar.scrollLeft = Math.max(0, Math.min(max, centre - bar.clientWidth / 2));
      const box = bar.getBoundingClientRect();
      const rect = tab.getBoundingClientRect();
      return {
        text: tab.textContent.trim(),
        insideRow: rect.left >= box.left - 1 && rect.right <= box.right + 1,
      };
    },
    index
  );
}

const activeTabText = (page) => page.locator(".mode-switch button.active").textContent();

/**
 * The row fades in with the mode it belongs to, so a gesture aimed at it has to
 * wait for the animation or it lands on the wrong pixels. Returns the box.
 */
async function settleBar(page) {
  const bar = page.locator(".mode-switch");
  let seen = "";
  await expect
    .poll(async () => {
      const box = await bar.boundingBox();
      const key = `${Math.round(box.x)},${Math.round(box.y)},${Math.round(box.height)}`;
      const stable = seen === key;
      seen = key;
      return stable;
    })
    .toBe(true);
  return bar.boundingBox();
}

test.describe("quiz mode row", () => {
  test.beforeEach(async ({ page }) => openDeckInStudyMode(page));

  test("tabs that don't fit are scrollable, never clipped", async ({ page }) => {
    const state = await rowState(page);

    // Every tab still reads its whole label, badge included.
    for (const [index, tab] of state.tabs.entries()) {
      expect(tab.labelClipped, `tab ${index} "${tab.text}" lost part of its label`)
        .toBeLessThanOrEqual(1);
    }

    // Anything hanging past the edge has to be reachable. The broken row had
    // overflow-x: visible, so the last tab was painted outside the card and
    // clipped by the viewport with no way to bring it back.
    const hanging = state.tabs.filter((tab) => tab.pokesOut > 0);
    if (hanging.length > 0) {
      expect(state.overflowX, "overflowing tabs must be scrollable, not clipped").toContain("auto");
      const widest = Math.max(...hanging.map((tab) => tab.pokesOut));
      expect(state.overflow, "the row can't scroll as far as it overflows")
        .toBeGreaterThanOrEqual(widest);
    }
  });

  test("every tab can be brought fully inside the row, last one included", async ({ page }) => {
    for (const [index, label] of TABS.entries()) {
      const revealed = await revealTab(page, index);
      expect(revealed.text.startsWith(label), `tab ${index} reads "${revealed.text}"`).toBe(true);
      // The broken row painted the tabs past the card edge where they could
      // never come back: no amount of scrolling moved them, because there was
      // nothing to scroll.
      expect(revealed.insideRow, `tab "${label}" can't be scrolled into view`).toBe(true);
    }
    // Hovering the last tab is a real hit test: it must not be covered.
    await page.locator(".mode-switch button").nth(TABS.length - 1).hover();
  });

  test("a drag scrolls sideways and picks nothing on the way", async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, "touch flicks are native; the drag under test is a mouse one");
    const bar = page.locator(".mode-switch");
    const box = await settleBar(page);
    const y = box.y + box.height / 2;

    // Grab a tab, not the arrow at the row's edge (that one nudges instead).
    // Under a loaded CI box the first synthesized drag can land during a
    // re-layout, so the gesture retries — the way a person would press again.
    const gesture = async () => {
      await bar.evaluate((el) => {
        el.scrollLeft = 0;
      });
      await page.mouse.move(box.x + 60, y);
      await page.mouse.down();
      try {
        await page.mouse.move(Math.max(4, box.x - 150), y, { steps: 10 });
        await expect
          .poll(() => bar.evaluate((el) => el.scrollLeft), { timeout: 8_000 })
          .toBeGreaterThan(0);
      } finally {
        await page.mouse.up();
      }
    };
    await expect(gesture).toPass({ timeout: 40_000 });
    expect(await bar.evaluate((el) => el.classList.contains("is-dragging"))).toBe(false);

    // Dragging the row must not be mistaken for tapping a tab.
    expect((await activeTabText(page)).trim()).toContain("Study");
    await expect(page.getByText(/Question 1 of 6/)).toHaveCount(0);
    const after = await bar.evaluate((el) => el.scrollLeft);
    expect(after).toBeGreaterThan(0);

    // Releasing over a tab doesn't select it either, and the row stays put.
    expect((await activeTabText(page)).trim()).toContain("Study");
    expect(await bar.evaluate((el) => el.scrollLeft)).toBe(after);

    // The tab that ends up under the cursor is still clickable as normal.
    await page.locator(".mode-switch button").nth(1).click();
    expect((await activeTabText(page)).trim()).toContain("Exam");
  });

  test("a flick scrolls sideways on touch", async ({ page, hasTouch }) => {
    test.skip(!hasTouch, "needs a touch device");
    const bar = page.locator(".mode-switch");
    const box = await settleBar(page);
    const y = box.y + box.height / 2;
    const pageScrollAtStart = await page.evaluate(() => scrollY);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: box.x + 50, y }],
    });
    for (let step = 1; step <= 6; step += 1) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: box.x + 50 - step * 40, y }],
      });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await cdp.detach();

    await expect.poll(() => bar.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
    // The flick went sideways, not down: the page barely moved (entering a deck
    // scrolls a few px on its own), while the row moved by hundreds.
    expect(await page.evaluate(() => scrollY)).toBeLessThan(pageScrollAtStart + 24);
    expect((await activeTabText(page)).trim()).toContain("Study");
  });

  test("tapping a tab still switches mode", async ({ page }) => {
    const active = page.locator(".mode-switch button.active");
    await page.locator(".mode-switch button").nth(1).click(); // Exam
    await expect(page.getByText(/Question 1 of 6/)).toBeVisible();
    await expect(active).toContainText("Exam");

    // The Review tab starts off-screen: the click scrolls it into view first,
    // which is the whole point of the row being scrollable, and leaves it
    // entirely inside the row once it is the active mode.
    await page.locator(".mode-switch button").nth(4).click();
    await expect(active).toContainText("Review");
    await expect.poll(async () => (await rowState(page)).tabs[4].pokesOut).toBe(0);
  });

  test("the row hints at scrolling only where tabs are actually hidden", async ({ page }) => {
    const bar = page.locator(".mode-switch");
    const read = () =>
      bar.evaluate((el) => ({
        max: Math.round(el.scrollWidth - el.clientWidth),
        scrollable: el.classList.contains("is-scrollable"),
        fades: Array.from(el.parentElement.querySelectorAll(".mode-switch-fade"), (fade) =>
          fade.classList.contains("mode-switch-fade--left") ? "left" : "right"
        ),
      }));

    // Give the row more room than the tabs need: the scroller and both arrows
    // have to stand down, and the tabs share the space instead of leaving a gap.
    await bar.evaluate((el) => {
      el.style.width = "760px";
      el.scrollLeft = 0;
    });
    await expect.poll(async () => (await read()).max).toBeLessThanOrEqual(0);
    // Class + fades are React state fed by the row's own measurement, so give
    // the re-render a moment rather than reading it once.
    await expect.poll(async () => (await read()).scrollable).toBe(false);
    await expect.poll(async () => (await read()).fades).toEqual([]);
    // The tabs grow to fill the row (flex-grow), so there is no dead space at
    // either end — only their own labels decide the widths.
    const span = await bar.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const first = el.children[0].getBoundingClientRect();
      const last = el.children[el.children.length - 1].getBoundingClientRect();
      return {
        leftGap: Math.round(first.left - box.left) - 4,
        rightGap: Math.round(box.right - last.right) - 4,
      };
    });
    expect(Math.max(Math.abs(span.leftGap), Math.abs(span.rightGap))).toBeLessThanOrEqual(2);

    // Back to a row that can't fit: hidden tabs on the right only.
    await bar.evaluate((el) => {
      el.style.width = "";
      el.scrollLeft = 0;
    });
    await expect.poll(async () => (await read()).max).toBeGreaterThan(0);
    await expect.poll(async () => (await read()).scrollable).toBe(true);
    await expect.poll(async () => (await read()).fades).toEqual(["right"]);

    // Halfway along, both ends have more to show.
    await bar.evaluate((el) => {
      el.scrollLeft = Math.round((el.scrollWidth - el.clientWidth) / 2);
    });
    await expect.poll(async () => (await read()).fades).toEqual(["left", "right"]);

    // At the far end only the left side does.
    await bar.evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    });
    await expect.poll(async () => (await read()).fades).toEqual(["left"]);
  });
});
