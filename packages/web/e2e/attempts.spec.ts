import { test, expect } from "@playwright/test";
const goalId = "00000000-0000-4000-8000-000000000001";
const first = "00000000-0000-4000-8000-000000000002";
const second = "00000000-0000-4000-8000-000000000003";

for (const [draft, checksPassed, label] of [
  [true, undefined, "Waiting for checks"],
  [true, true, "Waiting for checks"],
  [false, false, "Waiting for checks"],
  [false, undefined, "Waiting for checks"],
  [false, true, "Ready for review"],
] as const) {
  test(`run selection and readiness: draft=${draft}, checks=${checksPassed}`, async ({ page }) => {
    const pr = (number: number) => ({
      number,
      ...(number === 2
        ? {
            title: "Improve project details",
            body: "Show PR context.\nKeep review in Herbie.",
            additions: 42,
            deletions: 0,
            changedFiles: 3,
            draft,
            checksPassed,
          }
        : {}),
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
      mode: "live",
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
      { id: 1, attemptId: first, type: "attempt_started", message: "Run #1 started" },
      { id: 2, attemptId: second, type: "attempt_started", message: "Run #2 started" },
      { id: 3, attemptId: first, type: "pull_request_merged", message: "Pull request merged" },
      { id: 4, attemptId: null, type: "renamed", message: "Project renamed" },
    ].map((e) => ({ ...e, goalId, createdAt: "2026-10-15" }));
    const json = (body: unknown) => ({
      contentType: "application/json",
      body: JSON.stringify(body),
    });
    await page.route("**/api/health", (r) =>
      r.fulfill(json({ mode: "live", executionEnabled: true })),
    );
    await page.route("**/api/session", (r) =>
      r.fulfill(json({ mode: "live", user: { id: "fixture", login: "fixture" } })),
    );
    await page.route("**/api/goals", (r) => r.fulfill(json([goal])));
    await page.route("**/api/repositories", (r) => r.fulfill(json([])));
    await page.route("**/api/goals/*/events**", (r) => r.fulfill(json(events)));
    await page.setViewportSize({ width: 796, height: 824 });
    await page.goto(`/#${goalId}`);
    const one = page.getByRole("button", { name: "Run 1 Merged" });
    const two = page.getByRole("button", { name: `Run 2 ${label}` });
    await expect(two).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".detail-heading .badge")).toHaveText(label);
    await expect(one).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByText("Run #2 started", { exact: true })).toBeVisible();
    await expect(page.getByText("Run #1 started", { exact: true })).not.toBeVisible();
    await expect(page.getByRole("link", { name: "Review on GitHub" })).toHaveCount(1);
    await expect(page.getByText("#2 · Improve project details", { exact: true })).toBeVisible();
    await expect(page.getByText("Show PR context.", { exact: false })).toContainText(
      "Keep review in Herbie.",
    );
    await expect(page.getByLabel("42 additions", { exact: true })).toBeVisible();
    await expect(page.getByLabel("0 deletions", { exact: true })).toBeVisible();
    await expect(page.getByText("3 files changed", { exact: true })).toBeVisible();
    await expect(page.getByText(draft ? "Draft" : "Open", { exact: true })).toBeVisible();
    await one.focus();
    await page.keyboard.press("Enter");
    await expect(one).toHaveAttribute("aria-pressed", "true");
    await expect(two).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByText("Pull request #1 merged")).toBeVisible();
    await expect(page.getByRole("link", { name: "View on GitHub" })).toHaveAttribute(
      "href",
      "https://demo.invalid/pr/1",
    );
    await expect(one.locator(".badge")).toHaveCSS("color", "rgb(196, 165, 239)");
    await expect(two.locator(".badge")).toHaveClass(/status-awaiting_review/);
    await expect(two.locator(".badge")).toHaveCSS("color", "rgb(112, 201, 152)");
    await expect.poll(() => page.getByRole("button", { pressed: true }).count()).toBe(1);
    await page.screenshot({ path: "test-results/attempts-desktop.png", fullPage: true });
    await expect(page.getByRole("button", { name: "Goal history" })).toHaveCount(0);
    await expect(page.getByText("Goal renamed", { exact: true })).toHaveCount(0);
    await one.click();
    await expect(one).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Project activity", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Project activity" })).toBeVisible();
    await expect(page.getByRole("link", { name: /on GitHub/ })).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await two.click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: "test-results/attempts-mobile.png", fullPage: true });
  });
}
