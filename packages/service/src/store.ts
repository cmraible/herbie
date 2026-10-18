import { publicationBackoffMs } from "./publication-backoff.js";
import { demoProjectName } from "./demo.js";
import { logFailure } from "./diagnostic-log.js";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import {
  pullRequestMetadataSchema,
  projectUpdate,
  type ProjectUpdate,
  projectName,
  projectInput,
  projectSchema,
  eventSchema,
  type Project,
  type ProjectInput,
  type ProjectAction,
  type ProjectEvent,
} from "@herbie/contracts";
import { hasValidPublicationEvidence } from "@herbie/loop/publish-patch";
import type { PullRequestFeedback, PublicationPhase } from "./adapters.js";
import type { AgentAttemptChanges } from "@herbie/loop/agent-attempt";

const projectColumns = `id, owner_id AS "ownerId", repository, name, prompt, resources, model, reasoning_effort AS "reasoningEffort",
  max_wip AS "maxWip", attempt_count AS "attemptCount", mode, state, stop_requested AS "stopRequested",
  pull_request AS "pullRequest",
  COALESCE((SELECT jsonb_agg(j.pull_request ORDER BY j.cycle) FROM jobs j WHERE j.project_id=projects.id AND j.pull_request IS NOT NULL),'[]'::jsonb) AS "pullRequests",
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id',j.id,'number',j.cycle,'state',j.stage,'createdAt',j.created_at,'pullRequest',j.pull_request,'sessions',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',s.id,'kind',s.kind,'state',s.state,'model',s.model,'reasoningEffort',s.reasoning_effort,'startedAt',s.started_at,'finishedAt',s.finished_at,'environment',s.environment,'cleanup',s.cleanup,'threadId',s.thread_id,'usage',s.usage) ORDER BY s.started_at,s.id) FROM agent_sessions s WHERE s.job_id=j.id),'[]'::jsonb),'ciRepair',(SELECT jsonb_build_object('id',r.id,'state',r.state,'canRetry',r.state='failed' AND r.retryable AND NOT r.publication_started) FROM ci_repairs r WHERE r.job_id=j.id AND r.state <> 'superseded' ORDER BY r.created_at DESC LIMIT 1)) ORDER BY j.cycle) FROM jobs j WHERE j.project_id=projects.id),'[]'::jsonb) AS attempts,
  cleanup_status AS "cleanupStatus", error, created_at AS "createdAt", updated_at AS "updatedAt"`;
const databaseProject = projectSchema.extend({
  createdAt: z.date().transform((d) => d.toISOString()),
  updatedAt: z.date().transform((d) => d.toISOString()),
});
const artifactSchema = z.object({
  baseCommit: z.string(),
  patchBase64: z.string(),
  pullRequestTitle: z
    .string()
    .trim()
    .min(1)
    .max(256)
    .regex(/^[^\r\n]+$/)
    .optional(),
  pullRequestBody: z.string().trim().min(1).max(60_000).optional(),
  verification: z
    .object({
      version: z.union([z.literal(2), z.literal(3)]).optional(),
      repoUrl: z.string(),
      baseCommit: z.string(),
      patchSha256: z.string(),
      goalCompleted: z.literal(true),
      sandboxDeleted: z.literal(true),
      localChecksPassed: z.literal(true).optional(),
    })
    .optional(),
});
const jobRow = z.object({
  id: z.string().uuid(),
  project_id: z.string().uuid(),
  branch: z.string(),
  cycle: z.number().int(),
  stage: z.enum([
    "queued",
    "running",
    "ready",
    "publishing",
    "awaiting_review",
    "completed",
    "cancelled",
    "failed",
    "needs_attention",
  ]),
  artifact: artifactSchema.nullable(),
  lease_owner: z.string().nullable(),
  lease_expires_at: z.date().nullable(),
  lease_valid: z.boolean(),
  publication_retry_count: z.number().int().nonnegative(),
  publication_blocked: z.boolean(),
});
export interface Job {
  id: string;
  attemptId: string;
  project: Project;
  branch: string;
  stage: z.infer<typeof jobRow>["stage"];
  artifact: AgentAttemptChanges | null;
}
export type PublicationRetryCandidate =
  | { kind: "retryable"; job: Job }
  | { kind: "already_queued" | "in_progress" | "unavailable"; project: Project };
export type PullRequest = NonNullable<Project["pullRequest"]>;
export class StoreError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "StoreError";
  }
}
const conflict = (message: string) => new StoreError(409, message);
function requestFingerprint(
  { repository, prompt, name, maxWip, model, reasoningEffort, resources }: ProjectInput,
  mode: Project["mode"],
  legacyLimit?: number,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        repository: repository.toLowerCase(),
        prompt,
        ...(legacyLimit === undefined ? {} : { maxAttempts: legacyLimit }),
        mode,
        ...(resources == null ? {} : { resources }),
        ...(name === undefined ? {} : { name }),
        ...(model === undefined || model === "gpt-6-luna" ? {} : { model }),
        ...(reasoningEffort === undefined || reasoningEffort === "low" ? {} : { reasoningEffort }),
        ...(maxWip === undefined || maxWip === 1 ? {} : { maxWip }),
      }),
    )
    .digest("hex");
}
function decodeArtifact(
  encoded: z.infer<typeof artifactSchema> | null,
): AgentAttemptChanges | null {
  if (!encoded) return null;
  const { patchBase64, ...metadata } = encoded;
  return { ...metadata, patch: Buffer.from(patchBase64, "base64") };
}
function decodeJob(row: z.infer<typeof jobRow>, project: Project): Job {
  return {
    id: row.id,
    attemptId: row.id,
    branch: row.branch,
    stage: row.stage,
    artifact: decodeArtifact(row.artifact),
    project,
  };
}
async function projectFrom(
  client: Pool | PoolClient,
  id: string,
  lock = false,
): Promise<Project | null> {
  const result = await client.query<Record<string, unknown>>(
    `SELECT ${projectColumns} FROM projects WHERE id=$1 ${lock ? "FOR UPDATE" : ""}`,
    [id],
  );
  return result.rows[0] ? databaseProject.parse(result.rows[0]) : null;
}
async function addEvent(
  client: PoolClient,
  id: string,
  type: string,
  message: string,
  attemptId?: string,
): Promise<void> {
  await client.query(
    "INSERT INTO project_events(project_id,type,message,job_id) VALUES ($1,$2,$3,$4)",
    [id, type, message, attemptId ?? null],
  );
}
async function loadJob(client: PoolClient, id: string): Promise<z.infer<typeof jobRow>> {
  const result = await client.query<Record<string, unknown>>(
    "SELECT *, (lease_expires_at > clock_timestamp()) IS TRUE AS lease_valid FROM jobs WHERE id=$1 FOR UPDATE",
    [id],
  );
  if (!result.rows[0]) throw new StoreError(404, "Job not found");
  return jobRow.parse(result.rows[0]);
}
async function lockJob(
  client: PoolClient,
  id: string,
  workerId?: string,
): Promise<{ row: z.infer<typeof jobRow>; project: Project }> {
  const result = await client.query<Record<string, unknown>>(
    "SELECT project_id FROM jobs WHERE id=$1",
    [id],
  );
  if (!result.rows[0]) throw new StoreError(404, "Job not found");
  const projectId = z.object({ project_id: z.string().uuid() }).parse(result.rows[0]).project_id;
  const project = await projectFrom(client, projectId, true);
  if (!project) throw new StoreError(404, "Project not found");
  const row = await loadJob(client, id);
  if (workerId !== undefined && (row.lease_owner !== workerId || !row.lease_valid))
    throw conflict("Worker lease expired or belongs to another worker");
  return { row, project };
}
async function insertJob(client: PoolClient, projectId: string, cycle: number): Promise<string> {
  const id = randomUUID();
  await client.query(
    "INSERT INTO jobs(id,project_id,cycle,branch,stage) VALUES ($1,$2,$3,$4,'queued')",
    [id, projectId, cycle, `herbie/${projectId}/${id}`],
  );
  return id;
}

// Call with the project locked. One attempt runs at a time, while published PRs
// continue occupying capacity until merged. Queued work reserves a slot too.
async function advanceProject(client: PoolClient, project: Project): Promise<void> {
  if (["cancelled", "failed", "needs_attention"].includes(project.state)) return;
  const { rows } = await client.query<{ stage: string; cycle: number }>(
    "SELECT stage,cycle FROM jobs WHERE project_id=$1 ORDER BY cycle",
    [project.id],
  );
  let pending = rows.find((job) =>
    ["queued", "running", "ready", "publishing"].includes(job.stage),
  );
  const reviewing = rows.filter((job) => job.stage === "awaiting_review").length;
  const cycle = rows.at(-1)?.cycle ?? 0;
  if (!pending && reviewing < project.maxWip) {
    await insertJob(client, project.id, cycle + 1);
    pending = { stage: "queued", cycle: cycle + 1 };
  }
  const state =
    project.state === "paused" ||
    (project.stopRequested === "pause" && !["running", "publishing"].includes(pending?.stage ?? ""))
      ? "paused"
      : pending
        ? ["running", "publishing"].includes(pending.stage)
          ? "running"
          : "queued"
        : "awaiting_review";
  await client.query(
    "UPDATE projects SET state=$2,stop_requested=CASE WHEN $2='paused' THEN NULL ELSE stop_requested END,updated_at=clock_timestamp() WHERE id=$1",
    [project.id, state],
  );
}

