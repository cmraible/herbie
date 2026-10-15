import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";

for (const state of ["failed", "needs_attention"])
  test(`Retry recovers a ${state} goal and persists after reload`, async ({ page }) => {
    let goal = {
      id: randomUUID(),
      ownerId: "fixture",
      repository: "fixture/project",
      name: "Retry fixture",
      prompt: "Finish the task",
      attemptCount: 1,
      state,
      createdAt: "2026-10-14T00:00:00Z",
      updatedAt: "2026-10-14T00:00:00Z",
      mode: "live",
      stopRequested: null,
      pullRequest: null,
      error: "Synthetic attempt failure" as string | null,
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
    await page.route("**/api/goals/*/retry", async (r) => {
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
    await page.getByRole("button", { name: /Retry fixture/ }).click();
    const details = page.getByRole("region", { name: "Selected project" });
    await details.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "Temporarily unavailable" }),
    ).toBeVisible();
    await expect(details.getByRole("button", { name: "Retry", exact: true })).toBeEnabled();
    await details.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(details.getByText("Queued", { exact: true })).toBeVisible();
    await expect(details.getByText("Synthetic attempt failure")).toHaveCount(0);
    await expect(details.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
    await page.reload();
    await expect(details.getByText("Queued", { exact: true })).toBeVisible();
    expect(retries).toBe(2);
  });
