import { test, expect, type WebSocketRoute } from "@playwright/test";

test("pushes PR and run updates without polling and reconnects without duplicate events", async ({
  page,
}) => {
  const id = "00000000-0000-4000-8000-000000000001";
  const pr = {
    number: 42,
    branch: "herbie/run",
    state: "open",
    url: "https://github.com/owner/repo/pull/42",
  };
  const goal = {
    id,
    ownerId: "fixture",
    repository: "owner/repo",
    name: "Live project",
    prompt: "Push updates",
    mode: "live",
    state: "awaiting_review",
    attemptCount: 1,
    createdAt: "2026-10-15T00:00:00Z",
    updatedAt: "2026-10-15T00:00:00Z",
    stopRequested: null,
    error: null,
    pullRequest: pr,
    pullRequests: [pr],
    attempts: [
      {
        id,
        number: 1,
        state: "awaiting_review",
        createdAt: "2026-10-15T00:00:00Z",
        pullRequest: pr,
      },
    ],
  };
  const event = {
    id: 1,
    goalId: id,
    attemptId: id,
    type: "attempt",
    message: "Attempt stage: model_execution",
    createdAt: goal.createdAt,
  };
  const events = [event];
  const json = (body: unknown) => ({ contentType: "application/json", body: JSON.stringify(body) });
  let goalReads = 0;
  let eventReads = 0;
  await page.route("**/api/health", (route) => route.fulfill(json({ mode: "live" })));
  await page.route("**/api/session", (route) =>
    route.fulfill(json({ mode: "live", user: { id: "fixture", login: "fixture" } })),
  );
  await page.route("**/api/repositories", (route) =>
    route.fulfill(json({ repositories: [], permissionsRequired: false })),
  );
  await page.route("**/api/goals", (route) => {
    goalReads++;
    return route.fulfill(json([goal]));
  });
  await page.route("**/api/goals/*/events**", (route) => {
    eventReads++;
    return route.fulfill(json([]));
  });
  let stream: WebSocketRoute | undefined;
  let connections = 0;
  await page.routeWebSocket("**/api/stream**", (socket) => {
    stream = socket;
    connections++;
    socket.send(JSON.stringify({ type: "goals", goals: [goal] }));
    socket.send(JSON.stringify({ type: "events", goalId: id, events }));
  });
  await page.goto(`/#${id}`);
  await expect(page.getByRole("heading", { name: "Live project" })).toBeVisible();
  await expect(page.getByText("Agent started working", { exact: true })).toHaveCount(1);
  await expect.poll(() => connections).toBe(1);
  const activity = (method: string, params: Record<string, unknown>) => ({
    ...event,
    id: events.length + 1,
    type: "agent",
    message: JSON.stringify({ method, params: { threadId: "thread", turnId: "turn", ...params } }),
  });
  events.push(
    activity("item/reasoning/summaryTextDelta", {
      itemId: "thinking",
      delta: "Checking the implementation",
    }),
  );
  events.push(
    activity("item/started", {
      item: { id: "command", type: "commandExecution", command: "pnpm test", status: "inProgress" },
    }),
  );
  events.push(
    activity("item/commandExecution/outputDelta", { itemId: "command", delta: "All tests passed" }),
  );
  events.push(
    activity("item/agentMessage/delta", {
      itemId: "message",
      delta: "Implemented <script>alert(1)</script> safely",
    }),
  );
  stream!.send(JSON.stringify({ type: "events", goalId: id, events }));
  await expect(page.getByText("Checking the implementation", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Implemented <script>alert(1)</script> safely", { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator(".agent-transcript pre").filter({ hasText: "All tests passed" }),
  ).toBeVisible();
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download transcript" }).click();
  const download = await downloaded;
  const contents = await download.createReadStream();
  let text = "";
  for await (const chunk of contents!) text += chunk.toString();
  expect(
    text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
  ).toHaveLength(4);
  goal.name = "Merged project";
  pr.state = "merged";
  goal.attempts[0]!.state = "completed";
  stream!.send(JSON.stringify({ type: "goals", goals: [goal] }));
  await expect(page.getByRole("heading", { name: "Merged project" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Run 1.*Merged/ })).toBeVisible();
  stream!.close({ code: 1012, reason: "Service restart" });
  await expect.poll(() => connections).toBe(2);
  await expect(page.getByText("Agent started working", { exact: true })).toHaveCount(1);
  await expect(page.getByText("Checking the implementation", { exact: true })).toHaveCount(1);
  await expect(
    page.getByText("Implemented <script>alert(1)</script> safely", { exact: true }),
  ).toHaveCount(1);
  // Exceed both former polling intervals.
  await page.waitForTimeout(2500);
  expect(goalReads).toBe(1);
  expect(eventReads).toBe(1);
  await page.route("**/api/session", (route) =>
    route.fulfill({ status: 401, ...json({ error: "Login required" }) }),
  );
  stream!.close({ code: 1006 });
  await expect(page.getByRole("button", { name: /Continue with GitHub/ })).toBeVisible();
});