async function cancelProject(client: PoolClient, project: Project): Promise<void> {
  const { rows } = await client.query<{ stage: string; lease_valid: boolean }>(
    "SELECT stage,(lease_expires_at>clock_timestamp()) IS TRUE AS lease_valid FROM jobs WHERE project_id=$1 FOR UPDATE",
    [project.id],
  );
  const uncertain = rows.some(
    (j) =>
      ["publishing", "awaiting_review", "needs_attention"].includes(j.stage) ||
      (j.stage === "running" && !j.lease_valid),
  );
  const active = rows.some((j) => j.stage === "running" && j.lease_valid);
  const cleanup = uncertain ? "needs_attention" : active ? "pending" : "not_required";
  await client.query(
    "UPDATE jobs SET cancelled_worker=lease_owner,cancel_cleanup_deadline=clock_timestamp()+interval '5 minutes',stage='cancelled',lease_owner=NULL,lease_expires_at=NULL WHERE project_id=$1 AND stage NOT IN ('completed','cancelled','failed')",
    [project.id],
  );
  await client.query(
    "UPDATE projects SET state='cancelled',stop_requested=NULL,cleanup_status=$2,updated_at=clock_timestamp() WHERE id=$1",
    [project.id, cleanup],
  );
  await addEvent(
    client,
    project.id,
    "cancel",
    "Project cancelled. No further attempts or publication retries will start. Saved work and audit history retained.",
  );
  if (cleanup !== "not_required")
    await addEvent(
      client,
      project.id,
      "cleanup_required",
      cleanup === "pending"
        ? "Stopping the active sandbox. Cleanup confirmation is pending."
        : "Remote work may remain. Cleanup requires attention; cancellation remains in effect.",
    );
}

