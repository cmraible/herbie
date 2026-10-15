import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
for (const state of ["queued", "running", "paused", "awaiting_review", "needs_attention"])
  test(`Cancel is available for ${state} with unresolved cleanup`, async ({ page }) => {
    let goal = {
      id: randomUUID(),
      ownerId: "fixture",
      repository: "fixture/project",
      name: "Synthetic cancellation fixture",
      prompt: "Synthetic cancellation fixture",
      attemptCount: 1,
      state,
      createdAt: "2026-10-14T00:00:00Z",
      updatedAt: "2026-10-14T00:00:00Z",
      mode: "live",
      stopRequested: null,
      pullRequest: null,
      error: state === "needs_attention" ? "Publication remains unconfirmed" : null,
      cleanupStatus: "not_required",
    };
    let cancels = 0;
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
    await page.route("**/api/goals/*/events**", (r) => r.fulfill(json([])));
    await page.route("**/api/goals/*/cancel", (r) => {
      cancels++;
      goal = { ...goal, state: "cancelled", cleanupStatus: "needs_attention" };
      return r.fulfill(json(goal));
    });
    await page.goto("/");
    await page.getByRole("button", { name: /Synthetic cancellation fixture/ }).click();
    const details = page.getByRole("region", { name: "Selected goal" });
    await expect(details.getByRole("button", { name: "Cancel goal" })).toBeEnabled();
    await details.getByRole("button", { name: "Cancel goal" }).click();
    await expect(details.getByText("Cancelled", { exact: true })).toBeVisible();
    await expect(
      details.getByRole("status").filter({ hasText: "Cleanup needs attention" }),
    ).toContainText("Remote work may remain. Cleanup needs attention; your goal stays cancelled.");
    await expect(details.getByRole("button", { name: "Cancel goal" })).toHaveCount(0);
    await page.reload();
    await expect(details.getByText("Cancelled", { exact: true })).toBeVisible();
    expect(cancels).toBe(1);
  });
