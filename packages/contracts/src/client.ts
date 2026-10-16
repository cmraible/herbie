import { z } from "zod";
import {
  projectUpdate,
  type ProjectUpdate,
  projectPromptEdit,
  projectRename,
  projectInput,
  projectSchema,
  runSchema,
  eventSchema,
  streamMessageSchema,
  sessionSchema,
  repositorySchema,
  repositoryDiscoverySchema,
  authStartSchema,
  installationStartSchema,
  authPollSchema,
  actionSchema,
  type ProjectInput,
  type ProjectAction,
} from "./index.js";

const legacyProjectSchema = projectSchema
  .omit({ runCount: true, runs: true })
  .extend({
    attemptCount: projectSchema.shape.runCount,
    attempts: z.array(runSchema).optional(),
  })
  .transform(({ attemptCount, attempts, ...project }) => ({
    ...project,
    runCount: attemptCount,
    runs: attempts,
  }));
export const clientProjectSchema = z.union([projectSchema, legacyProjectSchema]);

const legacyEventSchema = eventSchema
  .omit({ runId: true })
  .extend({ attemptId: z.string().uuid().nullable().optional() })
  .strict()
  .transform(({ attemptId, type, ...event }) => ({
    ...event,
    type: type === "attempt" ? "run" : type === "attempt_started" ? "run_started" : type,
    runId: attemptId,
  }));
const legacyStreamMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("projects"), projects: z.array(clientProjectSchema) }),
  z.object({
    type: z.literal("events"),
    projectId: z.string().uuid(),
    events: z.array(legacyEventSchema),
  }),
]);
export const clientStreamMessageSchema = z.union([
  legacyStreamMessageSchema,
  z.lazy(() => streamMessageSchema),
]);

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Browser-safe transport shared by the CLI and web. Sessions are never part of run data. */
export function createClient(options: { baseUrl?: string; token?: string; origin?: string } = {}) {
  const baseUrl = options.baseUrl?.replace(/\/$/, "") ?? "";
  async function request<T>(
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
    requestId?: string,
  ): Promise<T> {
    const headers = new Headers({
      accept: "application/json",
      "x-herbie-project-version": "3",
      "x-herbie-repository-version": "2",
    });
    if (body !== undefined) headers.set("content-type", "application/json");
    if (body !== undefined && options.origin) headers.set("origin", options.origin);
    if (options.token) headers.set("authorization", `Bearer ${options.token}`);
    if (requestId) headers.set("idempotency-key", z.uuid().parse(requestId));
    const response = await fetch(`${baseUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers,
      credentials: "same-origin",
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new ApiError(
        response.status,
        `Service returned a non-JSON response (HTTP ${response.status})`,
      );
    }
    if (!response.ok) {
      const error = z.object({ error: z.string(), code: z.string().optional() }).safeParse(data);
      throw new ApiError(
        response.status,
        error.success ? error.data.error : `Service returned HTTP ${response.status}`,
        error.success ? error.data.code : undefined,
      );
    }
    return schema.parse(data);
  }
  const discoverRepositories = () =>
    request(
      "/api/repositories",
      z.union([
        repositoryDiscoverySchema,
        z
          .array(repositorySchema)
          .transform((repositories) => ({ repositories, permissionsRequired: false })),
      ]),
    );
  const projectPath = (id: string) => `/api/projects/${z.uuid().parse(id)}`;
  return {
    health: () =>
      request(
        "/api/health",
        z.object({
          mode: z.literal("live"),
          deploymentId: z.string().optional(),
          imageRevision: z.string().optional(),
        }),
      ),
    session: () => request("/api/session", sessionSchema),
    discoverRepositories,
    repositories: async () => (await discoverRepositories()).repositories,
    projects: () => request("/api/projects", z.array(clientProjectSchema)),
    project: (id: string) => request(projectPath(id), clientProjectSchema),
    start: (input: ProjectInput, requestId: string) => {
      const { maxWip, model, ...project } = projectInput.parse(input);
      // The default must remain acceptable to older strict APIs during rolling upgrades.
      return request(
        "/api/projects",
        clientProjectSchema,
        {
          ...project,
          ...(maxWip === 1 ? {} : { maxWip }),
          ...(model === "gpt-6-luna" ? {} : { model }),
        },
        requestId,
      );
    },
    rename: (id: string, name: string) =>
      request(`${projectPath(id)}/name`, clientProjectSchema, projectRename.parse({ name })),
    update: (id: string, input: ProjectUpdate) =>
      request(projectPath(id), clientProjectSchema, projectUpdate.parse(input)),
    editPrompt: (id: string, prompt: string) =>
      request(
        `${projectPath(id)}/prompt`,
        clientProjectSchema,
        projectPromptEdit.parse({ prompt }),
      ),
    events: (id: string, after = 0) =>
      request(
        `${projectPath(id)}/events?after=${z.number().int().nonnegative().parse(after)}`,
        z.array(eventSchema),
      ),
    action: (id: string, action: ProjectAction) =>
      request(`${projectPath(id)}/${actionSchema.parse(action)}`, clientProjectSchema, {}),
    retryRepair: (id: string, repairId: string) =>
      request(`${projectPath(id)}/retry-repair`, clientProjectSchema, { repairId }),
    retryPublication: (id: string) =>
      request(`${projectPath(id)}/retry-publication`, clientProjectSchema, {}),
    retry: (id: string) => request(`${projectPath(id)}/retry`, clientProjectSchema, {}),
    authStart: (client: "cli" | "web") => request("/api/auth/start", authStartSchema, { client }),
    installationStart: () => request("/api/auth/install/start", installationStartSchema, {}),
    authPoll: (token: string) =>
      request(`/api/auth/poll?token=${encodeURIComponent(token)}`, authPollSchema),
    logout: () => request("/api/auth/logout", z.object({ ok: z.literal(true) }), {}),
  };
}
