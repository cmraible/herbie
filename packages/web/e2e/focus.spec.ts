import { test, expect, type WebSocketRoute } from "@playwright/test";
import { projectSchema } from "@herbie/contracts";

test("focus prioritizes personal attention tasks and advances on retry, merge, and close", async ({
  page,
}) => {
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const project = projectSchema.parse({
    id: id(1),
    ownerId: "fixture",
    repository: "owner/repo",
    name: "Review changes",
    prompt: "Make changes",
    mode: "live",
    state: "awaiting_review",
    attemptCount: 3,
    createdAt: "2026-10-15",
    updatedAt: "2026-10-15",
    stopRequested: null,
    error: null,
    pullRequest: null,
    attempts: [1, 2, 3].map((n) => ({
      id: id(n + 10),
      number: n,
      state: "awaiting_review",
      createdAt: `2026-10-${15 + n}`,
      pullRequest: {
        number: n,
        branch: `run-${n}`,
        title: `Change ${n}`,
        state: "open",
        url: `https://github.com/owner/repo/pull/${n}`,
        draft: false,
        checksPassed: n !== 3,
      },
    })),
  });
  const attention = projectSchema.parse({
    ...project,
    id: id(2),
    name: "Fix failed run",
    state: "needs_attention",
    attempts: [
      {
        id: id(20),
        number: 1,
        state: "needs_attention",
        createdAt: "2026-10-18",
        pullRequest: null,
      },
    ],
  });
  const foreign = { ...attention, id: id(3), ownerId: "someone-else", name: "Someone else's work" };
  const projects = [project, foreign, attention];
  const json = (body: unknown) => ({ contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/api/health", (route) => route.fulfill(json({ mode: "live" })));
  await page.route("**/api/session", (route) =>
    route.fulfill(json({ mode: "live", user: { id: "fixture", login: "fixture" } })),
  );
  await page.route("**/api/repositories", (route) =>
    route.fulfill(json({ repositories: [], permissionsRequired: false })),
  );
  await page.route("**/api/projects", (route) => route.fulfill(json(projects)));
  await page.route("**/api/projects/*/events**", (route) => route.fulfill(json([])));
  await page.route("**/api/projects/*/retry", (route) => {
    attention.state = "running";
    attention.attempts![0]!.state = "running";
    return route.fulfill(json(attention));
  });
  let stream: WebSocketRoute;
  await page.routeWebSocket("**/api/stream**", (socket) => {
    stream = socket;
    socket.send(JSON.stringify({ type: "projects", projects }));
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Focus mode", exact: true }).click();
  await expect(page.getByText("3 tasks remaining")).toBeVisible();
  await expect(page.getByText(/owner\/repo · Fix failed run/)).toBeVisible();
  await expect(page.locator(".app-header")).toHaveCount(0);
  await expect(page.locator(".version-footer")).toHaveCount(0);
  await page.getByRole("button", { name: "Next task", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Change 1 · #1" })).toBeVisible();
  await page.getByRole("button", { name: "Next task", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Change 2 · #2" })).toBeVisible();
  await page.getByRole("button", { name: "Next task", exact: true }).click();
  await expect(page.getByText(/owner\/repo · Fix failed run/)).toBeVisible();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Change 1 · #1" })).toBeVisible();
  await expect(page.getByText("2 tasks remaining")).toBeVisible();
  await page.screenshot({ path: "test-results/focus-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Exit focus mode" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/focus-mobile.png", fullPage: true });
  // New attention work must not interrupt the PR currently being reviewed.
  attention.state = "needs_attention";
  attention.attempts![0]!.state = "needs_attention";
  stream!.send(JSON.stringify({ type: "projects", projects }));
  await expect(page.getByText("3 tasks remaining")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Change 1 · #1" })).toBeVisible();
  project.attempts![0]!.pullRequest!.state = "merged";
  stream!.send(JSON.stringify({ type: "projects", projects }));
  await expect(page.getByText(/owner\/repo · Fix failed run/)).toBeVisible();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Change 2 · #2" })).toBeVisible();
  project.attempts![1]!.pullRequest!.state = "closed";
  stream!.send(JSON.stringify({ type: "projects", projects }));
  await expect(page.getByRole("heading", { name: "You’re all caught up" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".app-header")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
});
