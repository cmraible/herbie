import type { Plugin } from "vite";
import { randomUUID } from "node:crypto";
import { goalInput, goalUpdate, type Goal, type GoalEvent, type Attempt } from "@herbie/contracts";

const repository = "acme/storefront";
const date = (hour: number, minute = 0) =>
  new Date(Date.UTC(2026, 9, 15, hour, minute)).toISOString();
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const previewGoalId = id(1);

function fixtures() {
  const attempts: Attempt[] = [
    {
      id: id(101),
      number: 1,
      state: "completed",
      createdAt: date(13),
      pullRequest: {
        number: 142,
        branch: "fix/email-validation",
        state: "merged",
        url: "https://github.com/acme/storefront/pull/142",
      },
    },
    { id: id(102), number: 2, state: "failed", createdAt: date(14), pullRequest: null },
    {
      id: id(103),
      number: 3,
      state: "awaiting_review",
      createdAt: date(15),
      pullRequest: {
        number: 148,
        branch: "fix/signup-error-messages",
        state: "open",
        url: "https://github.com/acme/storefront/pull/148",
      },
    },
  ];
  const base: Goal = {
    id: previewGoalId,
    ownerId: "local-preview",
    repository,
    name: "Make signup errors helpful",
    prompt:
      "Validate email addresses before submitting the signup form. Show clear, actionable errors next to each field, preserve entered values after a failed submission, and add coverage for the common failure cases.",
    maxWip: 1,
    attemptCount: 3,
    mode: "live",
    state: "awaiting_review",
    stopRequested: null,
    createdAt: date(12, 45),
    updatedAt: date(15, 18),
    error: null,
    cleanupStatus: "not_required",
    attempts,
    pullRequest: attempts[2]!.pullRequest,
    pullRequests: attempts.flatMap((a) => (a.pullRequest ? [a.pullRequest] : [])),
  };
  const goals: Goal[] = [
    base,
    {
      ...base,
      id: id(2),
      name: "Speed up product search",
      prompt:
        "Reduce repeated database queries on the search results page and add a regression test for query count.",
      state: "running",
      attemptCount: 1,
      attempts: [
        { id: id(201), number: 1, state: "running", createdAt: date(15, 20), pullRequest: null },
      ],
      pullRequest: null,
      pullRequests: [],
    },
    {
      ...base,
      id: id(3),
      name: "Improve keyboard navigation",
      prompt:
        "Make the cart drawer accessible by keyboard, including focus restoration when it closes.",
      state: "paused",
      attemptCount: 1,
      attempts: [
        { id: id(301), number: 1, state: "ready", createdAt: date(14, 30), pullRequest: null },
      ],
      pullRequest: null,
      pullRequests: [],
    },
    {
      ...base,
      id: id(4),
      name: "Refresh the checkout layout",
      prompt: "Simplify the checkout summary and make shipping costs visible before payment.",
      state: "cancelled",
      attemptCount: 1,
      attempts: [
        { id: id(401), number: 1, state: "cancelled", createdAt: date(13, 30), pullRequest: null },
      ],
      pullRequest: null,
      pullRequests: [],
    },
  ];
  let sequence = 0;
  const events: GoalEvent[] = [];
  const log = (
    goalId: string,
    attemptId: string | null,
    type: string,
    message: string,
    createdAt = new Date().toISOString(),
  ) => events.push({ id: ++sequence, goalId, attemptId, type, message, createdAt });
  log(base.id, null, "queued", "Goal created", date(12, 45));
  for (const a of attempts) {
    const hour = 12 + a.number;
    log(base.id, a.id, "attempt_started", `Attempt ${a.number} started`, date(hour));
    log(
      base.id,
      a.id,
      "attempt",
      "Reviewed the signup form, validation helpers, and existing tests.",
      date(hour, 2),
    );
    if (a.number === 2) {
      log(
        base.id,
        a.id,
        "attempt",
        "Added coverage for expired invitations and duplicate email addresses.",
        date(hour, 6),
      );
      log(
        base.id,
        a.id,
        "failed",
        "The integration suite could not connect to its test database. No pull request was opened.",
        date(hour, 9),
      );
    } else {
      log(
        base.id,
        a.id,
        "attempt",
        a.number === 1
          ? "Added email validation and kept field values intact after submission errors."
          : "Replaced generic error messages with field-specific guidance and added focus handling.",
        date(hour, 7),
      );
      log(
        base.id,
        a.id,
        "attempt",
        "Validation passed: 24 unit tests, 6 browser tests, and type checking.",
        date(hour, 12),
      );
      log(
        base.id,
        a.id,
        "pull_request_opened",
        `Opened pull request #${a.pullRequest!.number}.`,
        date(hour, 15),
      );
      if (a.number === 1)
        log(
          base.id,
          a.id,
          "pull_request_merged",
          "Pull request #142 merged into main.",
          date(hour, 25),
        );
      else
        log(
          base.id,
          a.id,
          "pull_request_ready",
          "All checks passed. Ready for review.",
          date(hour, 18),
        );
    }
  }
  for (const g of goals.slice(1)) {
    log(
      g.id,
      g.attempts![0]!.id,
      "attempt_started",
      "Attempt 1 started",
      g.attempts![0]!.createdAt,
    );
    log(
      g.id,
      g.attempts![0]!.id,
      g.state,
      g.state === "running"
        ? "Inspecting the search query and measuring repeated lookups."
        : g.state === "paused"
          ? "Changes saved. Waiting for the goal to resume."
          : "Attempt stopped after the goal was cancelled.",
      date(15, 25),
    );
  }
  return { goals, events, log };
}

