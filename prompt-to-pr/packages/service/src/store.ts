import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool, type PoolClient } from "pg";
import {
  ApiError,
  type Page,
  type Repository,
  type Run,
  type RunEvent,
  type RunInput,
  type RunStatus,
} from "@prompt-to-pr/contracts";
import type { Artifact } from "./artifact.js";

export type StoredRun = {
  id: string;
  owner_id: string;
  repository: Repository;
  installation_id: string;
  prompt: string;
  request_hash: string;
  status: RunStatus;
  stage: string;
  created_at: Date;
  updated_at: Date;
  lease_owner: string | null;
  base_sha: string | null;
  sandbox_id: string | null;
  artifact: Artifact | null;
  cleanup_complete: boolean;
  expected_sha: string | null;
  pull_request: Run["pullRequest"];
  summary: string | null;
  error: Run["error"];
};
export const publicRun = (row: StoredRun): Run => ({
  id: row.id,
  repository: row.repository,
  prompt: row.prompt,
  status: row.status,
  stage: row.stage,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  pullRequest: row.pull_request,
  summary: row.summary,
  error: row.error,
});

export class Store {
  constructor(public pool: Pool) {}

  async migrate() {
    await this.pool.query(await readFile(new URL("./schema.sql", import.meta.url), "utf8"));
  }

