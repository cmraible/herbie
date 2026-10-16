import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";

for (const scenario of ["failed", "needs_attention", "workflow_permission_missing"])
  test(`Retry recovers ${scenario} and persists after reload`, async ({ page }) => {
    const workflow = scenario === "workflow_permission_missing";
    const retryLabel = workflow ? "Retry publication" : "Retry";
    let goal = {
      id: randomUUID(),
      ownerId: "fixture",
      repository: "fixture/project",
      name: "Retry fixture",
      prompt: "Finish the task",
      attemptCount: 1,
      state: workflow ? "needs_attention" : scenario,
      createdAt: "2026-10-14T00:00:00Z",
      updatedAt: "2026-10-14T00:00:00Z",
      mode: "live",
      stopRequested: null,
      pullRequest: null,
      error: (workflow
        ? "Automatic publication recovery stopped: workflow_permission_missing (.github/workflows/ci-deploy.yml). Saved work retained; no new model attempt. Failure reference: db3a91ad-09c8-44ea-a2d8-f002570936cf"
        : "Synthetic attempt failure") as string | null,
    };
    let retries = 0;
    const json = (body: unknown) => ({
      contentType: "application/json",
      body: JSON.stringify(body),
    });
    await page.route("**/api/health", (r) => r.fulfill(json({ mode: "live" })));
    await page.route("**/api/session", (r) =>
      r.fulfill(json({ mode: "live", user: { id: "fixture", login: "fixture" } })),
    );
    await page.route("**/api/goals", (r) => r.fulfill(json([goal])));
    await page.route("**/api/goals/*/events**", (r) => r.fulfill(json([])));
    await page.route(`**/api/goals/*/${workflow ? "retry-publication" : "retry"}`, async (r) => {
      retries++;
      if (retries === 1)
        return r.fulfill({
          status: 503,
          ...json({ error: "Temporarily unavailable. Try again." }),
        });
      goal = { ...goal, state: "queued", error: null };
      return r.fulfill(json(goal));
    });
    await page.goto("/");
    await expect(page.getByText("Synthetic attempt failure")).toHaveCount(0);
    await page.getByRole("button", { name: /Retry fixture/ }).click();
    const details = page.getByRole("region", { name: "Selected project" });
    if (workflow) {
      await expect(details.getByRole("alert")).toContainText("Workflows: Read and write");
      await expect(details.getByRole("alert")).toContainText(".github/workflows/ci-deploy.yml");
      await expect(details.getByRole("alert")).not.toContainText("Retrying automatically");
      await details.getByText("Error reference", { exact: true }).click();
      await expect(
        details.getByText("db3a91ad-09c8-44ea-a2d8-f002570936cf", { exact: true }),
      ).toBeVisible();
    }
    await details.getByRole("button", { name: retryLabel, exact: true }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "Temporarily unavailable" }),
    ).toBeVisible();
    await expect(details.getByRole("button", { name: retryLabel, exact: true })).toBeEnabled();
    await details.getByRole("button", { name: retryLabel, exact: true }).click();
    await expect(details.getByText("Queued", { exact: true })).toBeVisible();
    await expect(details.getByText("Synthetic attempt failure")).toHaveCount(0);
    await expect(details.getByRole("button", { name: retryLabel, exact: true })).toHaveCount(0);
    await page.reload();
    await expect(details.getByText("Queued", { exact: true })).toBeVisible();
    expect(retries).toBe(2);
  });

for (const canRetry of [true, false])
  test(`Failed PR repair offers retry only when safe: ${canRetry}`, async ({ page }) => {
    const repairId = randomUUID();
    const pr = {
      url: "https://github.com/fixture/project/pull/123",
      number: 123,
      state: "open",
      branch: "repair",
      draft: true,
    };
    let goal = {
      id: randomUUID(),
      ownerId: "fixture",
      repository: "fixture/project",
      name: "Repair fixture",
      prompt: "Fix tests",
      attemptCount: 1,
      state: "awaiting_review",
      createdAt: "2026-10-14T00:00:00Z",
      updatedAt: "2026-10-14T00:00:00Z",
      mode: "live",
      stopRequested: null,
      error: null,
      pullRequest: pr,
      pullRequests: [pr],
      attempts: [
        {
          id: randomUUID(),
          number: 1,
          state: "awaiting_review",
          createdAt: "2026-10-14T00:00:00Z",
          pullRequest: pr,
          ciRepair: { id: repairId, state: "failed", canRetry },
        },
      ],
    };
    const json = (body: unknown) => ({
      contentType: "application/json",
      body: JSON.stringify(body),
    });
    await page.route("**/api/health", (r) => r.fulfill(json({ mode: "live" })));
    await page.route("**/api/session", (r) =>
      r.fulfill(json({ mode: "live", user: { id: "fixture", login: "fixture" } })),
    );
    await page.route("**/api/goals", (r) => r.fulfill(json([goal])));
    await page.route("**/api/goals/*/events**", (r) => r.fulfill(json([])));
    let retries = 0;
    await page.route("**/api/goals/*/retry-repair", (r) => {
      expect(r.request().postDataJSON()).toEqual({ repairId });
      retries++;
      goal = {
        ...goal,
        attempts: goal.attempts.map((attempt) => ({
          ...attempt,
          ciRepair: { id: randomUUID(), state: "waiting", canRetry: false },
        })),
      };
      return r.fulfill(json(goal));
    });
    await page.goto("/");
    await page.getByRole("button", { name: /Repair fixture/ }).click();
    await expect(page.getByText("Repair failed for PR #123.")).toBeVisible();
    const retry = page.getByRole("button", { name: "Retry repair", exact: true });
    if (!canRetry) {
      await expect(retry).toHaveCount(0);
      return;
    }
    await retry.click();
    await expect(retry).toHaveCount(0);
    await page.reload();
    await expect(retry).toHaveCount(0);
    expect(retries).toBe(1);
  });
