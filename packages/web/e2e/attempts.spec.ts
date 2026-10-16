import { test, expect } from "@playwright/test";
const projectId = "00000000-0000-4000-8000-000000000001";
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
            body: "## Summary\n\nShow PR context.\nKeep review in Herbie.\n\n```diff\n- old behavior\n+ improved behavior\n```\n\n## Evidence\n\n- **Verified:** `pnpm test`\n- [Review notes](https://example.com/notes)\n\n<script>alert(1)</script>",
            additions: 42,
            deletions: 0,
            changedFiles: 3,
            draft,
            checksPassed,
          }
        : {}),
      branch: `herbie/${"long-branch-segment-".repeat(8)}${number}`,
      url: `https://demo.invalid/pr/${number}`,
      state: number === 1 ? "merged" : "open",
    });
    const project = {
      id: projectId,
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
    ].map((e) => ({ ...e, projectId, createdAt: "2026-10-15" }));
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
    await page.route("**/api/projects", (r) => r.fulfill(json([project])));
    await page.route("**/api/repositories", (r) => r.fulfill(json([])));
    await page.route("**/api/projects/*/events**", (r) => r.fulfill(json(events)));
    await page.setViewportSize({ width: 796, height: 824 });
    await page.goto(`/#${projectId}`);
    const one = page.getByRole("link", { name: "Run 1 Merged" });
    const two = page.getByRole("link", { name: `Run 2 ${label}` });
    await expect(two).toHaveAttribute("href", `#${projectId}/runs/${second}`);
    await expect(page.locator(".run-panel")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "#2 · Improve project details" })).toHaveAttribute(
      "href",
      "https://demo.invalid/pr/2",
    );
    await expect(page.locator(".detail-heading .badge")).toHaveText(label);
    await two.click();
    await expect(page).toHaveURL(new RegExp(`/runs/${second}$`));
    await expect(page.locator(".project-brief")).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Run history" })).toHaveCount(0);
    await page.reload();
    await expect(page.getByText("Run #2 started", { exact: true })).toBeVisible();
    await expect(page.getByText("Run #1 started", { exact: true })).not.toBeVisible();
    await expect(page.getByRole("link", { name: "Review on GitHub" })).toHaveCount(1);
    await expect(
      page.getByRole("heading", { name: "#2 · Improve project details", exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("Breadcrumb").getByText("Run 2", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Run 2", exact: true })).toHaveCount(0);
    await expect(page.getByText("Show PR context.", { exact: false })).toContainText(
      "Keep review in Herbie.",
    );
    await expect(page.getByRole("heading", { name: "Summary", exact: true })).toBeVisible();
    await expect(page.locator(".pr-description pre code")).toContainText("+ improved behavior");
    await expect(page.getByText("+ improved behavior", { exact: true })).toHaveCSS(
      "color",
      "rgb(142, 220, 165)",
    );
    await expect(page.getByText("- old behavior", { exact: true })).toHaveCSS(
      "color",
      "rgb(255, 155, 155)",
    );
    await expect(page.locator(".pr-description strong")).toHaveText("Verified:");
    await expect(page.locator(".pr-description script")).toHaveCount(0);
    await expect(page.locator(".pr-branch code")).not.toBeVisible();
    await page.getByText("Source branch", { exact: true }).click();
    await expect(page.locator(".pr-branch code")).toBeVisible();
    await expect(page.getByLabel("42 additions", { exact: true })).toBeVisible();
    await expect(page.getByLabel("0 deletions", { exact: true })).toBeVisible();
    await expect(page.getByText("3 files changed", { exact: true })).toBeVisible();
    await expect(page.locator(".pr-metadata .badge")).toHaveText(label);
    await page.getByRole("link", { name: "Attempt history", exact: true }).click();
    await one.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/runs/${first}$`));

    await expect(page.getByText("Pull request #1 merged")).toBeVisible();
    await expect(page.getByRole("link", { name: "View on GitHub" })).toHaveAttribute(
      "href",
      "https://demo.invalid/pr/1",
    );
    await page.goBack();
    await expect(one.locator(".badge")).toHaveCSS("color", "rgb(196, 165, 239)");
    const color = label === "Waiting for checks" ? "rgb(229, 199, 107)" : "rgb(112, 201, 152)";
    await expect(two.locator(".badge")).toHaveCSS("color", color);
    await expect(page.locator(".detail-heading .badge")).toHaveCSS("color", color);

    await page.setViewportSize({ width: 1440, height: 1100 });
    await two.click();
    await page.screenshot({ path: "test-results/attempts-desktop.png", fullPage: true });
    await expect(page.getByRole("button", { name: "Project history" })).toHaveCount(0);
    await expect(page.getByText("Project renamed", { exact: true })).toHaveCount(0);
    await page.goBack();
    await page.getByRole("link", { name: "Project activity", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Project activity" })).toBeVisible();
    await expect(page.getByRole("link", { name: /on GitHub/ })).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goBack();
    await two.click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: "test-results/attempts-mobile.png", fullPage: true });
    await page.goto(`/#${projectId}/runs/missing`);
    await expect(page.getByText("Run not found.", { exact: true })).toBeVisible();
  });
}