// Local development transport only. Fixture mutations remain in memory and reset on restart.
export function fixtureApi(): Plugin {
  const { goals, events, log } = fixtures();
  return {
    name: "herbie-ui-fixtures",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url ?? "/", "http://localhost");
        if (!url.pathname.startsWith("/api/")) return next();
        const send = (body: unknown, status = 200) => {
          response.statusCode = status;
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify(body));
        };
        try {
          if (url.pathname === "/api/health") return send({ mode: "live" });
          if (url.pathname === "/api/session")
            return send({ mode: "live", user: { id: "local-preview", login: "chris" } });
          if (url.pathname === "/api/repositories")
            return send([{ fullName: repository, defaultBranch: "main", installationId: 1 }]);
          let body: unknown = {};
          if (request.method === "POST") {
            let raw = "";
            for await (const chunk of request) raw += chunk;
            body = JSON.parse(raw || "{}");
          }
          if (url.pathname === "/api/goals") {
            if (request.method === "GET") return send(goals);
            const input = goalInput.parse(body);
            const now = new Date().toISOString();
            const goal: Goal = {
              ...input,
              id: randomUUID(),
              name: input.name ?? input.prompt.split(/[.!?\n]/)[0]!.slice(0, 80),
              ownerId: "local-preview",
              mode: "live",
              state: "queued",
              attemptCount: 0,
              attempts: [],
              pullRequest: null,
              pullRequests: [],
              stopRequested: null,
              createdAt: now,
              updatedAt: now,
              cleanupStatus: "not_required",
              error: null,
            };
            goals.unshift(goal);
            log(goal.id, null, "queued", "Goal created");
            return send(goal);
          }
          const match = /^\/api\/goals\/([^/]+)(?:\/(\w+))?$/.exec(url.pathname);
          const goal = goals.find((g) => g.id === match?.[1]);
          if (!goal) return send({ error: "Not found" }, 404);
          const action = match?.[2];
          if (action === "events")
            return send(
              events.filter(
                (e) => e.goalId === goal.id && e.id > Number(url.searchParams.get("after") ?? 0),
              ),
            );
          if (request.method === "GET") return send(goal);
          if (goal.state === "cancelled")
            return send({ error: "Cancelled goals cannot be edited" }, 409);
          if (!action) Object.assign(goal, goalUpdate.parse(body));
          else if (action === "pause") goal.state = "paused";
          else if (action === "resume" || action === "retry") goal.state = "queued";
          else if (action === "cancel") {
            goal.state = "cancelled";
            for (const attempt of goal.attempts ?? [])
              if (!["completed", "failed"].includes(attempt.state)) attempt.state = "cancelled";
          } else return send({ error: "Not available in this preview" }, 404);
          goal.updatedAt = new Date().toISOString();
          log(
            goal.id,
            null,
            action ?? "updated",
            action ? `Goal ${goal.state}` : "Goal settings updated",
          );
          return send(goal);
        } catch {
          return send({ error: "Invalid request" }, 400);
        }
      });
    },
  };
}
