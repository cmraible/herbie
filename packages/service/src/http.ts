import { EnvironmentLimitsError, validateEnvironmentResources } from "./environment-limits.js";
import { createReasoningEffortLister } from "./reasoning-efforts.js";
import { attachRealtime } from "./realtime.js";
import { logFailure } from "./diagnostic-log.js";
import { runningVersion } from "./version.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  actionSchema,
  projectUpdate,
  projectInput,
  projectPromptEdit,
  projectRename,
  type Project,
} from "@herbie/contracts";
import { hasValidPublicationEvidence } from "@herbie/loop/publish-patch";
import { Store, StoreError } from "./store.js";
import { AuthError, type Auth, type createAuth } from "./auth.js";
import { GithubError } from "./github.js";
import type { Adapters } from "./adapters.js";
import { reconcileReviews } from "./worker.js";
import { cliConsentPage, cliConsentResult, consentCsp } from "./cli-consent-page.js";

interface ApiOptions {
  store: Store;
  auth: Auth;
  adapters: Adapters;
  publicUrl: string;
  executionEnabled?: boolean;
  deploymentId?: string;
  imageRevision?: string;
  verifyWebhook?: (body: Buffer, signature: string) => boolean;
  webDirectory?: string;
  listReasoningEfforts?: (model: string) => Promise<string[]>;
  listModels?: () => Promise<string[]>;
}
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
const clientInput = z.object({ client: z.enum(["web", "cli"]).default("web") });
function cookie(request: IncomingMessage, name: string): string | undefined {
  return request.headers.cookie
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}
function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}
async function body(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const data: unknown = chunk;
    if (!Buffer.isBuffer(data)) throw new HttpError(400, "Invalid request body");
    length += data.length;
    if (length > 65_536) throw new HttpError(413, "Request body too large");
    chunks.push(data);
  }
  return Buffer.concat(chunks);
}
async function readJson(request: IncomingMessage): Promise<unknown> {
  const raw = await body(request);
  if (!raw.length) return {};
  if (!request.headers["content-type"]?.startsWith("application/json"))
    throw new HttpError(415, "Use application/json");
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}
export function createApiServer(options: ApiOptions) {
  const listReasoningEfforts = options.listReasoningEfforts ?? createReasoningEffortLister();
  const { store, auth, adapters } = options;
  const version = runningVersion(options.deploymentId, options.imageRevision);
  const legacy = "start" in auth ? (auth as ReturnType<typeof createAuth>) : undefined;
  const executionEnabled = options.executionEnabled ?? true;
  function requireExecution() {
    if (!executionEnabled) throw new HttpError(503, "Live runs aren't configured yet");
  }
  const origin = new URL(options.publicUrl).origin;
  const secure = new URL(origin).protocol === "https:" ? "; Secure" : "";
  const approvalCookie = (token: string, maxAge = 600) =>
    `herbie_cli_approval=${token}; HttpOnly; SameSite=Lax; Path=/api/auth/cli; Max-Age=${maxAge}${secure}`;
  const sessionCookie = (token: string) =>
    `herbie_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${secure}`;
  const web = options.webDirectory ?? fileURLToPath(new URL("../../web/dist/", import.meta.url));
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    const styleNonce = randomBytes(16).toString("base64");
    response.setHeader(
      "content-security-policy",
      `default-src 'self'; style-src 'self' 'nonce-${styleNonce}'; img-src 'self' data:; script-src 'self'; connect-src 'self' ${origin.replace(/^http/, "ws")}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
    );
    const url = new URL(request.url ?? "/", origin);
    const method = request.method ?? "GET";
    function projectJson(status: number, value: Project | Project[]): void {
      json(response, status, value);
    }
    const bearer = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1];
    if (
      method !== "GET" &&
      method !== "HEAD" &&
      url.pathname !== "/api/webhooks/github" &&
      (!bearer || url.pathname === "/api/auth/cli")
    ) {
      // SameSite does not protect against another port on localhost or compromised sibling origins.
      if (request.headers.origin !== origin)
        throw new HttpError(403, "Request origin is not allowed");
    }
    if (
      auth.handleRequest &&
      (url.pathname.startsWith("/api/identity/") ||
        ["/api/auth/start", "/api/auth/poll", "/api/auth/cli", "/api/auth/callback"].includes(
          url.pathname,
        ))
    ) {
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
        else if (value !== undefined) headers.set(name, value);
      }
      const result = await auth.handleRequest(
        new Request(url, {
          method,
          headers,
          ...(method === "GET" || method === "HEAD"
            ? {}
            : { body: new Uint8Array(await body(request)) }),
        }),
      );
      result.headers.forEach((value, name) => {
        if (name !== "set-cookie") response.setHeader(name, value);
      });
      const cookies = result.headers.getSetCookie();
      if (cookies.length) response.setHeader("set-cookie", cookies);
      response.setHeader("cache-control", "no-store");
      response.writeHead(result.status);
      response.end(Buffer.from(await result.arrayBuffer()));
      return;
    }
    if (method === "GET" && url.pathname === "/api/version") {
      json(response, 200, version);
      return;
    }
    // Process liveness must not restart healthy workers during a database outage.
    if (method === "GET" && url.pathname === "/api/live") {
      json(response, 200, { alive: true });
      return;
    }
    if (method === "GET" && url.pathname === "/api/health") {
      try {
        await store.pool.query("SELECT 1");
      } catch (error) {
        const errorId = logFailure(error, { component: "health-database" });
        json(response, 503, { error: "Database unavailable", errorId });
        return;
      }
      json(response, 200, {
        mode: "live",
        executionEnabled,
        deploymentId: options.deploymentId,
        imageRevision: options.imageRevision,
      });
      return;
    }
    if (legacy && method === "POST" && url.pathname === "/api/auth/start") {
      const { client } = clientInput.parse(await readJson(request));
      const flow = await legacy.start(client);
      if (client === "web")
        response.setHeader(
          "set-cookie",
          `herbie_auth=${flow.browserState}; HttpOnly; SameSite=Lax; Path=/api/auth; Max-Age=600${secure}`,
        );
      json(response, 200, {
        url: flow.url,
        ...(flow.pollToken ? { pollToken: flow.pollToken, userCode: flow.userCode } : {}),
      });
      return;
    }
    if (legacy && method === "GET" && url.pathname === "/api/auth/callback") {
      const result = await legacy.callback(
        z.string().min(1).parse(url.searchParams.get("code")),
        z.string().min(1).parse(url.searchParams.get("state")),
        cookie(request, "herbie_auth"),
      );
      response.setHeader("cache-control", "no-store");
      if (result.client === "web") {
        response.setHeader("set-cookie", [
          sessionCookie(result.token),
          `herbie_auth=; HttpOnly; SameSite=Lax; Path=/api/auth; Max-Age=0${secure}`,
        ]);
        response.writeHead(303, { location: "/" });
        response.end();
      } else {
        response.setHeader("set-cookie", approvalCookie(result.approvalToken));
        response.writeHead(303, { location: "/api/auth/cli" });
        response.end();
      }
      return;
    }
    if (method === "GET" && url.pathname === "/api/auth/installation/callback") {
      const token = cookie(request, "herbie_session") ?? "";
      let status: "connected" | "permissions" | "cancelled" | "expired" | "failed";
      try {
        const state = z.string().min(1).max(200).parse(url.searchParams.get("state"));
        status = (
          await auth.finishInstallation(
            state,
            url.searchParams.get("installation_id"),
            url.searchParams.get("setup_action"),
            token,
          )
        ).status;
      } catch (error) {
        if (
          error instanceof z.ZodError ||
          (error instanceof AuthError && (error.status === 400 || error.status === 401))
        )
          status = "expired";
        else if (
          error instanceof GithubError &&
          (error.status === 401 || error.status === 403 || error.status === 404)
        )
          status = "failed";
        else throw error;
      }
      response.setHeader("cache-control", "no-store");
      const destination =
        status === "connected"
          ? "/?installation=connected"
          : status === "permissions"
            ? "/?installation=permissions"
            : status === "cancelled"
              ? "/?installation=cancelled"
              : status === "expired"
                ? "/?installation=expired"
                : "/?installation=failed";
      response.writeHead(303, { location: destination });
      response.end();
      return;
    }
    if (legacy && url.pathname === "/api/auth/cli" && (method === "GET" || method === "POST")) {
      const approvalToken = cookie(request, "herbie_cli_approval") ?? "";
      let html: string;
      if (method === "GET")
        html = cliConsentPage({ ...(await legacy.pendingCli(approvalToken)), origin });
      else {
        if (!request.headers["content-type"]?.startsWith("application/x-www-form-urlencoded"))
          throw new HttpError(415, "Use form submission");
        const fields = new URLSearchParams((await body(request)).toString("utf8"));
        const decision = z.enum(["approve", "reject"]).parse(fields.get("decision"));
        const csrfToken = z
          .string()
          .regex(/^[A-Za-z0-9_-]{43}$/)
          .parse(fields.get("csrfToken"));
        const userCode = z
          .string()
          .max(20)
          .optional()
          .parse(fields.get("userCode") ?? undefined);
        const result = await legacy.decideCli(approvalToken, csrfToken, decision, userCode);
        response.setHeader("set-cookie", approvalCookie("", 0));
        html = cliConsentResult(result.status === "approved");
      }
      response.setHeader("content-security-policy", consentCsp);
      // Preserve Origin on same-origin form POSTs while suppressing cross-origin referrers.
      response.setHeader("referrer-policy", "same-origin");
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(html);
      return;
    }
    if (legacy && method === "GET" && url.pathname === "/api/auth/poll") {
      json(
        response,
        200,
        await legacy.poll(z.string().min(20).max(200).parse(url.searchParams.get("token"))),
      );
      return;
    }
    if (method === "POST" && url.pathname === "/api/webhooks/github") {
      const payload = await body(request);
      const signature = request.headers["x-hub-signature-256"];
      if (typeof signature !== "string" || !options.verifyWebhook?.(payload, signature))
        throw new HttpError(401, "Invalid webhook signature");
      // Only trusted API reads drive transitions. Duplicate/out-of-order webhook bodies are harmless.
      if (request.headers["x-github-event"] === "pull_request")
        await reconcileReviews(store, adapters);
      if (
        executionEnabled &&
        adapters.mode === "live" &&
        ["check_run", "check_suite", "status", "pull_request"].includes(
          String(request.headers["x-github-event"]),
        )
      ) {
        const event = z
          .object({ repository: z.object({ full_name: z.string().regex(/^[\w.-]+\/[\w.-]+$/) }) })
          .safeParse(JSON.parse(payload.toString("utf8")));
        if (event.success) await store.requestCiReview(event.data.repository.full_name);
      }
      if (
        executionEnabled &&
        adapters.mode === "live" &&
        ["issue_comment", "pull_request_review_comment", "pull_request_review"].includes(
          String(request.headers["x-github-event"]),
        )
      ) {
        const event = z
          .object({
            repository: z.object({ full_name: z.string().regex(/^[\w.-]+\/[\w.-]+$/) }),
            issue: z.object({ pull_request: z.unknown().optional() }).optional(),
          })
          .safeParse(JSON.parse(payload.toString("utf8")));
        if (
          event.success &&
          (request.headers["x-github-event"] !== "issue_comment" || event.data.issue?.pull_request)
        )
          await store.requestFeedbackReview(event.data.repository.full_name);
      }
      json(response, 200, { ok: true });
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      const token = bearer ?? cookie(request, "herbie_session");
      const session = token ? await auth.session(token) : null;
      if (!session) throw new HttpError(401, "Login required");
      const userId = session.user.id;
      if (method === "POST" && url.pathname === "/api/auth/install/start") {
        json(response, 200, await auth.startInstallation(token ?? ""));
        return;
      }
      if (method === "GET" && url.pathname === "/api/session") {
        json(response, 200, session);
        return;
      }
      if (method === "POST" && url.pathname === "/api/auth/logout") {
        if (token) await auth.logout(token);
        response.setHeader(
          "set-cookie",
          `herbie_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`,
        );
        json(response, 200, { ok: true });
        return;
      }
      if (method === "GET" && url.pathname === "/api/reasoning-efforts") {
        const model = z.string().trim().min(1).max(200).safeParse(url.searchParams.get("model"));
        if (!model.success) throw new HttpError(400, "Provide a model");
        try {
          json(response, 200, await listReasoningEfforts(model.data));
        } catch {
          throw new HttpError(502, "Could not load reasoning levels. Retry later.");
        }
        return;
      }
      async function loadEnvironmentLimits() {
        if (!adapters.environmentLimits)
          throw new HttpError(503, "Environment discovery is unavailable");
        try {
          return await adapters.environmentLimits();
        } catch (error) {
          throw new HttpError(
            502,
            error instanceof EnvironmentLimitsError
              ? error.message
              : "Could not load environment limits. Check Daytona access and retry.",
          );
        }
      }
      if (method === "GET" && url.pathname === "/api/environment-limits") {
        json(response, 200, await loadEnvironmentLimits());
        return;
      }
      async function validateResources(
        resources: import("@herbie/contracts").EnvironmentResources | null | undefined,
      ) {
        if (!resources) return;
        const limits = await loadEnvironmentLimits();
        try {
          validateEnvironmentResources(resources, limits);
        } catch (error) {
          throw new HttpError(400, (error as Error).message);
        }
      }
      if (method === "GET" && url.pathname === "/api/models") {
        if (!options.listModels) throw new HttpError(503, "Model discovery is unavailable");
        let models: string[];
        try {
          models = await options.listModels();
        } catch {
          throw new HttpError(502, "Could not load models. You can enter a custom model or retry.");
        }
        json(response, 200, models);
        return;
      }
      if (method === "GET" && url.pathname === "/api/repositories") {
        if (request.headers["x-herbie-repository-version"] === "2") {
          const discovery = adapters.discoverRepositories
            ? await adapters.discoverRepositories(userId)
            : { repositories: await adapters.repositories(userId), permissionsRequired: false };
          json(response, 200, discovery);
        } else json(response, 200, await adapters.repositories(userId));
        return;
      }
      if (method === "GET" && url.pathname === "/api/projects") {
        projectJson(200, await store.listProjects(userId));
        return;
      }
      if (method === "POST" && url.pathname === "/api/projects") {
        requireExecution();
        const input = projectInput.parse(await readJson(request));
        await validateResources(input.resources);
        const key = z.string().uuid().parse(request.headers["idempotency-key"]);
        await adapters.authorize(userId, input.repository);
        const result = await store.createProject(userId, input, adapters.mode, key);
        projectJson(result.created ? 201 : 200, result.project);
        return;
      }
      const projectPath = url.pathname.match(
        /^\/api\/projects\/([^/]+)(?:\/(events|pause|resume|cancel|retry|retry-publication|retry-repair|name|prompt))?$/,
      );
      if (projectPath) {
        const id = z.string().uuid().parse(projectPath[1]);
        const project = await store.getProject(id, userId);
        if (!project) throw new HttpError(404, "Project not found");
        if (method === "POST" && !projectPath[2]) {
          const input = projectUpdate.parse(await readJson(request));
          await validateResources(input.resources);
          projectJson(200, await store.updateProject(id, userId, input));
          return;
        }
        if (method === "GET" && !projectPath[2]) {
          projectJson(200, project);
          return;
        }
        if (method === "GET" && projectPath[2] === "events") {
          const after = z.coerce
            .number()
            .int()
            .min(0)
            .safe()
            .parse(url.searchParams.get("after") ?? 0);
          json(response, 200, await store.events(id, after));
          return;
        }
        if (method === "POST" && projectPath[2] && projectPath[2] !== "events") {
          if (projectPath[2] === "prompt") {
            const { prompt } = projectPromptEdit.parse(await readJson(request));
            projectJson(200, await store.editProjectPrompt(id, userId, prompt));
            return;
          }
          if (projectPath[2] === "name") {
            const { name } = projectRename.parse(await readJson(request));
            projectJson(200, await store.renameProject(id, userId, name));
            return;
          }
          if (projectPath[2] === "retry-repair") {
            requireExecution();
            const { repairId } = z
              .object({ repairId: z.string().uuid() })
              .strict()
              .parse(await readJson(request));
            await adapters.authorize(userId, project.repository);
            projectJson(200, await store.retryCiRepair(id, userId, repairId));
            return;
          }
          if (projectPath[2] === "retry" || projectPath[2] === "retry-publication") {
            requireExecution();
            const candidate = await store.publicationRetryCandidate(id, userId);
            if (!candidate) throw new HttpError(404, "Project not found");
            if (candidate.kind === "already_queued" || candidate.kind === "in_progress") {
              projectJson(200, candidate.project);
              return;
            }
            if (projectPath[2] === "retry" && candidate.kind === "unavailable") {
              await adapters.authorize(userId, project.repository);
              projectJson(200, await store.retryAttempt(id, userId));
              return;
            }
            if (adapters.mode !== "live" || !adapters.checkPublicationRetry)
              throw new HttpError(404, "Not found");
            if (candidate.kind !== "retryable")
              throw new HttpError(409, "No saved publication is eligible for a safe retry.");
            const job = candidate.job;
            if (!job.artifact || !hasValidPublicationEvidence(job.project.repository, job.artifact))
              throw new HttpError(
                409,
                "The saved artifact does not meet publication verification requirements.",
              );
            const repository = await adapters.reconciliationRepository(job.project.repository);
            const check = await adapters.checkPublicationRetry(
              { project: job.project, repository, attemptId: job.attemptId, branch: job.branch },
              job.artifact,
            );
            if (check === "pull_request_exists")
              throw new HttpError(
                409,
                "A pull request already exists; reconciliation will check GitHub.",
              );
            if (check === "branch_exists")
              throw new HttpError(
                409,
                "The exact attempt branch already exists; automatic retry was refused.",
              );
            if (check === "base_changed")
              throw new HttpError(
                409,
                "The repository history no longer contains the original base; the saved artifact cannot be published without a new attempt.",
              );
            projectJson(
              200,
              await store.queueSavedPublication(
                job.id,
                userId,
                job.branch,
                job.artifact.baseCommit,
              ),
            );
            return;
          }
          const action = actionSchema.parse(projectPath[2]);
          if (action === "resume") requireExecution();
          projectJson(200, await store.control(id, userId, action));
          return;
        }
      }
      throw new HttpError(404, "Not found");
    }
    if (method !== "GET" && method !== "HEAD") throw new HttpError(404, "Not found");
    const pathname = decodeURIComponent(url.pathname);
    const file = resolve(web, pathname.replace(/^\/+/, ""));
    if (!file.startsWith(`${resolve(web)}/`) && file !== resolve(web))
      throw new HttpError(404, "Not found");
    const requested = extname(file) ? file : resolve(web, "index.html");
    let data: Buffer;
    try {
      data = await readFile(requested);
    } catch (error) {
      logFailure(error, { component: "web-file-read" });
      throw new HttpError(404, "Web UI not built. Run pnpm build.");
    }
    if (extname(requested) === ".html") {
      data = Buffer.from(
        data
          .toString("utf8")
          .replace("<head>", `<head><meta name="style-nonce" content="${styleNonce}"/>`),
      );
    }
    const mime: Record<string, string> = {
      ".html": "text/html",
      ".js": "text/javascript",
      ".css": "text/css",
      ".svg": "image/svg+xml",
      ".png": "image/png",
    };
    response.writeHead(200, {
      "content-type": `${mime[extname(requested)] ?? "application/octet-stream"}; charset=utf-8`,
      "cache-control": "no-cache",
    });
    response.end(method === "HEAD" ? undefined : data);
  }
  const server = createServer((request, response) => {
    void handle(request, response).catch((error) => {
      const errorId = logFailure(error, { component: "http-request" });
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (
        error instanceof HttpError ||
        error instanceof StoreError ||
        error instanceof AuthError ||
        error instanceof GithubError
      )
        json(response, error.status, {
          error: error.message,
          ...(error instanceof GithubError && error.code ? { code: error.code } : {}),
        });
      else if (error instanceof z.ZodError || error instanceof URIError)
        json(response, 400, { error: "Invalid request" });
      else json(response, 500, { error: `Request failed. Reference: ${errorId}` });
    });
  });
  attachRealtime(server, store, auth, origin, (request) => cookie(request, "herbie_session"));
  return server;
}
