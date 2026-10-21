import type { Plugin } from "vite";
import { randomUUID } from "node:crypto";
import {
  projectInput,
  projectUpdate,
  type Project,
  type ProjectEvent,
  type Attempt,
} from "@herbie/contracts";

const repository = "acme/storefront";
const date = (hour: number, minute = 0) =>
  new Date(Date.UTC(2026, 9, 15, hour, minute)).toISOString();
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const previewProjectId = id(1);

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
        draft: false,
        checksPassed: true,
        branch: "fix/signup-error-messages",
        state: "open",
        url: "https://github.com/acme/storefront/pull/148",
      },
    },
  ];
  const base: Project = {
    id: previewProjectId,
    ownerId: "local-preview",
    repository,
    name: "Make signup errors helpful",
    prompt:
      "Validate email addresses before submitting the signup form. Show clear, actionable errors next to each field, preserve entered values after a failed submission, and add coverage for the common failure cases.",
    resources: null,
    workflow: "loop",
    targetWip: 1,
    model: "gpt-6-luna",
    reasoningEffort: "low",
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
  const projects: Project[] = [
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
  const events: ProjectEvent[] = [];
  const log = (
    projectId: string,
    attemptId: string | null,
    type: string,
    message: string,
    createdAt = new Date().toISOString(),
  ) => events.push({ id: ++sequence, projectId, attemptId, type, message, createdAt });
  log(base.id, null, "queued", "Run #1 queued", date(12, 45));
  for (const a of attempts) {
    const hour = 12 + a.number;
    log(base.id, a.id, "attempt_started", `Run #${a.number} started`, date(hour));
    log(base.id, a.id, "attempt", "Attempt stage: repository_clone", date(hour, 2));
    log(base.id, a.id, "attempt", "Attempt stage: model_execution", date(hour, 3));
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
      log(base.id, a.id, "attempt", "Project completed in sandbox preview", date(hour, 7));
      log(base.id, a.id, "attempt", "Publication phase: state_persistence", date(hour, 12));
      log(
        base.id,
        a.id,
        "pull_request_opened",
        `Pull request #${a.pullRequest!.number} awaits review: ${a.pullRequest!.url}`,
        date(hour, 15),
      );
      if (a.number === 1)
        log(base.id, a.id, "pull_request_merged", "Pull request #142 merged.", date(hour, 25));
      else
        log(
          base.id,
          a.id,
          "pull_request_ready",
          `Pull request #${a.pullRequest!.number} is ready for review: ${a.pullRequest!.url}`,
          date(hour, 18),
        );
    }
  }
  for (const g of projects.slice(1)) {
    log(g.id, g.attempts![0]!.id, "attempt_started", "Run #1 started", g.attempts![0]!.createdAt);
    log(
      g.id,
      g.attempts![0]!.id,
      "attempt",
      g.state === "running"
        ? "Attempt stage: model_execution"
        : g.state === "paused"
          ? "Project completed in sandbox preview"
          : "Attempt stage: sandbox_deletion",
      date(15, 25),
    );
  }
  return { projects, events, log };
}

// Local development transport only. Fixture mutations remain in memory and reset on restart.
export function fixtureApi(): Plugin {
  const { projects, events, log } = fixtures();
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
          if (url.pathname === "/api/reasoning-efforts") return send(["low", "medium", "high"]);
          if (url.pathname === "/api/environment-limits")
            return send({ cpu: 8, memory: 16, disk: 30 });
          if (url.pathname === "/api/models") return send(["gpt-6-luna", "gpt-6-astra"]);
          if (url.pathname === "/api/repositories")
            return send([{ fullName: repository, defaultBranch: "main", installationId: 1 }]);
          let body: unknown = {};
          if (request.method === "POST") {
            let raw = "";
            for await (const chunk of request) raw += chunk;
            body = JSON.parse(raw || "{}");
          }
          if (url.pathname === "/api/projects") {
            if (request.method === "GET") return send(projects);
            const input = projectInput.parse(body);
            const now = new Date().toISOString();
            const project: Project = {
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
            projects.unshift(project);
            log(project.id, null, "queued", "Run #1 queued");
            return send(project);
          }
          const match = /^\/api\/projects\/([^/]+)(?:\/(\w+))?$/.exec(url.pathname);
          const project = projects.find((g) => g.id === match?.[1]);
          if (!project) return send({ error: "Not found" }, 404);
          const action = match?.[2];
          if (action === "events")
            return send(
              events.filter(
                (e) =>
                  e.projectId === project.id && e.id > Number(url.searchParams.get("after") ?? 0),
              ),
            );
          if (request.method === "GET") return send(project);
          if (project.state === "cancelled")
            return send({ error: "Cancelled projects cannot be edited" }, 409);
          if (!action) Object.assign(project, projectUpdate.parse(body));
          else if (action === "pause") project.state = "paused";
          else if (action === "resume" || action === "retry") project.state = "queued";
          else if (action === "cancel") {
            project.state = "cancelled";
            for (const attempt of project.attempts ?? [])
              if (!["completed", "failed"].includes(attempt.state)) attempt.state = "cancelled";
          } else return send({ error: "Not available in this preview" }, 404);
          project.updatedAt = new Date().toISOString();
          log(
            project.id,
            null,
            action ?? "updated",
            action ? `Project ${project.state}` : "Project settings updated",
          );
          return send(project);
        } catch {
          return send({ error: "Invalid request" }, 400);
        }
      });
    },
  };
}
