import { z } from "zod";
import {
  reasoningEffort,
  environmentLimits,
  environmentPreparation,
  type EnvironmentResources,
  projectUpdate,
  type ProjectUpdate,
  projectPromptEdit,
  projectRename,
  projectInput,
  projectSchema,
  eventSchema,
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

/** Browser-safe transport shared by the CLI and web. Sessions are never part of job data. */
export function createClient(options: { baseUrl?: string; token?: string; origin?: string } = {}) {
  const baseUrl = options.baseUrl?.replace(/\/$/, "") ?? "";
  async function request<T>(
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
    requestId?: string,
    preparationId?: string,
  ): Promise<T> {
    const headers = new Headers({
      accept: "application/json",
      "x-herbie-repository-version": "2",
    });
    if (body !== undefined) headers.set("content-type", "application/json");
    if (body !== undefined && options.origin) headers.set("origin", options.origin);
    if (options.token) headers.set("authorization", `Bearer ${options.token}`);
    if (requestId) headers.set("idempotency-key", z.uuid().parse(requestId));
    if (preparationId) headers.set("x-herbie-environment-preparation", preparationId);
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
  async function saveProject(
    path: string,
    input: unknown,
    environment:
      | { repository: string; resources: EnvironmentResources | null; setupScript: string }
      | { projectId: string; resources?: EnvironmentResources | null; setupScript?: string },
    requestId?: string,
    onProgress?: (phase: "preparing" | "saving") => void,
  ) {
    try {
      return await request(path, projectSchema, input, requestId);
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "environment_preparation_required")
        throw error;
    }
    onProgress?.("preparing");
    let preparation = await request(
      "/api/project-environments",
      environmentPreparation,
      environment,
    );
    const deadline = Date.now() + 16 * 60_000;
    while (preparation.state === "building") {
      if (Date.now() >= deadline)
        throw new ApiError(504, "Environment preparation timed out. Retry saving the project.");
      await new Promise((resolve) => setTimeout(resolve, 2000));
      preparation = await request(
        `/api/project-environments/${preparation.id}`,
        environmentPreparation,
      );
    }
    if (preparation.state === "failed")
      throw new ApiError(
        502,
        "The environment could not be built. Your project has not been saved. Retry to build it again.",
      );
    onProgress?.("saving");
    return request(path, projectSchema, input, requestId, preparation.id);
  }
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
    environmentLimits: () => request("/api/environment-limits", environmentLimits),
    models: () => request("/api/models", z.array(z.string().min(1).max(200))),
    reasoningEfforts: (model: string) =>
      request(
        `/api/reasoning-efforts?model=${encodeURIComponent(model)}`,
        z.array(reasoningEffort),
      ),
    discoverRepositories,
    repositories: async () => (await discoverRepositories()).repositories,
    projects: () => request("/api/projects", z.array(projectSchema)),
    pullRequestAction: (
      id: string,
      number: number,
      action: "approve" | "merge",
      headSha: string,
      mergeMethod: "merge" | "squash" | "rebase" = "squash",
    ) =>
      request(
        `${projectPath(id)}/pull-requests/${z.number().int().positive().parse(number)}/${z.enum(["approve", "merge"]).parse(action)}`,
        z.object({ ok: z.literal(true) }),
        { headSha, mergeMethod },
      ),
    pullRequestDiff: (id: string, number: number) =>
      request(
        `${projectPath(id)}/pull-requests/${z.number().int().positive().parse(number)}/diff`,
        z.object({ diff: z.string() }),
      ),
    project: (id: string) => request(projectPath(id), projectSchema),
    start: (
      input: ProjectInput,
      requestId: string,
      onProgress?: (phase: "preparing" | "saving") => void,
    ) => {
      const { model, reasoningEffort, resources, workflow, setupScript, ...project } =
        projectInput.parse(input);
      return saveProject(
        "/api/projects",
        {
          ...project,
          ...(resources === null ? {} : { resources }),
          ...(workflow === "loop" ? {} : { workflow }),
          ...(setupScript === "" ? {} : { setupScript }),
          ...(model === "gpt-6-luna" ? {} : { model }),
          ...(reasoningEffort === "low" ? {} : { reasoningEffort }),
        },
        { repository: project.repository, resources, setupScript },
        requestId,
        onProgress,
      );
    },
    rename: (id: string, name: string) =>
      request(`${projectPath(id)}/name`, projectSchema, projectRename.parse({ name })),
    update: (
      id: string,
      input: ProjectUpdate,
      onProgress?: (phase: "preparing" | "saving") => void,
    ) =>
      saveProject(
        projectPath(id),
        projectUpdate.parse(input),
        { projectId: id, resources: input.resources, setupScript: input.setupScript },
        undefined,
        onProgress,
      ),
    editPrompt: (id: string, prompt: string) =>
      request(`${projectPath(id)}/prompt`, projectSchema, projectPromptEdit.parse({ prompt })),
    events: (id: string, after = 0) =>
      request(
        `${projectPath(id)}/events?after=${z.number().int().nonnegative().parse(after)}`,
        z.array(eventSchema),
      ),
    action: (id: string, action: ProjectAction) =>
      request(`${projectPath(id)}/${actionSchema.parse(action)}`, projectSchema, {}),
    retryRepair: (id: string, repairId: string) =>
      request(`${projectPath(id)}/retry-repair`, projectSchema, { repairId }),
    retryPublication: (id: string) =>
      request(`${projectPath(id)}/retry-publication`, projectSchema, {}),
    retry: (id: string) => request(`${projectPath(id)}/retry`, projectSchema, {}),
    authStart: (client: "cli" | "web") => request("/api/auth/start", authStartSchema, { client }),
    installationStart: () => request("/api/auth/install/start", installationStartSchema, {}),
    authPoll: (token: string) =>
      request(`/api/auth/poll?token=${encodeURIComponent(token)}`, authPollSchema),
    logout: () => request("/api/auth/logout", z.object({ ok: z.literal(true) }), {}),
  };
}
