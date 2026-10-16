import { test, expect } from "@playwright/test";

test("activity feed shows clear run progress and hides internal system events", async ({
  page,
}) => {
  const goalId = "00000000-0000-4000-8000-000000000001";
  const runId = "00000000-0000-4000-8000-000000000002";
  const pullRequest = {
    number: 42,
    branch: "herbie/run-1",
    url: "https://github.com/owner/repo/pull/42",
    state: "open",
  };
  const rawFailure =
    "Attempt failed (runtime_preparation: command_failed; exit 28). Sandbox deletion confirmed. No automatic retry. Reference: db3a91ad-09c8-44ea-a2d8-f002570936cf";
  const goal = {
    id: goalId,
    ownerId: "fixture",
    repository: "owner/repo",
    name: "Clear activity messages",
    prompt: "Improve the activity feed",
    mode: "live",
    state: "awaiting_review",
    attemptCount: 1,
    createdAt: "2026-10-15T00:00:00Z",
    updatedAt: "2026-10-15T00:00:00Z",
    stopRequested: null,
    error: null,
    pullRequest,
    pullRequests: [pullRequest],
    attempts: [
      {
        id: runId,
        number: 1,
        state: "awaiting_review",
        createdAt: "2026-10-15T00:00:00Z",
        pullRequest,
      },
    ],
  };
  const messages = [
    ["queued", "Run #1 queued"],
    ["attempt_started", "Run #1 started"],
    ["attempt", "Attempt stage: sandbox_creation"],
    ["attempt", "Attempt stage: repository_clone"],
    ["attempt", "Attempt stage: model_execution"],
    ["attempt", "Goal completed in sandbox abc123"],
    ["failed", rawFailure],
    ["publication_phase", "Publication phase: state_persistence"],
    ["pull_request_opened", "Pull request #42 awaits review"],
    [
      "pull_request_ready",
      "Pull request #42 is ready for review: https://github.com/owner/repo/pull/42",
    ],
  ].map(([type, message], index) => ({
    id: index + 1,
    goalId,
    attemptId: runId,
    type,
    message,
    createdAt: "2026-10-15T00:00:00Z",
  }));
  const json = (body: unknown) => ({ contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/api/health", (route) => route.fulfill(json({ mode: "live" })));
  await page.route("**/api/session", (route) =>
    route.fulfill(json({ mode: "live", user: { id: "fixture", login: "fixture" } })),
  );
  await page.route("**/api/goals", (route) => route.fulfill(json([goal])));
  await page.route("**/api/goals/*/events**", (route) => route.fulfill(json(messages)));
  await page.goto(`/#${goalId}`);

  await expect(page.getByRole("region", { name: "Selected project" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Clear activity messages" })).toBeVisible();
  await page.getByRole("link", { name: /Run 1/ }).click();
  for (const text of [
    "Run #1 queued",
    "Run #1 started",
    "Preparing the agent's environment",
    "Cloning owner/repo",
    "Agent started working",
    "Preparing pull request",
    "Pull request #42 opened",
    "Run failed. No patches were saved.",
  ])
    await expect(page.getByText(text, { exact: true })).toBeVisible();
  const ready = page.getByRole("link", { name: "Pull request #42 is ready for review" });
  await expect(ready).toHaveAttribute("href", pullRequest.url);
  await expect(page.getByText("Attempt stage: sandbox_creation")).toHaveCount(0);
  await expect(page.getByText("Publication phase: state_persistence")).toHaveCount(0);
  await expect(page.getByText(rawFailure)).toHaveCount(0);
  await page.getByText("Error reference").click();
  await expect(page.getByText("db3a91ad-09c8-44ea-a2d8-f002570936cf")).toBeVisible();
  await expect(page.getByText(rawFailure)).toHaveCount(0);
});
