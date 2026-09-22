import { test, expect } from "@playwright/test";

function mascotSize(viewport) {
  return viewport.height <= 480 ? 112 : viewport.width <= 480 ? 156 : 208;
}

async function expectBubbleToFit(page) {
  const viewport = page.viewportSize();
  const bubble = await page.locator(".mascot-bubble").boundingBox();
  const avatar = await page.locator(".mascot-avatar").boundingBox();
  expect(bubble.x).toBeGreaterThanOrEqual(0);
  expect(bubble.y).toBeGreaterThanOrEqual(0);
  expect(bubble.x + bubble.width).toBeLessThanOrEqual(viewport.width);
  expect(bubble.y + bubble.height).toBeLessThan(avatar.y);
  // Keep the character clear of the bottom-navigation area.
  expect(avatar.y + avatar.height).toBeLessThanOrEqual(viewport.height - 72);
}

test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", (route) =>
    route.fulfill({
      status: new URL(route.request().url()).pathname === "/api/stats" ? 401 : 200,
      json: null,
    })
  );
  await page.goto("/hamster-preview");
  await expect(page.getByRole("button", { name: "Next →", exact: true })).toBeVisible();
});

test("full-size character and aligned bubble fit every onboarding step", async ({ page }) => {
  const avatar = page.locator(".mascot-avatar");
  const size = mascotSize(page.viewportSize());
  await expect(avatar).toHaveCSS("width", `${size}px`);
  await expect(avatar).toHaveCSS("height", `${size}px`);
  await expect(avatar).toHaveCSS("flex-shrink", "0");
  await expect(avatar).toHaveCSS("overflow", "visible");
  await expect(avatar).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(avatar.locator("img")).toHaveCSS("object-fit", "contain");
  await expect.poll(() => avatar.locator("img").evaluate((img) => img.complete && img.naturalWidth > 0)).toBe(true);

  const tailOffset = await page.locator(".mascot-bubble").evaluate((bubble) => {
    const tail = getComputedStyle(bubble, "::after");
    const style = getComputedStyle(bubble);
    const tailCenter = bubble.getBoundingClientRect().right
      - parseFloat(style.borderRightWidth) - parseFloat(tail.right) - parseFloat(tail.width) / 2;
    const avatar = document.querySelector(".mascot-avatar").getBoundingClientRect();
    return Math.abs(tailCenter - (avatar.x + avatar.width / 2));
  });
  expect(tailOffset).toBeLessThanOrEqual(1);

  for (let step = 0; step < 5; step += 1) {
    const next = page.getByRole("button", { name: step === 4 ? "Let's go! 🎉" : "Next →", exact: true });
    await expect(next).toBeVisible();
    await expectBubbleToFit(page);
    await next.click();
  }

  // A dismissed large mascot must not leave an invisible button over the app.
  await expect(avatar).toBeHidden();
  const viewport = page.viewportSize();
  const tapsMascot = () =>
    page.evaluate(
      ({ width, height }) =>
        Boolean(document.elementFromPoint(width - 60, height - 130)?.closest(".mascot-wrap")),
      viewport
    );
  // elementFromPoint hit-tests the last committed frame, which can lag the
  // visibility flip by a frame — poll until the settled state instead of
  // asserting one frame too early.
  await expect.poll(tapsMascot, { timeout: 2000 }).toBe(false);
});

test("peeking remains half tucked away and opens a fully visible bubble", async ({ page }) => {
  await page.getByRole("button", { name: "Skip tour", exact: true }).click();
  await expect(page.locator(".mascot-avatar")).toBeHidden();
  await page.getByRole("button", { name: /Peek while answering/ }).click();

  const avatar = page.locator(".mascot-avatar");
  const size = mascotSize(page.viewportSize());
  await expect(avatar).toBeVisible();
  await expect(avatar.locator("img")).toHaveAttribute("src", "/hamster/hamster-peek.png");
  const box = await avatar.boundingBox();
  expect(box.x).toBeCloseTo(page.viewportSize().width - size / 2, 0);
  expect(box.width).toBe(size);

  // Poke the visible half, rather than the center that's beyond the viewport.
  await avatar.click({ position: { x: size / 4, y: size / 2 } });
  await expect(page.locator(".mascot-bubble")).toBeVisible();
  await expect(page.locator(".mascot-wrap")).not.toHaveClass(/mascot-peeking/);
  await expectBubbleToFit(page);
});

test("celebration and thinking poses keep the same character size", async ({ page }) => {
  const size = mascotSize(page.viewportSize());
  const avatar = page.locator(".mascot-avatar");
  await page.getByRole("button", { name: "Skip tour", exact: true }).click();
  await page.getByRole("button", { name: /Study finished · 92%/ }).click();
  await expect(avatar.locator("img")).toHaveAttribute("src", "/hamster/hamster-nibble.png");
  await expect(avatar).toHaveCSS("height", `${size}px`);
  await expectBubbleToFit(page);

  await page.getByRole("button", { name: "Dismiss Nibbles", exact: true }).click();
  await page.getByRole("button", { name: /AI generating flashcards/ }).click();
  await expect(avatar.locator("img")).toHaveAttribute("src", "/hamster/hamster-thinking.png");
  await expect(avatar).toHaveCSS("height", `${size}px`);
  await page.getByRole("button", { name: "Dismiss Nibbles", exact: true }).click();
  await expect(avatar).toBeVisible();
  await expect(page.locator(".mascot-thought")).toBeAttached();
});
