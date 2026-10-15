import { test, expect } from "@playwright/test";
const goalId = "00000000-0000-4000-8000-000000000001";
const first = "00000000-0000-4000-8000-000000000002";
const second = "00000000-0000-4000-8000-000000000003";

test("attempt accordion shows independent statuses, PRs and events with one panel open", async ({
  page,
}) => {
  const pr = (number: number) => ({
    number,
    branch: `branch-${number}`,
    url: `https://demo.invalid/pr/${number}`,
    state: number === 1 ? "merged" : "open",
  });
  const goal = {
    id: goalId,
    ownerId: "fixture",
    name: "Attempt history",
    repository: "demo/example",
    prompt: "Review each attempt independently",
    mode: "demo",
    state: "awaiting_review",
    attemptCount: 2,
    createdAt: "2026-10-15",
    updatedAt: "2026-10-15",
    stopRequested: null,
    error: null,
    pullRequest: pr(2),
    pullRequests: [pr(1), pr(2)],
    attempts: [
      { id: first, number: 1, state: "completed", createdAt: "2026-10-15", pullRequest: pr(1) },
      {
        id: second,
        number: 2,
        state: "awaiting_review",
        createdAt: "2026-10-15",
        pullRequest: pr(2),
      },
    ],
  };
  const events = [
    { id: 1, attemptId: first, message: "First attempt log" },
    { id: 2, attemptId: second, message: "Second attempt log" },
    { id: 3, attemptId: first, message: "Older PR merged after attempt two started" },
    { id: 4, attemptId: null, message: "Goal renamed" },
  ].map((e) => ({ ...e, goalId, type: "activity", createdAt: "2026-10-15" }));
  const json = (body: unknown) => ({ contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/api/health", (r) =>
    r.fulfill(json({ mode: "demo", executionEnabled: true })),
  );
  await page.route("**/api/session", (r) =>
    r.fulfill(json({ mode: "demo", user: { id: "fixture", login: "fixture" } })),
  );
  await page.route("**/api/goals", (r) => r.fulfill(json([goal])));
  await page.route("**/api/repositories", (r) => r.fulfill(json([])));
  await page.route("**/api/goals/*/events**", (r) => r.fulfill(json(events)));
  await page.setViewportSize({ width: 796, height: 824 });
  await page.goto(`/#${goalId}`);
  const one = page.getByRole("button", { name: "Attempt 1 Merged" });
  const two = page.getByRole("button", { name: "Attempt 2 Ready for review" });
  await expect(two).toHaveAttribute("aria-expanded", "true");
  await expect(one).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByText("Second attempt log", { exact: true })).toBeVisible();
  await expect(page.getByText("First attempt log", { exact: true })).not.toBeVisible();
  await expect(page.getByRole("link", { name: "Review on GitHub" })).toHaveCount(1);
  await one.focus();
  await page.keyboard.press("Enter");
  await expect(one).toHaveAttribute("aria-expanded", "true");
  await expect(two).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByText("Older PR merged after attempt two started")).toBeVisible();
  await expect(page.getByRole("link", { name: "Review on GitHub" })).toHaveAttribute(
    "href",
    "https://demo.invalid/pr/1",
  );
  await expect(one.locator(".badge")).toHaveClass(/status-completed/);
  await expect(two.locator(".badge")).toHaveClass(/status-awaiting_review/);
  await expect.poll(() => page.getByRole("button", { expanded: true }).count()).toBe(1);
  await page.screenshot({ path: "test-results/attempts-desktop.png", fullPage: true });
  await expect(page.getByRole("button", { name: "Goal history" })).toHaveCount(0);
  await expect(page.getByText("Goal renamed", { exact: true })).toHaveCount(0);
  await one.click();
  await expect(page.getByRole("button", { expanded: true })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await two.click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/attempts-mobile.png", fullPage: true });
});