export class Store {
  constructor(
    readonly pool: Pool,
    private readonly retryRandom: () => number = Math.random,
    private readonly nameProject?: (prompt: string) => string | Promise<string>,
  ) {}
  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (error) {
        logFailure(error, { component: "store-rollback" });
      }
      throw error;
    } finally {
      client.release();
    }
  }
  async migrate(): Promise<void> {
    const sql = await readFile(new URL("./schema.sql", import.meta.url), "utf8");
    await this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(174827301)");
      await client.query(sql);
    });
  }
  async close(): Promise<void> {
    await this.pool.end();
  }
  async createProject(
    ownerId: string,
    input: ProjectInput,
    mode: "demo" | "live",
    key: string,
  ): Promise<{ project: Project; created: boolean }> {
    const request = projectInput.parse(input);
    z.string().uuid().parse(key);
    const fingerprint = requestFingerprint(request, mode);
    let name = request.name;
    if (name === undefined) {
      const existing = await this.pool.query(
        "SELECT 1 FROM project_requests WHERE owner_id=$1 AND request_key=$2",
        [ownerId, key],
      );
      if (!existing.rowCount) {
        if (mode === "live" && !this.nameProject)
          throw new Error("Live project naming is not configured");
        name = projectName.parse(
          await (mode === "live"
            ? this.nameProject!(request.prompt)
            : demoProjectName(request.prompt)),
        );
      }
    }
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `request:${ownerId}:${key}`,
      ]);
      const existing = await client.query<Record<string, unknown>>(
        "SELECT r.fingerprint,r.project_id,(g.test_command IS NOT NULL) AS legacy FROM project_requests r JOIN projects g ON g.id=r.project_id WHERE r.owner_id=$1 AND r.request_key=$2",
        [ownerId, key],
      );
      if (existing.rows[0]) {
        const previous = z
          .object({ fingerprint: z.string(), project_id: z.string().uuid(), legacy: z.boolean() })
          .parse(existing.rows[0]);
        const project = await projectFrom(client, previous.project_id);
        if (!project) throw new Error("Missing idempotent project");
        // Match old request hashes without retaining a limit on the project.
        const matchesFingerprint = [undefined, 1, 2, 3, 4, 5].some(
          (limit) => requestFingerprint(request, mode, limit) === previous.fingerprint,
        );
        // Older testCommand requests replay against immutable input, excluding the mutable name.
        if (
          !matchesFingerprint &&
          (!previous.legacy ||
            request.name !== undefined ||
            requestFingerprint({ ...project, name: undefined }, project.mode) !== fingerprint)
        )
          throw conflict("Idempotency key was already used for a different request");
        return { project, created: false };
      }
      const id = randomUUID();
      if (name === undefined) throw new Error("Missing project name");
      await client.query(
        "INSERT INTO projects(id,owner_id,repository,prompt,mode,name,max_wip,model,reasoning_effort,resources,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'queued')",
        [
          id,
          ownerId,
          request.repository,
          request.prompt,
          mode,
          name,
          request.maxWip,
          request.model,
          request.reasoningEffort,
          request.resources,
        ],
      );
      await client.query(
        "INSERT INTO project_requests(owner_id,request_key,fingerprint,project_id) VALUES($1,$2,$3,$4)",
        [ownerId, key, fingerprint, id],
      );
      const runId = await insertJob(client, id, 1);
      await addEvent(client, id, "queued", "Run #1 queued", runId);
      const project = await projectFrom(client, id);
      if (!project) throw new Error("Missing created project");
      return { project, created: true };
    });
  }
  async renameProject(id: string, ownerId: string, name: string): Promise<Project> {
    const parsed = projectName.parse(name);
    return this.transaction(async (client) => {
      const project = await projectFrom(client, id, true);
      if (!project || project.ownerId !== ownerId) throw new StoreError(404, "Project not found");
      if (project.state === "cancelled")
        throw new StoreError(409, "Cancelled projects cannot be edited");
      const result = await client.query<Record<string, unknown>>(
        `UPDATE projects SET name=$3,updated_at=clock_timestamp() WHERE id=$1 AND owner_id=$2 RETURNING ${projectColumns}`,
        [id, ownerId, parsed],
      );
      if (!result.rows[0]) throw new StoreError(404, "Project not found");
      await addEvent(client, id, "renamed", "Project renamed");
      return databaseProject.parse(result.rows[0]);
    });
  }
  async editProjectPrompt(id: string, ownerId: string, prompt: string): Promise<Project> {
    return this.updateProject(id, ownerId, { prompt });
  }
  async updateProject(id: string, ownerId: string, input: ProjectUpdate): Promise<Project> {
    const parsed = projectUpdate.parse(input);
    return this.transaction(async (client) => {
      const project = await projectFrom(client, id, true);
      if (!project || project.ownerId !== ownerId) throw new StoreError(404, "Project not found");
      if (project.state === "cancelled")
        throw new StoreError(409, "Cancelled projects cannot be edited");
      // Normalize legacy request hashes before their fallback loses the original prompt.
      await client.query(
        `UPDATE project_requests SET fingerprint=$2 WHERE project_id=$1
        AND EXISTS (SELECT 1 FROM projects WHERE id=$1 AND test_command IS NOT NULL)`,
        [id, requestFingerprint({ ...project, name: undefined }, project.mode)],
      );
      const result = await client.query<Record<string, unknown>>(
        `UPDATE projects SET name=COALESCE($2,name),prompt=COALESCE($3,prompt),max_wip=COALESCE($4,max_wip),model=COALESCE($5,model),reasoning_effort=COALESCE($6,reasoning_effort),resources=CASE WHEN $7 THEN $8::jsonb ELSE resources END,test_command=NULL,updated_at=clock_timestamp() WHERE id=$1 RETURNING ${projectColumns}`,
        [
          id,
          parsed.name,
          parsed.prompt,
          parsed.maxWip,
          parsed.model,
          parsed.reasoningEffort,
          parsed.resources !== undefined,
          parsed.resources,
        ],
      );
      const updated = databaseProject.parse(result.rows[0]);
      if (
        updated.maxWip !== project.maxWip &&
        !["completed", "cancelled", "failed", "needs_attention"].includes(project.state)
      )
        await advanceProject(client, updated);
      const promptOnly = Object.keys(parsed).length === 1 && parsed.prompt !== undefined;
      await addEvent(
        client,
        id,
        promptOnly ? "prompt_updated" : "updated",
        promptOnly
          ? "Project prompt updated. Future attempts will use the new prompt."
          : "Project settings updated. Future attempts will use the new settings.",
      );
      return (await projectFrom(client, id))!;
    });
  }
  async getProject(id: string, ownerId?: string): Promise<Project | null> {
    const project = await projectFrom(this.pool, id);
    return project && (ownerId === undefined || project.ownerId === ownerId) ? project : null;
  }
  async publicationRetryCandidate(
    id: string,
    ownerId: string,
  ): Promise<PublicationRetryCandidate | null> {
    const project = await projectFrom(this.pool, id);
    if (!project || project.ownerId !== ownerId) return null;
    const result = await this.pool.query<Record<string, unknown>>(
      "SELECT *, (lease_expires_at > clock_timestamp()) IS TRUE AS lease_valid FROM jobs WHERE project_id=$1 ORDER BY cycle DESC LIMIT 1",
      [id],
    );
    if (!result.rows[0]) return { kind: "unavailable", project };
    const row = jobRow.parse(result.rows[0]);
    const job = decodeJob(row, project);
    if (row.stage === "publishing" && row.lease_valid) return { kind: "in_progress", project };
    if (row.stage === "ready" && row.artifact && ["queued", "running"].includes(project.state))
      return { kind: "already_queued", project };
    if (
      project.mode === "live" &&
      row.stage === "publishing" &&
      !row.lease_valid &&
      ["needs_attention", "running"].includes(project.state) &&
      project.stopRequested !== "cancel" &&
      job.artifact &&
      hasValidPublicationEvidence(project.repository, job.artifact)
    )
      return { kind: "retryable", job };
    return { kind: "unavailable", project };
  }
  async retryAttempt(id: string, ownerId: string): Promise<Project> {
    return this.transaction(async (client) => {
      const project = await projectFrom(client, id, true);
      if (!project || project.ownerId !== ownerId) throw new StoreError(404, "Project not found");
      if (
        ["queued", "running", "awaiting_review"].includes(project.state) &&
        !project.stopRequested
      )
        return project;
      if (!["failed", "needs_attention"].includes(project.state) || project.stopRequested)
        throw conflict("Only failed or interrupted projects can be retried");
      const { rows } = await client.query<{ stage: string }>(
        "SELECT stage FROM jobs WHERE project_id=$1 FOR UPDATE",
        [id],
      );
      if (rows.some((row) => ["queued", "running", "ready", "publishing"].includes(row.stage)))
        throw conflict(
          "Saved work must finish publication recovery before a new attempt can start",
        );
      const reviewing = await client.query(
        "SELECT 1 FROM jobs WHERE project_id=$1 AND stage='awaiting_review' LIMIT $2",
        [id, project.maxWip],
      );
      if (reviewing.rows.length >= project.maxWip)
        throw conflict("Review or close an open pull request before retrying this project");
      await client.query(
        "UPDATE projects SET state='queued',error=NULL,stop_requested=NULL,updated_at=clock_timestamp() WHERE id=$1",
        [id],
      );
      await advanceProject(client, {
        ...project,
        state: "queued",
        error: null,
        stopRequested: null,
      });
      const next = await client.query<{ id: string; cycle: number }>(
        "SELECT id,cycle FROM jobs WHERE project_id=$1 AND stage='queued' ORDER BY cycle DESC LIMIT 1",
        [id],
      );
      if (next.rows[0])
        await addEvent(client, id, "retry", `Run #${next.rows[0].cycle} queued`, next.rows[0].id);
      return (await projectFrom(client, id))!;
    });
  }
  async listProjects(ownerId: string): Promise<Project[]> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT ${projectColumns} FROM projects WHERE owner_id=$1 ORDER BY created_at DESC`,
      [ownerId],
    );
    return result.rows.map((row) => databaseProject.parse(row));
  }
  async events(projectId: string, after = 0): Promise<ProjectEvent[]> {
    const result = await this.pool.query<Record<string, unknown>>(
      'SELECT id::text,project_id AS "projectId",job_id AS "attemptId",agent_session_id AS "agentSessionId",type,message,created_at AS "createdAt" FROM project_events WHERE project_id=$1 AND id>$2 ORDER BY project_events.id LIMIT 1000',
      [projectId, after],
    );
    return result.rows.map((row) =>
      eventSchema
        .extend({
          id: z.string().transform(Number),
          createdAt: z.date().transform((d) => d.toISOString()),
        })
        .parse(row),
    );
  }
  async control(id: string, ownerId: string, action: ProjectAction): Promise<Project> {
    return this.transaction(async (client) => {
      const project = await projectFrom(client, id, true);
      if (!project || project.ownerId !== ownerId) throw new StoreError(404, "Project not found");
      if (action === "cancel") {
        // Cancellation is a local durable decision, never dependent on GitHub or
        // remote cleanup. Revoking every lease fences callbacks and future claims.
        if (["cancelled", "completed", "failed"].includes(project.state)) return project;
        await cancelProject(client, project);
        const jobs = await client.query<{ id: string }>("SELECT id FROM jobs WHERE project_id=$1", [
          id,
        ]);
        for (const job of jobs.rows) await this.discardWaitingCiWith(client, job.id);
        return (await projectFrom(client, id))!;
      }
      const result = await client.query<Record<string, unknown>>(
        "SELECT *, (lease_expires_at > clock_timestamp()) IS TRUE AS lease_valid FROM jobs WHERE project_id=$1 ORDER BY cycle DESC LIMIT 1 FOR UPDATE",
        [id],
      );
      const job = jobRow.parse(result.rows[0]);
      if (job.stage === "publishing")
        throw conflict(
          "Wait for publication reconciliation before pausing or resuming this project",
        );
      if (
        (action === "pause" && (project.state === "paused" || project.stopRequested === "pause")) ||
        (action === "resume" &&
          ["queued", "running", "awaiting_review"].includes(project.state) &&
          !project.stopRequested)
      )
        return project;
      if (["completed", "cancelled", "failed", "needs_attention"].includes(project.state))
        throw conflict(`Cannot ${action} a ${project.state} project`);
      if (action === "resume") {
        if (project.state !== "paused" && project.stopRequested !== "pause")
          throw conflict("Project is not paused");
        await client.query(
          "UPDATE projects SET state='queued',stop_requested=NULL,updated_at=clock_timestamp() WHERE id=$1",
          [id],
        );
        await advanceProject(client, { ...project, state: "queued", stopRequested: null });
      } else if (job.stage === "running") {
        await client.query(
          "UPDATE projects SET stop_requested=$2,updated_at=clock_timestamp() WHERE id=$1",
          [id, action],
        );
      } else {
        await client.query(
          "UPDATE projects SET state='paused',stop_requested=NULL,updated_at=clock_timestamp() WHERE id=$1",
          [id],
        );
        await client.query("UPDATE jobs SET lease_owner=NULL,lease_expires_at=NULL WHERE id=$1", [
          job.id,
        ]);
      }
      await addEvent(client, id, action, `${action === "resume" ? "Resume" : "Pause"} requested`);
      return (await projectFrom(client, id))!;
    });
  }
  // A fenced worker may report cleanup/evidence, but never revive the job or project.
  async finishCancelled(
    jobId: string,
    workerId: string,
    cleanup: "complete" | "needs_attention",
    changes?: AgentAttemptChanges,
    pullRequest?: Omit<PullRequest, "state">,
  ): Promise<boolean> {
    return this.transaction(async (client) => {
      const { row, project } = await lockJob(client, jobId);
      if (project.state !== "cancelled" || row.stage !== "cancelled") return false;
      const owner = await client.query("SELECT 1 FROM jobs WHERE id=$1 AND cancelled_worker=$2", [
        jobId,
        workerId,
      ]);
      if (!owner.rowCount) return false;
      if (changes) {
        const artifact = artifactSchema.parse({
          ...changes,
          patchBase64: changes.patch.toString("base64"),
        });
        await client.query("UPDATE jobs SET artifact=COALESCE(artifact,$2) WHERE id=$1", [
          jobId,
          JSON.stringify(artifact),
        ]);
      }
      if (pullRequest && pullRequest.branch === row.branch) {
        const pr = projectSchema.shape.pullRequest
          .unwrap()
          .parse({ state: "open", ...pullRequest });
        await client.query("UPDATE jobs SET pull_request=$2 WHERE id=$1", [
          jobId,
          JSON.stringify(pr),
        ]);
        await client.query("UPDATE projects SET pull_request=$2 WHERE id=$1", [
          project.id,
          JSON.stringify(pr),
        ]);
      }
      // An uncertain publication cannot become clean merely because its caller returned.
      const status = project.cleanupStatus === "needs_attention" ? "needs_attention" : cleanup;
      await client.query(
        "UPDATE projects SET cleanup_status=$2,updated_at=clock_timestamp() WHERE id=$1",
        [project.id, status],
      );
      await client.query("UPDATE jobs SET cancelled_worker=NULL WHERE id=$1", [jobId]);
      await addEvent(
        client,
        project.id,
        "cancellation_cleanup",
        status === "complete"
          ? "Sandbox deletion confirmed after cancellation. Saved work retained."
          : "Cancellation remains in effect. Remote cleanup or publication outcome requires attention.",
        jobId,
      );
      return true;
    });
  }

  async claim(workerId: string, leaseMs = 30_000, mode?: "demo" | "live"): Promise<Job | null> {
    z.number().int().positive().max(3_600_000).parse(leaseMs);
    return this.transaction(async (client) => {
      const selected = await client.query<Record<string, unknown>>(
        `SELECT j.id FROM jobs j JOIN projects g ON g.id=j.project_id
        WHERE j.stage IN ('queued','ready','publishing')
        AND (j.stage <> 'queued' OR (SELECT count(*) FROM jobs reviewing WHERE reviewing.project_id=g.id AND reviewing.stage='awaiting_review') < g.max_wip)
        AND j.eligible_at<=clock_timestamp() AND ($1::text IS NULL OR g.mode=$1)
        AND NOT j.publication_blocked AND (g.stop_requested IS NULL OR (j.stage='publishing' AND g.stop_requested='pause'))
        AND (j.lease_owner IS NULL OR j.lease_expires_at<=clock_timestamp())
        AND (g.state IN ('queued','running') OR (j.stage='publishing' AND g.state='needs_attention'))
        ORDER BY j.created_at LIMIT 1 FOR UPDATE OF g,j SKIP LOCKED`,
        [mode ?? null],
      );
      if (!selected.rows[0]) return null;
      const id = z.object({ id: z.string().uuid() }).parse(selected.rows[0]).id;
      const { row, project } = await lockJob(client, id);
      await client.query(
        "UPDATE jobs SET stage=CASE WHEN stage='queued' THEN 'running' ELSE stage END,lease_owner=$2,lease_expires_at=clock_timestamp()+$3*interval '1 millisecond' WHERE id=$1",
        [id, workerId, leaseMs],
      );
      if (row.stage !== "publishing")
        await client.query(
          "UPDATE projects SET state='running',attempt_count=attempt_count+$2,error=NULL,updated_at=clock_timestamp() WHERE id=$1",
          [project.id, row.stage === "queued" ? 1 : 0],
        );
      if (row.stage !== "publishing")
        await addEvent(
          client,
          project.id,
          row.stage === "queued" ? "attempt_started" : "work_resumed",
          row.stage === "queued"
            ? `Run #${row.cycle} started`
            : "Resuming captured artifact publication",
          id,
        );
      const updated = await projectFrom(client, project.id);
      if (!updated) throw new Error("Missing claimed project");
      return decodeJob(await loadJob(client, id), updated);
    });
  }
  async heartbeat(jobId: string, workerId: string, leaseMs = 30_000): Promise<boolean> {
    z.number().int().positive().max(3_600_000).parse(leaseMs);
    const result = await this.pool.query(
      "UPDATE jobs SET lease_expires_at=clock_timestamp()+$3*interval '1 millisecond' WHERE id=$1 AND lease_owner=$2 AND lease_expires_at>clock_timestamp()",
      [jobId, workerId, leaseMs],
    );
    return result.rowCount === 1;
  }
  async startAgentSession(
    jobId: string,
    sourceId: string,
    kind: "implementation" | "ci_repair" | "pr_feedback",
    workerId: string,
    settings: Pick<Project, "model" | "reasoningEffort">,
  ): Promise<string> {
    return this.transaction(async (client) => {
      const { project } = await lockJob(client, jobId);
      const table =
        kind === "implementation" ? "jobs" : kind === "ci_repair" ? "ci_repairs" : "pr_feedback";
      const lease = await client.query(
        `SELECT id FROM ${table} WHERE id=$1 AND lease_owner=$2 AND lease_expires_at>clock_timestamp() AND ${kind === "implementation" ? "id=$3 AND stage" : "job_id=$3 AND state"}='running'`,
        [sourceId, workerId, jobId],
      );
      if (!lease.rowCount || project.stopRequested === "cancel" || project.state === "cancelled")
        throw conflict("Agent session requires an active worker lease");
      const id = randomUUID();
      await client.query(
        "INSERT INTO agent_sessions(id,job_id,source_id,kind,model,reasoning_effort) VALUES($1,$2,$3,$4,$5,$6)",
        [id, jobId, sourceId, kind, settings.model, settings.reasoningEffort],
      );
      return id;
    });
  }
  async recordAgentSession(id: string, metadata: Record<string, unknown>): Promise<void> {
    await this.pool.query(
      `UPDATE agent_sessions SET environment=COALESCE($2::jsonb,environment),thread_id=COALESCE($3,thread_id),usage=COALESCE($4::jsonb,usage) WHERE id=$1 AND state='running'`,
      [
        id,
        metadata.environment ? JSON.stringify(metadata.environment) : null,
        metadata.threadId ?? null,
        metadata.usage ? JSON.stringify(metadata.usage) : null,
      ],
    );
  }
  async finishAgentSession(
    id: string,
    state: string,
    cleanup: string,
    changes?: AgentAttemptChanges,
    diagnostic?: Record<string, unknown>,
  ): Promise<void> {
    const artifact = changes
      ? JSON.stringify({
          ...changes,
          patch: undefined,
          patchBase64: changes.patch.toString("base64"),
        })
      : null;
    await this.pool.query(
      "UPDATE agent_sessions SET state=$2,cleanup=$3,artifact=$4,failure_diagnostic=$5,finished_at=clock_timestamp() WHERE id=$1 AND state='running'",
      [id, state, cleanup, artifact, diagnostic ? JSON.stringify(diagnostic) : null],
    );
  }
  async recoverAgentSessions(): Promise<void> {
    await this.pool
      .query(`UPDATE agent_sessions s SET state='interrupted',cleanup='unconfirmed',finished_at=clock_timestamp() WHERE s.state='running' AND NOT (
      (s.kind='implementation' AND EXISTS(SELECT 1 FROM jobs j WHERE j.id=s.source_id AND j.stage='running' AND j.lease_expires_at>clock_timestamp())) OR
      (s.kind='ci_repair' AND EXISTS(SELECT 1 FROM ci_repairs r WHERE r.id=s.source_id AND r.state='running' AND r.lease_expires_at>clock_timestamp())) OR
      (s.kind='pr_feedback' AND EXISTS(SELECT 1 FROM pr_feedback f WHERE f.id=s.source_id AND f.state='running' AND f.lease_expires_at>clock_timestamp()))
    )`);
  }
  async appendEvent(
    projectId: string,
    type: string,
    message: string,
    attemptId?: string,
    agentSessionId?: string,
  ): Promise<void> {
    await this.pool.query(
      "INSERT INTO project_events(project_id,type,message,job_id,agent_session_id) VALUES($1,$2,$3,$4,$5)",
      [projectId, type, message, attemptId ?? null, agentSessionId ?? null],
    );
  }
  async recordPublicationPhase(
    jobId: string,
    workerId: string,
    phase: PublicationPhase,
  ): Promise<void> {
    await this.transaction(async (client) => {
      const { row, project } = await lockJob(client, jobId, workerId);
      if (row.stage !== "publishing") throw conflict("Publication phase requires a publishing job");
      const previous = await client.query<{ message: string }>(
        "SELECT message FROM project_events WHERE project_id=$1 AND type=$2 ORDER BY id DESC LIMIT 1",
        [project.id, "publication_phase"],
      );
      const message = `Publication phase: ${phase}`;
      if (previous.rows[0]?.message !== message)
        await addEvent(client, project.id, "publication_phase", message, jobId);
    });
  }
  async saveArtifact(jobId: string, workerId: string, changes: AgentAttemptChanges): Promise<Job> {
    const artifact = artifactSchema.parse({
      ...changes,
      patchBase64: changes.patch.toString("base64"),
    });
    return this.transaction(async (client) => {
      const { row, project } = await lockJob(client, jobId, workerId);
      if (row.stage !== "running") throw conflict("Only a running attempt can save an artifact");
      const cancelled = project.stopRequested === "cancel";
      const paused = project.stopRequested === "pause";
      await client.query(
        "UPDATE jobs SET stage=$2,artifact=$3,lease_owner=CASE WHEN $4 THEN NULL ELSE lease_owner END,lease_expires_at=CASE WHEN $4 THEN NULL ELSE lease_expires_at END WHERE id=$1",
        [
          jobId,
          cancelled ? "cancelled" : "ready",
          cancelled ? null : JSON.stringify(artifact),
          cancelled || paused,
        ],
      );
      await client.query(
        "UPDATE projects SET state=$2,stop_requested=NULL,updated_at=clock_timestamp() WHERE id=$1",
        [project.id, cancelled ? "cancelled" : paused ? "paused" : "running"],
      );
      await addEvent(
        client,
        project.id,
        cancelled ? "cancelled" : paused ? "paused" : "artifact_ready",
        cancelled
          ? "Completed attempt discarded after cancellation"
          : paused
            ? "Captured artifact held while paused"
            : "Captured artifact saved durably",
        jobId,
      );
      const updated = await projectFrom(client, project.id);
      if (!updated) throw new Error("Missing artifact project");
      return decodeJob(await loadJob(client, jobId), updated);
    });
  }
  async beginPublication(jobId: string, workerId: string): Promise<boolean> {
    return this.transaction(async (client) => {
      const { row, project } = await lockJob(client, jobId);
      if (project.state === "paused" || project.state === "cancelled") return false;
      if (row.lease_owner !== workerId || !row.lease_valid)
        throw conflict("Worker lease expired or belongs to another worker");
      if (row.stage !== "ready" || !row.artifact)
        throw conflict("Publication requires a captured artifact ready for its first publication");
      await client.query("UPDATE jobs SET stage='publishing' WHERE id=$1", [jobId]);
      await addEvent(
        client,
        project.id,
        "publishing",
        "Publishing captured artifact from the trusted service",
        jobId,
      );
      return true;
    });
  }
  async completePublication(
    jobId: string,
    workerId: string,
    pullRequest: Omit<PullRequest, "state"> & { state?: PullRequest["state"] },
  ): Promise<Project> {
    const pr = projectSchema.shape.pullRequest.unwrap().parse({ state: "open", ...pullRequest });
    return this.transaction(async (client) => {
      const { row, project } = await lockJob(client, jobId, workerId);
      if (row.stage !== "publishing" || pr.branch !== row.branch)
        throw conflict("Publication does not match the expected attempt branch");
      await client.query(
        "UPDATE jobs SET stage='awaiting_review',pull_request=$2,lease_owner=NULL,lease_expires_at=NULL,publication_retry_count=0,publication_blocked=false WHERE id=$1",
        [jobId, JSON.stringify(pr)],
      );
      await client.query(
        "UPDATE projects SET state='awaiting_review',pull_request=$2,error=NULL,updated_at=clock_timestamp() WHERE id=$1",
        [project.id, JSON.stringify(pr)],
      );
      // Apply an already-known merge/close in this transaction before exposing capacity.
      if (pr.state !== "open") return this.reconcileReview(client, jobId, pr.state);
      await advanceProject(client, { ...project, state: "awaiting_review", error: null });
      await addEvent(
        client,
        project.id,
        "pull_request_opened",
        `Pull request #${pr.number} awaits review: ${pr.url}`,
        jobId,
      );
      const updated = await projectFrom(client, project.id);
      if (!updated) throw new Error("Missing published project");
      return updated;
    });
  }

  async publicationUncertain(
    jobId: string,
    workerId: string,
    error: string,
    diagnosticReference?: string,
  ): Promise<void> {
    await this.transaction(async (client) => {
      const { row, project } = await lockJob(client, jobId, workerId);
      if (row.stage !== "publishing")
        throw conflict("Only a started publication can have an uncertain outcome");
      const count = row.publication_retry_count + 1;
      const delayMs = publicationBackoffMs(count, this.retryRandom);
      const scheduled = await client.query<{ eligible_at: Date }>(
        "UPDATE jobs SET lease_owner=NULL,lease_expires_at=NULL,publication_retry_count=$2,eligible_at=clock_timestamp()+$3*interval '1 millisecond' WHERE id=$1 RETURNING eligible_at",
        [jobId, count, delayMs],
      );
      const message = `${error} Automatic publication recovery #${count} scheduled for ${scheduled.rows[0]!.eligible_at.toISOString()}. Saved work retained; no new model attempt.${diagnosticReference ? ` Failure reference: ${diagnosticReference}` : ""}`;
      await client.query(
        "UPDATE projects SET state='needs_attention',error=$2,updated_at=clock_timestamp() WHERE id=$1",
        [project.id, message],
      );
      // The status always carries the latest deadline/reference. The feed records
      // changed causes and increasing backoff tiers, not every identical capped retry.
      const previousCause = project.error?.split(" Automatic publication recovery #")[0];
      if (count <= 5 || previousCause !== error)
        await addEvent(client, project.id, "publication_uncertain", message, jobId);
    });
  }
  async blockPublication(
    jobId: string,
    workerId: string,
    reason: string,
    diagnosticReference?: string,
  ): Promise<void> {
    await this.transaction(async (client) => {
      const { row, project } = await lockJob(client, jobId, workerId);
      if (row.stage !== "publishing") throw conflict("Only publication may be blocked");
      await client.query(
        "UPDATE jobs SET publication_blocked=true,lease_owner=NULL,lease_expires_at=NULL WHERE id=$1",
        [jobId],
      );
      const message = `Automatic publication recovery stopped: ${reason}. Saved work retained; no new model attempt. Resolve the blocking issue before retrying publication.${diagnosticReference ? ` Failure reference: ${diagnosticReference}` : ""}`;
      await client.query(
        "UPDATE projects SET state='needs_attention',error=$2,updated_at=clock_timestamp() WHERE id=$1",
        [project.id, message],
      );
      await addEvent(client, project.id, "publication_blocked", message, jobId);
    });
  }
  async queueSavedPublication(
    jobId: string,
    ownerId: string,
    expectedBranch: string,
    expectedBaseCommit: string,
  ): Promise<Project> {
    return this.transaction(async (client) => {
      const { row, project } = await lockJob(client, jobId);
      if (project.ownerId !== ownerId) throw new StoreError(404, "Project not found");
      if (row.stage === "ready" && row.artifact && ["queued", "running"].includes(project.state))
        return project;
      const job = decodeJob(row, project);
      if (
        project.mode !== "live" ||
        row.stage !== "publishing" ||
        row.lease_valid ||
        !["needs_attention", "running"].includes(project.state) ||
        project.stopRequested === "cancel" ||
        !job.artifact ||
        row.branch !== expectedBranch ||
        job.artifact.baseCommit !== expectedBaseCommit ||
        !hasValidPublicationEvidence(project.repository, job.artifact)
      )
        throw conflict("Saved publication is no longer eligible for a safe retry");
      await client.query(
        "UPDATE jobs SET stage='ready',lease_owner=NULL,lease_expires_at=NULL,publication_blocked=false,eligible_at=clock_timestamp() WHERE id=$1",
        [jobId],
      );
      const paused = project.stopRequested === "pause";
      await client.query(
        "UPDATE projects SET state=$2,error=NULL,stop_requested=NULL,updated_at=clock_timestamp() WHERE id=$1",
        [project.id, paused ? "paused" : "queued"],
      );
      await addEvent(
        client,
        project.id,
        "publication_retry_queued",
        paused
          ? "Saved captured artifact held while paused; resume to publish it."
          : "Queued the saved captured artifact for publication; no new attempt will run.",
        jobId,
      );
      const updated = await projectFrom(client, project.id);
      if (!updated) throw new Error("Missing retried publication project");
      return updated;
    });
  }
  async fail(
    jobId: string,
    workerId: string,
    error: string,
    needsAttention = false,
    changes?: AgentAttemptChanges,
    diagnostic?: Record<string, unknown>,
  ): Promise<void> {
    await this.transaction(async (client) => {
      const { row, project } = await lockJob(client, jobId, workerId);
      if (!["running", "ready"].includes(row.stage))
        throw conflict("Only unpublished work may fail; publication must reconcile");
      const state = needsAttention
        ? "needs_attention"
        : project.stopRequested === "cancel"
          ? "cancelled"
          : "failed";
      const saved = changes
        ? JSON.stringify(
            artifactSchema.parse({
              ...changes,
              patchBase64: changes.patch.toString("base64"),
            }),
          )
        : null;
      await client.query(
        "UPDATE jobs SET stage=$2,lease_owner=NULL,lease_expires_at=NULL,artifact=CASE WHEN $2='cancelled' THEN NULL ELSE COALESCE($3,artifact) END,failure_diagnostic=$4::jsonb WHERE id=$1",
        [jobId, state, saved, diagnostic],
      );
      await client.query(
        "UPDATE projects SET state=$2,error=$3,stop_requested=NULL,updated_at=clock_timestamp() WHERE id=$1",
        [project.id, state, error],
      );
      await addEvent(client, project.id, state, error, jobId);
    });
  }
  async recoverExpired(): Promise<number> {
    return this.transaction(async (client) => {
      const abandoned = await client.query<{
        id: string;
      }>(`SELECT g.id FROM projects g JOIN jobs j ON j.project_id=g.id
        WHERE g.state='cancelled' AND g.cleanup_status='pending' AND j.cancel_cleanup_deadline<=clock_timestamp()
        FOR UPDATE OF g,j SKIP LOCKED`);
      for (const { id } of abandoned.rows) {
        await client.query(
          "UPDATE projects SET cleanup_status='needs_attention',updated_at=clock_timestamp() WHERE id=$1",
          [id],
        );
        await addEvent(
          client,
          id,
          "cleanup_required",
          "Cleanup confirmation timed out. Project remains cancelled; inspect remote resources.",
        );
        logFailure(new Error("Sandbox cleanup confirmation timed out"), {
          component: "sandbox-cleanup",
          projectId: id,
        });
      }
      const result = await client.query<
        Record<string, unknown>
      >(`SELECT j.id FROM jobs j JOIN projects g ON g.id=j.project_id
        WHERE j.lease_expires_at<=clock_timestamp() AND j.stage IN ('running','ready','publishing')
        FOR UPDATE OF g,j SKIP LOCKED`);
      for (const selected of result.rows) {
        const id = z.object({ id: z.string().uuid() }).parse(selected).id;
        const { row, project } = await lockJob(client, id);
        const uncertain = row.stage === "running" || row.stage === "publishing";
        await client.query(
          "UPDATE jobs SET stage=CASE WHEN stage='running' THEN 'needs_attention' ELSE stage END,lease_owner=NULL,lease_expires_at=NULL,eligible_at=clock_timestamp() WHERE id=$1",
          [id],
        );
        if (uncertain) {
          const error =
            row.stage === "running"
              ? "Worker connection was lost during an attempt. Use Retry to start a new attempt. The previous sandbox cleanup is unconfirmed; the paid attempt will not automatically repeat."
              : "Worker lease expired during publication; checking the existing branch before any further action.";
          await client.query(
            "UPDATE projects SET state='needs_attention',error=$2,stop_requested=$3,updated_at=clock_timestamp() WHERE id=$1",
            [project.id, error, row.stage === "publishing" ? project.stopRequested : null],
          );
          await addEvent(client, project.id, "recovery_required", error, row.id);
        } else
          await addEvent(
            client,
            project.id,
            "artifact_recovered",
            "Recovered saved artifact after worker lease expired",
            row.id,
          );
      }
      return result.rows.length;
    });
  }

  async startFeedback(
    jobId: string,
    context: PullRequestFeedback[],
    workerId: string,
  ): Promise<{ id: string; item: PullRequestFeedback } | null> {
    const items = context.filter((item) => !item.bot);
    return this.transaction(async (client) => {
      const { row, project } = await lockJob(client, jobId);
      if (
        row.stage !== "awaiting_review" ||
        project.stopRequested ||
        !["queued", "running", "awaiting_review"].includes(project.state)
      )
        return null;
      const blocked = await client.query(
        `SELECT 1 FROM pr_feedback WHERE job_id=$1 AND state IN ('running','failed')
         UNION ALL SELECT 1 FROM ci_repairs WHERE job_id=$1 AND state IN ('running','waiting','failed')`,
        [jobId],
      );
      if (blocked.rowCount) return null;
      // API reads are authoritative: deleted or edited pending feedback is superseded.
      const keys = items.map((item) => `${item.kind}:${item.id}:${item.revision}`);
      await client.query(
        `UPDATE pr_feedback SET state='completed' WHERE job_id=$1 AND state='pending'
        AND NOT (kind || ':' || external_id || ':' || revision = ANY($2::text[]))`,
        [jobId, keys],
      );
      for (const item of items)
        await client.query(
          `INSERT INTO pr_feedback(id,job_id,kind,external_id,revision,state)
          VALUES($1,$2,$3,$4,$5,'pending') ON CONFLICT DO NOTHING`,
          [randomUUID(), jobId, item.kind, item.id, item.revision],
        );
      const selected = await client.query<{
        id: string;
        kind: string;
        external_id: string;
        revision: string;
      }>(
        `SELECT id,kind,external_id,revision FROM pr_feedback WHERE job_id=$1 AND state='pending' ORDER BY created_at,id LIMIT 1`,
        [jobId],
      );
      const next = selected.rows[0];
      if (!next) return null;
      const item = items.find(
        (item) =>
          item.kind === next.kind &&
          String(item.id) === next.external_id &&
          item.revision === next.revision,
      )!;
      await client.query(
        `UPDATE pr_feedback SET state='running',lease_owner=$2,lease_expires_at=clock_timestamp()+interval '30 seconds' WHERE id=$1`,
        [next.id, workerId],
      );
      await addEvent(
        client,
        project.id,
        "pr_feedback_started",
        `Considering ${item.kind} feedback from ${item.author}: ${item.url}`,
        jobId,
      );
      return { id: next.id, item };
    });
  }

  async heartbeatFeedback(id: string, workerId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE pr_feedback f SET lease_expires_at=clock_timestamp()+interval '30 seconds'
      FROM jobs j JOIN projects g ON j.project_id=g.id
      WHERE f.id=$1 AND f.lease_owner=$2 AND f.job_id=j.id AND f.state='running' AND f.lease_expires_at>clock_timestamp()
      AND j.stage='awaiting_review' AND j.pull_request->>'state'='open'
      AND g.state IN ('queued','running','awaiting_review') AND g.stop_requested IS NULL`,
      [id, workerId],
    );
    return result.rowCount === 1;
  }

  async saveFeedbackArtifact(
    id: string,
    workerId: string,
    changes: AgentAttemptChanges,
  ): Promise<void> {
    const { patch, ...metadata } = changes;
    const result = await this.pool.query(
      `UPDATE pr_feedback SET artifact=$3 WHERE id=$1 AND lease_owner=$2
      AND state='running' AND lease_expires_at>clock_timestamp()`,
      [id, workerId, JSON.stringify({ ...metadata, patchBase64: patch.toString("base64") })],
    );
    if (result.rowCount !== 1) throw conflict("Feedback lease lost");
  }

  async recordFeedbackPublication(id: string, workerId: string, pr: PullRequest): Promise<void> {
    await this.transaction(async (client) => {
      const result = await client.query<{ job_id: string; project_id: string }>(
        `SELECT f.job_id,j.project_id FROM pr_feedback f JOIN jobs j ON f.job_id=j.id
        WHERE f.id=$1 AND f.lease_owner=$2 AND f.state='running' AND f.lease_expires_at>clock_timestamp() FOR UPDATE OF f`,
        [id, workerId],
      );
      const row = result.rows[0];
      if (!row) throw conflict("Feedback lease lost");
      await client.query("UPDATE jobs SET pull_request=$2,ci_review_requested=true WHERE id=$1", [
        row.job_id,
        JSON.stringify(pr),
      ]);
      await client.query(
        "UPDATE projects SET pull_request=$2 WHERE id=$1 AND pull_request->>'branch'=$3",
        [row.project_id, JSON.stringify(pr), pr.branch],
      );
    });
  }

  async finishFeedback(
    id: string,
    workerId: string,
    succeeded: boolean,
    message: string,
  ): Promise<void> {
    await this.transaction(async (client) => {
      const result = await client.query<{ job_id: string; project_id: string }>(
        `UPDATE pr_feedback f SET state=$3
        FROM jobs j WHERE f.id=$1 AND f.lease_owner=$2 AND f.state='running' AND f.lease_expires_at>clock_timestamp() AND f.job_id=j.id
        RETURNING f.job_id,j.project_id`,
        [id, workerId, succeeded ? "completed" : "failed"],
      );
      if (!result.rows[0]) return;
      const { job_id, project_id } = result.rows[0];
      await client.query("UPDATE jobs SET feedback_requested=true WHERE id=$1", [job_id]);
      await addEvent(
        client,
        project_id,
        succeeded ? "pr_feedback_completed" : "pr_feedback_failed",
        message,
        job_id,
      );
    });
  }

  async recoverFeedback(): Promise<void> {
    await this.transaction(async (client) => {
      const result = await client.query<{
        job_id: string;
        project_id: string;
      }>(`UPDATE pr_feedback f SET state='failed'
        FROM jobs j WHERE f.job_id=j.id AND f.state='running' AND f.lease_expires_at<=clock_timestamp() RETURNING f.job_id,j.project_id`);
      for (const row of result.rows)
        await addEvent(
          client,
          row.project_id,
          "pr_feedback_failed",
          "Feedback lease expired. Inspect sandbox cleanup and PR writes before manual recovery; feedback will not be replayed.",
          row.job_id,
        );
    });
  }

  async requestFeedbackReview(repository?: string): Promise<void> {
    await this.pool.query(
      `UPDATE jobs j SET feedback_requested=true FROM projects g
      WHERE j.project_id=g.id AND g.mode='live' AND j.stage='awaiting_review'
      AND j.pull_request->>'state'='open' AND ($1::text IS NULL OR lower(g.repository)=lower($1))`,
      [repository ?? null],
    );
  }

  async takeFeedbackReview(): Promise<Job | null> {
    return this.transaction(async (client) => {
      const selected = await client.query<{
        id: string;
      }>(`SELECT j.id FROM jobs j JOIN projects g ON j.project_id=g.id
        WHERE j.feedback_requested AND j.stage='awaiting_review' AND g.mode='live'
        AND g.state IN ('queued','running','awaiting_review') AND g.stop_requested IS NULL
        ORDER BY j.feedback_reviewed_at NULLS FIRST,j.created_at,j.id LIMIT 1 FOR UPDATE OF g,j SKIP LOCKED`);
      const id = selected.rows[0]?.id;
      if (!id) return null;
      const { row, project } = await lockJob(client, id);
      await client.query(
        "UPDATE jobs SET feedback_requested=false,feedback_reviewed_at=clock_timestamp() WHERE id=$1",
        [id],
      );
      return decodeJob(row, project);
    });
  }

  async requestCiReview(repository?: string): Promise<void> {
    await this.pool.query(
      `UPDATE jobs j SET ci_review_requested=true FROM projects g
      WHERE j.project_id=g.id AND g.mode='live' AND j.stage='awaiting_review'
      AND j.pull_request->>'state'='open' AND ($1::text IS NULL OR lower(g.repository)=lower($1))`,
      [repository ?? null],
    );
  }

  async takeCiReview(): Promise<Job | null> {
    return this.transaction(async (client) => {
      const selected = await client.query<{
        id: string;
      }>(`SELECT j.id FROM jobs j JOIN projects g ON j.project_id=g.id
        WHERE j.ci_review_requested AND j.stage='awaiting_review' AND g.mode='live'
        AND g.state IN ('queued','running','awaiting_review') AND g.stop_requested IS NULL
        ORDER BY j.ci_reviewed_at NULLS FIRST,j.created_at,j.id LIMIT 1 FOR UPDATE OF g,j SKIP LOCKED`);
      const id = selected.rows[0]?.id;
      if (!id) return null;
      const { row, project } = await lockJob(client, id);
      await client.query(
        "UPDATE jobs SET ci_review_requested=false,ci_reviewed_at=clock_timestamp() WHERE id=$1",
        [id],
      );
      return decodeJob(row, project);
    });
  }

  async ciReviewActive(jobId: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM jobs j JOIN projects g ON j.project_id=g.id
      WHERE j.id=$1 AND j.stage='awaiting_review' AND j.pull_request->>'state'='open'
      AND g.mode='live' AND g.state IN ('queued','running','awaiting_review') AND g.stop_requested IS NULL`,
      [jobId],
    );
    return result.rowCount === 1;
  }

  async beginReadiness(jobId: string): Promise<void> {
    const result = await this.pool.query(
      `UPDATE jobs j SET readiness_pending=true FROM projects g
      WHERE j.id=$1 AND j.project_id=g.id AND j.stage='awaiting_review' AND j.pull_request->>'state'='open'
      AND g.mode='live' AND g.state IN ('queued','running','awaiting_review') AND g.stop_requested IS NULL`,
      [jobId],
    );
    if (result.rowCount !== 1) throw conflict("Project stopped before marking PR ready");
  }

  async cancelReadiness(jobId: string): Promise<void> {
    await this.pool.query("UPDATE jobs SET readiness_pending=false WHERE id=$1", [jobId]);
  }

  async confirmReadiness(jobId: string, url: string): Promise<void> {
    await this.transaction(async (client) => {
      const result = await client.query<{ project_id: string; pull_request: PullRequest }>(
        `UPDATE jobs SET readiness_pending=false
        WHERE id=$1 AND readiness_pending RETURNING project_id,pull_request`,
        [jobId],
      );
      if (result.rows[0])
        await addEvent(
          client,
          result.rows[0].project_id,
          "pull_request_ready",
          `Pull request #${result.rows[0].pull_request.number} is ready for review: ${url}`,
          jobId,
        );
    });
  }

  async retryCiRepair(projectId: string, ownerId: string, repairId: string): Promise<Project> {
    return this.transaction(async (client) => {
      const project = await projectFrom(client, projectId, true);
      if (!project || project.ownerId !== ownerId) throw new StoreError(404, "Project not found");
      if (
        project.stopRequested ||
        !["queued", "running", "awaiting_review"].includes(project.state)
      )
        throw conflict("Resume the project before retrying a repair");
      const result = await client.query<{ job_id: string; head: string }>(
        `SELECT r.job_id,r.head FROM ci_repairs r JOIN jobs j ON j.id=r.job_id
         WHERE r.id=$1 AND j.project_id=$2 AND j.stage='awaiting_review'
         AND j.pull_request->>'state'='open' AND r.state='failed'
         AND r.retryable AND NOT r.publication_started FOR UPDATE OF r,j`,
        [repairId, projectId],
      );
      const repair = result.rows[0];
      if (!repair) {
        const queued = await client.query(
          "SELECT 1 FROM ci_repairs r JOIN jobs j ON j.id=r.job_id WHERE r.retry_of=$1 AND j.project_id=$2",
          [repairId, projectId],
        );
        if (queued.rowCount) return project;
        throw conflict("This repair cannot be safely retried");
      }
      const feedback = await client.query(
        "SELECT 1 FROM pr_feedback WHERE job_id=$1 AND state IN ('running','failed')",
        [repair.job_id],
      );
      if (feedback.rowCount)
        throw conflict("Resolve the pending PR feedback before retrying a repair");
      await client.query("UPDATE ci_repairs SET state='superseded' WHERE id=$1", [repairId]);
      await client.query(
        `INSERT INTO ci_repairs(id,job_id,head,state,lease_owner,lease_expires_at,retry_of)
         VALUES($1,$2,$3,'waiting','',clock_timestamp(),$4)`,
        [randomUUID(), repair.job_id, repair.head, repairId],
      );
      await client.query("UPDATE jobs SET ci_review_requested=true WHERE id=$1", [repair.job_id]);
      await addEvent(
        client,
        projectId,
        "ci_repair_retry_queued",
        "Manual repair retry queued",
        repair.job_id,
      );
      return (await projectFrom(client, projectId))!;
    });
  }

  async startCiRepair(jobId: string, head: string, workerId: string): Promise<string | null> {
    return this.transaction(async (client) => {
      const { row, project } = await lockJob(client, jobId);
      if (
        row.stage !== "awaiting_review" ||
        project.stopRequested ||
        !["queued", "running", "awaiting_review"].includes(project.state)
      )
        return null;
      if (
        (
          await client.query(
            "SELECT 1 FROM pr_feedback WHERE job_id=$1 AND state IN ('running','failed')",
            [jobId],
          )
        ).rowCount
      )
        return null;
      const knownHead = project.pullRequests.find((pr) => pr.branch === row.branch)?.headSha;
      if (knownHead && knownHead !== head) {
        await client.query(
          "UPDATE projects SET state='paused',stop_requested=NULL,updated_at=clock_timestamp() WHERE id=$1",
          [project.id],
        );
        await addEvent(
          client,
          project.id,
          "external_change_paused",
          "Pull request code changed outside Herbie. Agent paused.",
          jobId,
        );
        return null;
      }
      const waiting = await client.query<{ id: string; head: string }>(
        "SELECT id,head FROM ci_repairs WHERE job_id=$1 AND state='waiting' FOR UPDATE",
        [jobId],
      );
      if (waiting.rows.some((repair) => repair.head !== head)) {
        await client.query(
          "UPDATE ci_repairs SET state='completed' WHERE job_id=$1 AND state='waiting'",
          [jobId],
        );
        await client.query(
          "UPDATE projects SET state='paused',stop_requested=NULL,updated_at=clock_timestamp() WHERE id=$1",
          [project.id],
        );
        await addEvent(
          client,
          project.id,
          "external_change_paused",
          "Pull request code changed outside Herbie. Agent paused.",
          jobId,
        );
        return null;
      }
      await this.discardWaitingCiWith(client, jobId, head);
      const resumed = await client.query<{ id: string }>(
        `UPDATE ci_repairs SET state='running',lease_owner=$3,lease_expires_at=clock_timestamp()+interval '30 seconds'
        WHERE job_id=$1 AND head=$2 AND state='waiting' RETURNING id`,
        [jobId, head, workerId],
      );
      if (resumed.rows[0]) return resumed.rows[0].id;
      const previous = await client.query<{ head: string; state: string }>(
        "SELECT head,state FROM ci_repairs WHERE job_id=$1 AND state <> 'superseded'",
        [jobId],
      );
      if (
        previous.rows.length >= 3 ||
        previous.rows.some((r) => r.head === head || r.state !== "completed")
      )
        return null;
      const id = randomUUID();
      await client.query(
        `INSERT INTO ci_repairs(id,job_id,head,state,lease_owner,lease_expires_at)
        VALUES($1,$2,$3,'running',$4,clock_timestamp()+interval '30 seconds')`,
        [id, jobId, head, workerId],
      );
      await addEvent(
        client,
        project.id,
        "ci_repair_started",
        `Repairing failing CI on ${row.branch} at ${head}`,
        jobId,
      );
      return id;
    });
  }

  async pauseCiRepairForExternalChange(id: string, jobId: string): Promise<void> {
    await this.transaction(async (client) => {
      const { project } = await lockJob(client, jobId);
      await client.query(
        "UPDATE ci_repairs SET state='completed' WHERE id=$1 AND job_id=$2 AND state='running'",
        [id, jobId],
      );
      await client.query(
        "UPDATE projects SET state='paused',stop_requested=NULL,updated_at=clock_timestamp() WHERE id=$1 AND state IN ('queued','running','awaiting_review')",
        [project.id],
      );
      await addEvent(
        client,
        project.id,
        "external_change_paused",
        "Pull request code changed outside Herbie. Agent paused.",
        jobId,
      );
    });
  }

  async heartbeatCiRepair(id: string, workerId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ci_repairs r SET lease_expires_at=clock_timestamp()+interval '30 seconds'
      FROM jobs j JOIN projects g ON j.project_id=g.id WHERE r.id=$1 AND r.lease_owner=$2
      AND r.job_id=j.id AND r.state='running' AND r.lease_expires_at>clock_timestamp()
      AND j.stage='awaiting_review' AND j.pull_request->>'state'='open'
      AND g.state IN ('queued','running','awaiting_review') AND g.stop_requested IS NULL`,
      [id, workerId],
    );
    return result.rowCount === 1;
  }

  async ciArtifact(id: string): Promise<AgentAttemptChanges | null> {
    const result = await this.pool.query<{ artifact: unknown }>(
      "SELECT artifact FROM ci_repairs WHERE id=$1",
      [id],
    );
    return decodeArtifact(artifactSchema.nullable().parse(result.rows[0]?.artifact));
  }

  async waitForCi(id: string, workerId: string, jobId: string): Promise<void> {
    await this.transaction(async (client) => {
      const { row } = await lockJob(client, jobId);
      if (row.stage !== "awaiting_review") throw conflict("PR no longer awaiting review");
      const result = await client.query(
        `UPDATE ci_repairs SET state='waiting' WHERE id=$1 AND lease_owner=$2
      AND state='running' AND lease_expires_at>clock_timestamp() AND artifact IS NOT NULL`,
        [id, workerId],
      );
      if (result.rowCount !== 1) throw conflict("CI repair lease lost");
    });
  }

  async discardWaitingCi(jobId: string): Promise<void> {
    await this.transaction((client) => this.discardWaitingCiWith(client, jobId));
  }

  private async discardWaitingCiWith(
    client: PoolClient,
    jobId: string,
    keepHead?: string,
  ): Promise<void> {
    const result = await client.query<{ project_id: string; head: string }>(
      `UPDATE ci_repairs r SET state='completed' FROM jobs j
      WHERE r.job_id=$1 AND r.job_id=j.id AND r.state='waiting'
      AND ($2::text IS NULL OR r.head<>$2) RETURNING j.project_id,r.head`,
      [jobId, keepHead ?? null],
    );
    for (const row of result.rows)
      await addEvent(
        client,
        row.project_id,
        "ci_repair_completed",
        `CI repair at ${row.head} discarded: checks or PR state changed.`,
        jobId,
      );
  }

  async saveCiArtifact(id: string, workerId: string, changes: AgentAttemptChanges): Promise<void> {
    const { patch, ...metadata } = changes;
    const result = await this.pool.query(
      `UPDATE ci_repairs SET artifact=$3 WHERE id=$1 AND lease_owner=$2
      AND state='running' AND lease_expires_at>clock_timestamp()`,
      [id, workerId, JSON.stringify({ ...metadata, patchBase64: patch.toString("base64") })],
    );
    if (result.rowCount !== 1) throw conflict("CI repair lease lost");
  }

  async beginCiPublication(id: string, workerId: string): Promise<void> {
    const result = await this.pool.query(
      `UPDATE ci_repairs SET publication_started=true WHERE id=$1 AND lease_owner=$2
      AND state='running' AND lease_expires_at>clock_timestamp() AND artifact IS NOT NULL`,
      [id, workerId],
    );
    if (result.rowCount !== 1) throw conflict("CI repair lease lost");
  }

  async finishCiRepair(
    id: string,
    workerId: string,
    succeeded: boolean,
    message: string,
    publishedHeadSha?: string,
    retryable = false,
  ): Promise<void> {
    await this.transaction(async (client) => {
      const result = await client.query<{ project_id: string; job_id: string }>(
        `UPDATE ci_repairs r SET state=$3,retryable=$4 AND NOT r.publication_started FROM jobs j
        WHERE r.id=$1 AND r.lease_owner=$2 AND r.state='running' AND r.job_id=j.id RETURNING j.project_id,j.id AS job_id`,
        [id, workerId, succeeded ? "completed" : "failed", retryable],
      );
      if (result.rows[0])
        if (publishedHeadSha)
          await client.query(
            "UPDATE jobs SET pull_request=jsonb_set(pull_request,'{headSha}',to_jsonb($2::text),true) WHERE id=$1",
            [result.rows[0].job_id, publishedHeadSha],
          );
      if (result.rows[0])
        await addEvent(
          client,
          result.rows[0].project_id,
          succeeded ? "ci_repair_completed" : "ci_repair_failed",
          message,
          result.rows[0].job_id,
        );
    });
  }

  async recoverCiRepairs(): Promise<void> {
    await this.transaction(async (client) => {
      const expired = await client.query<{ id: string; job_id: string }>(
        "SELECT id,job_id FROM ci_repairs WHERE state='running' AND lease_expires_at<=clock_timestamp()",
      );
      for (const repair of expired.rows) {
        const { row: job, project } = await lockJob(client, repair.job_id);
        const result = await client.query<{ state: string }>(
          `UPDATE ci_repairs SET state=CASE WHEN artifact IS NOT NULL AND NOT publication_started AND $2 THEN 'waiting' ELSE 'failed' END
          WHERE id=$1 AND state='running' AND lease_expires_at<=clock_timestamp() RETURNING state`,
          [repair.id, job.stage === "awaiting_review"],
        );
        const row = result.rows[0];
        if (row)
          await addEvent(
            client,
            project.id,
            row.state === "waiting" ? "ci_repair" : "ci_repair_failed",
            row.state === "waiting"
              ? "Recovered saved CI repair before publication; waiting to recheck current CI."
              : "CI repair lease expired. Inspect sandbox cleanup and the PR head before manual recovery; the repair will not be replayed.",
            repair.job_id,
          );
      }
    });
  }

  async reviewJobs(mode?: "demo" | "live", pendingReadiness = false): Promise<Job[]> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT j.*, (j.lease_expires_at > clock_timestamp()) IS TRUE AS lease_valid FROM jobs j JOIN projects g ON g.id=j.project_id
      WHERE ${pendingReadiness ? "j.readiness_pending" : "j.stage IN ('awaiting_review','cancelled') AND j.pull_request->>'state'='open'"}
      AND ($1::text IS NULL OR g.mode=$1) ORDER BY j.created_at`,
      [mode ?? null],
    );
    const jobs: Job[] = [];
    for (const selected of result.rows) {
      const row = jobRow.parse(selected);
      const project = await projectFrom(this.pool, row.project_id);
      if (project) jobs.push(decodeJob(row, project));
    }
    return jobs;
  }
  async reconcile(
    jobId: string,
    outcome: "merged" | "closed",
    current: Partial<PullRequest> = {},
  ): Promise<Project> {
    return this.transaction((client) => this.reconcileReview(client, jobId, outcome, current));
  }
  async reconcilePullRequestHead(jobId: string, current: Partial<PullRequest>): Promise<boolean> {
    return this.transaction(async (client) => {
      const { row, project } = await lockJob(client, jobId);
      const pr = project.pullRequests.find((item) => item.branch === row.branch);
      if (row.stage !== "awaiting_review" || pr?.state !== "open") return false;
      const tracked = {
        ...pullRequestMetadataSchema.parse(current),
        ...(current.headSha ? { headSha: current.headSha } : {}),
        ...(current.baseSha ? { baseSha: current.baseSha } : {}),
        ...(current.patchSha ? { patchSha: current.patchSha } : {}),
      };
      const updateTrackedPullRequest = async (fields: Partial<PullRequest> = tracked) => {
        const value = JSON.stringify(fields);
        await client.query("UPDATE jobs SET pull_request=pull_request || $2::jsonb WHERE id=$1", [
          jobId,
          value,
        ]);
        await client.query(
          "UPDATE projects SET pull_request=pull_request || $3::jsonb WHERE id=$1 AND pull_request->>'branch'=$2",
          [project.id, row.branch, value],
        );
      };
      if (!pr.headSha) {
        await updateTrackedPullRequest();
        return false;
      }
      if (pr.headSha === current.headSha) {
        if (Object.entries(tracked).some(([key, value]) => pr[key as keyof PullRequest] !== value))
          await updateTrackedPullRequest();
        return false;
      }
      // Refresh displayed readiness even when external changes pause further work.
      // Keep the tracked head unchanged so the external-change guard still applies.
      await updateTrackedPullRequest({
        ...pullRequestMetadataSchema.parse(current),
        checksPassed: current.checksPassed === true,
      });
      if (!["queued", "running", "awaiting_review"].includes(project.state)) return false;
      // A feedback push can reach GitHub before its confirmed head is saved here.
      // Its worker checks the head before writes; defer external-change detection until it finishes.
      if (
        (
          await client.query(
            "SELECT 1 FROM pr_feedback WHERE job_id=$1 AND state='running' AND lease_expires_at>clock_timestamp()",
            [jobId],
          )
        ).rowCount
      )
        return false;
      if (pr.patchSha && current.patchSha && pr.patchSha === current.patchSha) {
        await updateTrackedPullRequest();
        return false;
      }
      const active = await client.query(
        "SELECT 1 FROM jobs WHERE project_id=$1 AND stage IN ('running','publishing') LIMIT 1",
        [project.id],
      );
      await client.query(
        "UPDATE projects SET state=$2,stop_requested=$3,updated_at=clock_timestamp() WHERE id=$1",
        [project.id, active.rowCount ? "running" : "paused", active.rowCount ? "pause" : null],
      );
      await client.query(
        "UPDATE ci_repairs SET state='completed' WHERE job_id=$1 AND state IN ('waiting','running')",
        [jobId],
      );
      await addEvent(
        client,
        project.id,
        "external_change_paused",
        `Pull request #${pr.number} was changed outside Herbie. Agent paused.`,
        jobId,
      );
      return true;
    });
  }
  private async reconcileReview(
    client: PoolClient,
    jobId: string,
    outcome: "merged" | "closed",
    current: Partial<PullRequest> = {},
  ): Promise<Project> {
    const { row, project } = await lockJob(client, jobId);
    const pr = project.pullRequests.find((pr) => pr.branch === row.branch);
    if (row.stage === "completed" || (row.stage === "cancelled" && pr?.state !== "open"))
      return project;
    if (!["awaiting_review", "cancelled"].includes(row.stage) || !pr)
      throw conflict("Only a published pull request can be reconciled");
    await this.discardWaitingCiWith(client, jobId);
    const closed = outcome === "closed";
    const updatedPr = JSON.stringify({
      ...pr,
      ...pullRequestMetadataSchema.parse(current),
      state: outcome,
    });
    await client.query(
      "UPDATE jobs SET stage=$2,pull_request=$3,lease_owner=NULL,lease_expires_at=NULL WHERE id=$1",
      [jobId, closed ? "cancelled" : "completed", updatedPr],
    );
    await client.query(
      "UPDATE projects SET pull_request=CASE WHEN pull_request->>'branch'=$2 THEN $3::jsonb ELSE pull_request END WHERE id=$1",
      [project.id, row.branch, updatedPr],
    );
    if (closed && !["cancelled", "failed", "needs_attention"].includes(project.state)) {
      const active = await client.query(
        "SELECT 1 FROM jobs WHERE project_id=$1 AND stage IN ('running','publishing')",
        [project.id],
      );
      await client.query(
        "UPDATE projects SET state=$2,stop_requested=$3,updated_at=clock_timestamp() WHERE id=$1",
        [project.id, active.rowCount ? "running" : "paused", active.rowCount ? "pause" : null],
      );
      if (!active.rowCount)
        await client.query(
          "UPDATE jobs SET lease_owner=NULL,lease_expires_at=NULL WHERE project_id=$1 AND stage IN ('queued','ready')",
          [project.id],
        );
    } else await advanceProject(client, project);
    const updated = await projectFrom(client, project.id);
    if (!updated) throw new Error("Missing reconciled project");
    await addEvent(
      client,
      project.id,
      closed ? "pull_request_closed" : "pull_request_merged",
      closed
        ? "Pull request closed without merging; project pause requested"
        : "Pull request merged",
      jobId,
    );
    return updated;
  }
}