  private async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async create(
    ownerId: string,
    input: RunInput,
    key: string,
    repository: Repository,
    installationId: number,
  ): Promise<Run> {
    const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [ownerId]);
      const existing = await client.query<StoredRun>(
        "SELECT * FROM runs WHERE owner_id=$1 AND idempotency_key=$2",
        [ownerId, key],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== hash)
          throw new ApiError(
            409,
            "key_reused",
            "This submission key was already used for a different prompt",
          );
        return publicRun(existing.rows[0]);
      }
      const count = await client.query(
        "SELECT count(*) FROM runs WHERE owner_id=$1 AND status IN ('queued','running')",
        [ownerId],
      );
      if (Number(count.rows[0].count) >= 5)
        throw new ApiError(
          429,
          "queue_full",
          "Wait for one of your five active or queued runs to finish",
        );
      const { rows } = await client.query<StoredRun>(
        `INSERT INTO runs(id,owner_id,repository,installation_id,prompt,idempotency_key,request_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [randomUUID(), ownerId, repository, installationId, input.prompt, key, hash],
      );
      await client.query(
        "INSERT INTO run_events(run_id,stage,message) VALUES($1,'queued','Run accepted')",
        [rows[0].id],
      );
      return publicRun(rows[0]);
    });
  }

  async get(ownerId: string, id: string): Promise<Run> {
    const { rows } = await this.pool.query<StoredRun>(
      "SELECT * FROM runs WHERE id=$1 AND owner_id=$2",
      [id, ownerId],
    );
    if (!rows[0]) throw new ApiError(404, "not_found", "Run not found");
    return publicRun(rows[0]);
  }

  async list(ownerId: string, cursor?: { createdAt: string; id: string }): Promise<Page<Run>> {
    const { rows } = await this.pool.query<StoredRun>(
      `SELECT * FROM runs WHERE owner_id=$1
      AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid))
      ORDER BY created_at DESC,id DESC LIMIT 51`,
      [ownerId, cursor?.createdAt ?? null, cursor?.id ?? null],
    );
    const page = rows.slice(0, 50);
    const last = page.at(-1);
    return {
      items: page.map(publicRun),
      nextCursor:
        rows.length > 50 && last
          ? Buffer.from(
              JSON.stringify({ createdAt: last.created_at.toISOString(), id: last.id }),
            ).toString("base64url")
          : null,
    };
  }

  async events(ownerId: string, id: string, after: string): Promise<Page<RunEvent>> {
    await this.get(ownerId, id);
    const { rows } = await this.pool.query(
      "SELECT * FROM run_events WHERE run_id=$1 AND id>$2 ORDER BY id LIMIT 101",
      [id, after],
    );
    const items = rows.slice(0, 100).map((row) => ({
      id: String(row.id),
      stage: row.stage,
      message: row.message,
      createdAt: row.created_at.toISOString(),
    }));
    return { items, nextCursor: rows.length > 100 ? items.at(-1)!.id : null };
  }

  async claim(workerId: string): Promise<StoredRun | null> {
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(738212)");
      const blocked = await client.query(
        "SELECT 1 FROM runs WHERE status='running' OR (status='needs_attention' AND NOT cleanup_complete) LIMIT 1",
      );
      if (blocked.rowCount) return null;
      const { rows } = await client.query<StoredRun>(
        `UPDATE runs SET status='running',stage='preparing',lease_owner=$1,
        lease_expires_at=clock_timestamp()+interval '60 seconds',updated_at=clock_timestamp()
        WHERE id=(SELECT id FROM runs WHERE status='queued' ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`,
        [workerId],
      );
      if (rows[0])
        await client.query(
          "INSERT INTO run_events(run_id,stage,message) VALUES($1,'preparing','Worker started')",
          [rows[0].id],
        );
      return rows[0] ?? null;
    });
  }

  async heartbeat(id: string, workerId: string) {
    const result = await this.pool.query(
      `UPDATE runs SET lease_expires_at=clock_timestamp()+interval '60 seconds'
      WHERE id=$1 AND lease_owner=$2 AND status='running' AND lease_expires_at>clock_timestamp()`,
      [id, workerId],
    );
    if (!result.rowCount) throw new Error("Run lease lost");
  }

  async checkpoint(
    id: string,
    workerId: string,
    fields: {
      stage?: string;
      base_sha?: string;
      sandbox_id?: string;
      artifact?: Artifact;
      cleanup_complete?: boolean;
      expected_sha?: string;
      status?: RunStatus;
      pull_request?: Run["pullRequest"];
      summary?: string;
      error?: Run["error"];
      failure_diagnostic?: { stage: string; exitCode?: number; output: string };
    },
    message?: string,
  ) {
    const names = Object.keys(fields);
    const allowed = new Set([
      "stage",
      "base_sha",
      "sandbox_id",
      "artifact",
      "cleanup_complete",
      "expected_sha",
      "status",
      "pull_request",
      "summary",
      "error",
      "failure_diagnostic",
    ]);
    if (!names.length || names.some((name) => !allowed.has(name)))
      throw new Error("Invalid checkpoint");
    return this.transaction(async (client) => {
      const { rows } = await client.query<StoredRun>(
        `UPDATE runs SET ${names.map((name, i) => `${name}=$${i + 3}`).join(",")},updated_at=clock_timestamp()
        WHERE id=$1 AND lease_owner=$2 AND status='running' AND lease_expires_at>clock_timestamp() RETURNING *`,
        [id, workerId, ...Object.values(fields)],
      );
      if (!rows[0]) throw new Error("Run lease lost");
      if (message)
        await client.query("INSERT INTO run_events(run_id,stage,message) VALUES($1,$2,$3)", [
          id,
          rows[0].stage,
          message.slice(0, 2000),
        ]);
      return rows[0];
    });
  }

  async markInterrupted() {
    await this.transaction(async (client) => {
      const { rows } =
        await client.query(`UPDATE runs SET status='needs_attention',updated_at=clock_timestamp(),
        error='{"code":"worker_interrupted","message":"Worker interrupted; inspect execution and publication before recovery"}'::jsonb
        WHERE status='running' AND lease_expires_at<=clock_timestamp() RETURNING id,stage`);
      for (const row of rows)
        await client.query(
          "INSERT INTO run_events(run_id,stage,message) VALUES($1,$2,'Worker interrupted; automatic execution will not repeat')",
          [row.id, row.stage],
        );
    });
  }

  async claimPublication(id: string, workerId: string): Promise<StoredRun> {
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(738212)");
      if ((await client.query("SELECT 1 FROM runs WHERE status='running' LIMIT 1")).rowCount)
        throw new Error("Stop the worker and wait for active execution to finish before recovery");
      const { rows } = await client.query<StoredRun>(
        `UPDATE runs SET status='running',stage='publishing',error=NULL,
        lease_owner=$2,lease_expires_at=clock_timestamp()+interval '60 seconds',updated_at=clock_timestamp()
        WHERE id=$1 AND status IN ('failed','needs_attention') AND cleanup_complete
        AND artifact IS NOT NULL AND base_sha IS NOT NULL RETURNING *`,
        [id, workerId],
      );
      if (!rows[0])
        throw new Error(
          "Recovery requires saved changes, confirmed cleanup, and a failed or interrupted run",
        );
      await client.query(
        "INSERT INTO run_events(run_id,stage,message) VALUES($1,'publishing','Operator requested publication recovery; agent will not rerun')",
        [id],
      );
      return rows[0];
    });
  }
}
