import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { goalInput, goalSchema, eventSchema, type Goal, type GoalInput, type GoalAction, type GoalEvent } from '@herbie/contracts';
import type { DaytonaAttemptChanges } from '@herbie/loop/daytona-attempt';

const goalColumns = `id, owner_id AS "ownerId", repository, prompt, test_command AS "testCommand",
  max_attempts AS "maxAttempts", attempt_count AS "attemptCount", mode, state, stop_requested AS "stopRequested",
  pull_request AS "pullRequest", error, created_at AS "createdAt", updated_at AS "updatedAt"`;
const databaseGoal = goalSchema.extend({ createdAt: z.date().transform(d => d.toISOString()), updatedAt: z.date().transform(d => d.toISOString()) });
const artifactSchema = z.object({
  baseCommit: z.string(), patchBase64: z.string(),
  testResult: z.object({ exitCode: z.number().int(), stdout: z.string(), stderr: z.string() }).optional(),
  verification: z.object({ repoUrl: z.string(), baseCommit: z.string(), patchSha256: z.string(), testCommand: z.array(z.string()), goalCompleted: z.literal(true), sandboxDeleted: z.literal(true) }).optional(),
});
const jobRow = z.object({
  id: z.string().uuid(), goal_id: z.string().uuid(), branch: z.string(), cycle: z.number().int(),
  stage: z.enum(['queued','running','ready','publishing','awaiting_review','completed','cancelled','failed','needs_attention']),
  artifact: artifactSchema.nullable(), lease_owner: z.string().nullable(),
  lease_expires_at: z.date().nullable(), lease_valid: z.boolean(),
});
export interface Job {
  id: string; attemptId: string; goal: Goal; branch: string;
  stage: z.infer<typeof jobRow>['stage']; artifact: DaytonaAttemptChanges | null;
}
export type PullRequest = NonNullable<Goal['pullRequest']>;
export class StoreError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'StoreError'; }
}
const conflict = (message: string) => new StoreError(409, message);
function decodeJob(row: z.infer<typeof jobRow>, goal: Goal): Job {
  const encoded = row.artifact;
  const artifact = encoded ? { baseCommit: encoded.baseCommit, patch: Buffer.from(encoded.patchBase64, 'base64'), ...(encoded.testResult ? { testResult: encoded.testResult } : {}), ...(encoded.verification ? { verification: encoded.verification } : {}) } : null;
  return { id: row.id, attemptId: row.id, branch: row.branch, stage: row.stage, artifact, goal };
}
async function goalFrom(client: Pool | PoolClient, id: string, lock = false): Promise<Goal | null> {
  const result = await client.query<Record<string, unknown>>(`SELECT ${goalColumns} FROM goals WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`, [id]);
  return result.rows[0] ? databaseGoal.parse(result.rows[0]) : null;
}
async function addEvent(client: PoolClient, id: string, type: string, message: string): Promise<void> {
  await client.query('INSERT INTO goal_events(goal_id,type,message) VALUES ($1,$2,$3)', [id, type, message]);
}
async function loadJob(client: PoolClient, id: string): Promise<z.infer<typeof jobRow>> {
  const result = await client.query<Record<string, unknown>>('SELECT *, (lease_expires_at > clock_timestamp()) IS TRUE AS lease_valid FROM jobs WHERE id=$1 FOR UPDATE', [id]);
  if (!result.rows[0]) throw new StoreError(404, 'Job not found');
  return jobRow.parse(result.rows[0]);
}
async function lockJob(client: PoolClient, id: string, workerId?: string): Promise<{ row: z.infer<typeof jobRow>; goal: Goal }> {
  const result = await client.query<Record<string, unknown>>('SELECT goal_id FROM jobs WHERE id=$1', [id]);
  if (!result.rows[0]) throw new StoreError(404, 'Job not found');
  const goalId = z.object({ goal_id: z.string().uuid() }).parse(result.rows[0]).goal_id;
  const goal = await goalFrom(client, goalId, true);
  if (!goal) throw new StoreError(404, 'Goal not found');
  const row = await loadJob(client, id);
  if (workerId !== undefined && (row.lease_owner !== workerId || !row.lease_valid)) throw conflict('Worker lease expired or belongs to another worker');
  return { row, goal };
}
async function insertJob(client: PoolClient, goalId: string, cycle: number): Promise<void> {
  const id = randomUUID();
  await client.query("INSERT INTO jobs(id,goal_id,cycle,branch,stage) VALUES ($1,$2,$3,$4,'queued')", [id, goalId, cycle, `herbie/${goalId}/${id}`]);
}

export class Store {
  constructor(readonly pool: Pool) {}
  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async migrate(): Promise<void> {
    const sql = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
    await this.transaction(async client => { await client.query('SELECT pg_advisory_xact_lock(174827301)'); await client.query(sql); });
  }
  async close(): Promise<void> { await this.pool.end(); }
  async createGoal(ownerId: string, input: GoalInput, mode: 'demo' | 'live', key: string): Promise<{ goal: Goal; created: boolean }> {
    const request = goalInput.parse(input);
    z.string().uuid().parse(key);
    const fingerprint = createHash('sha256').update(JSON.stringify({ ...request, repository: request.repository.toLowerCase(), mode })).digest('hex');
    return this.transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`request:${ownerId}:${key}`]);
      const existing = await client.query<Record<string, unknown>>('SELECT fingerprint,goal_id FROM goal_requests WHERE owner_id=$1 AND request_key=$2', [ownerId, key]);
      if (existing.rows[0]) {
        const previous = z.object({ fingerprint: z.string(), goal_id: z.string().uuid() }).parse(existing.rows[0]);
        if (previous.fingerprint !== fingerprint) throw conflict('Idempotency key was already used for a different request');
        const goal = await goalFrom(client, previous.goal_id);
        if (!goal) throw new Error('Missing idempotent goal');
        return { goal, created: false };
      }
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`repository:${request.repository.toLowerCase()}`]);
      const active = await client.query('SELECT 1 FROM goals WHERE lower(repository)=lower($1) AND state IN (\'queued\',\'running\',\'paused\',\'awaiting_review\',\'needs_attention\')', [request.repository]);
      if (active.rowCount) throw conflict('Repository already has an active goal');
      const id = randomUUID();
      await client.query("INSERT INTO goals(id,owner_id,repository,prompt,test_command,max_attempts,mode,state) VALUES($1,$2,$3,$4,$5,$6,$7,'queued')", [id, ownerId, request.repository, request.prompt, JSON.stringify(request.testCommand), request.maxAttempts, mode]);
      await client.query('INSERT INTO goal_requests(owner_id,request_key,fingerprint,goal_id) VALUES($1,$2,$3,$4)', [ownerId, key, fingerprint, id]);
      await insertJob(client, id, 1);
      await addEvent(client, id, 'queued', 'Goal queued for a durable worker');
      const goal = await goalFrom(client, id);
      if (!goal) throw new Error('Missing created goal');
      return { goal, created: true };
    });
  }
  async getGoal(id: string, ownerId?: string): Promise<Goal | null> {
    const goal = await goalFrom(this.pool, id);
    return goal && (ownerId === undefined || goal.ownerId === ownerId) ? goal : null;
  }
  async listGoals(ownerId: string): Promise<Goal[]> {
    const result = await this.pool.query<Record<string, unknown>>(`SELECT ${goalColumns} FROM goals WHERE owner_id=$1 ORDER BY created_at DESC`, [ownerId]);
    return result.rows.map(row => databaseGoal.parse(row));
  }
  async events(goalId: string, after = 0): Promise<GoalEvent[]> {
    const result = await this.pool.query<Record<string, unknown>>('SELECT id::text,goal_id AS "goalId",type,message,created_at AS "createdAt" FROM goal_events WHERE goal_id=$1 AND id>$2 ORDER BY goal_events.id LIMIT 1000', [goalId, after]);
    return result.rows.map(row => eventSchema.extend({ id: z.string().transform(Number), createdAt: z.date().transform(d => d.toISOString()) }).parse(row));
  }
  async control(id: string, ownerId: string, action: GoalAction): Promise<Goal> {
    return this.transaction(async client => {
      const goal = await goalFrom(client, id, true);
      if (!goal || goal.ownerId !== ownerId) throw new StoreError(404, 'Goal not found');
      const result = await client.query<Record<string, unknown>>('SELECT *, (lease_expires_at > clock_timestamp()) IS TRUE AS lease_valid FROM jobs WHERE goal_id=$1 ORDER BY cycle DESC LIMIT 1 FOR UPDATE', [id]);
      const job = jobRow.parse(result.rows[0]);
      if (job.stage === 'publishing') throw conflict('Wait for publication reconciliation before changing this goal');
      if (action === 'cancel' && goal.state === 'cancelled' || action === 'pause' && (goal.state === 'paused' || goal.stopRequested === 'pause') || action === 'resume' && ['queued','running','awaiting_review'].includes(goal.state) && !goal.stopRequested) return goal;
      if (['completed','cancelled','failed','needs_attention'].includes(goal.state) && action !== 'cancel') throw conflict(`Cannot ${action} a ${goal.state} goal`);
      if (action === 'cancel' && ['completed','failed'].includes(goal.state)) throw conflict(`Cannot cancel a ${goal.state} goal`);
      if (action === 'resume') {
        if (goal.state !== 'paused' && goal.stopRequested !== 'pause') throw conflict('Goal is not paused');
        const state = job.stage === 'awaiting_review' ? 'awaiting_review' : job.stage === 'running' ? 'running' : 'queued';
        await client.query('UPDATE goals SET state=$2,stop_requested=NULL,updated_at=clock_timestamp() WHERE id=$1', [id, state]);
      } else if (job.stage === 'running') {
        if (goal.stopRequested === 'cancel' && action === 'pause') throw conflict('Cancellation is already requested');
        if (goal.stopRequested === action) return goal;
        await client.query('UPDATE goals SET stop_requested=$2,updated_at=clock_timestamp() WHERE id=$1', [id, action]);
      } else {
        const state = action === 'pause' ? 'paused' : 'cancelled';
        await client.query('UPDATE goals SET state=$2,stop_requested=NULL,updated_at=clock_timestamp() WHERE id=$1', [id, state]);
        if (action === 'cancel') await client.query("UPDATE jobs SET stage='cancelled',artifact=NULL,lease_owner=NULL,lease_expires_at=NULL WHERE id=$1", [job.id]);
        else await client.query('UPDATE jobs SET lease_owner=NULL,lease_expires_at=NULL WHERE id=$1', [job.id]);
      }
      await addEvent(client, id, action, `${action === 'resume' ? 'Resume' : action === 'pause' ? 'Pause' : 'Cancel'} requested`);
      const updated = await goalFrom(client, id);
      if (!updated) throw new Error('Missing controlled goal');
      return updated;
    });
  }
  async claim(workerId: string, leaseMs = 30_000, mode?: 'demo' | 'live'): Promise<Job | null> {
    z.number().int().positive().max(3_600_000).parse(leaseMs);
    return this.transaction(async client => {
      const selected = await client.query<Record<string, unknown>>(`SELECT j.id FROM jobs j JOIN goals g ON g.id=j.goal_id
        WHERE j.stage IN ('queued','ready','publishing') AND j.eligible_at<=clock_timestamp() AND ($1::text IS NULL OR g.mode=$1)
        AND (j.lease_owner IS NULL OR j.lease_expires_at<=clock_timestamp())
        AND (g.state IN ('queued','running') OR (j.stage='publishing' AND g.state='needs_attention'))
        ORDER BY j.created_at LIMIT 1 FOR UPDATE OF g,j SKIP LOCKED`, [mode ?? null]);
      if (!selected.rows[0]) return null;
      const id = z.object({ id: z.string().uuid() }).parse(selected.rows[0]).id;
      const { row, goal } = await lockJob(client, id);
      await client.query("UPDATE jobs SET stage=CASE WHEN stage='queued' THEN 'running' ELSE stage END,lease_owner=$2,lease_expires_at=clock_timestamp()+$3*interval '1 millisecond' WHERE id=$1", [id, workerId, leaseMs]);
      if (row.stage !== 'publishing') await client.query("UPDATE goals SET state='running',attempt_count=attempt_count+$2,error=NULL,updated_at=clock_timestamp() WHERE id=$1", [goal.id, row.stage === 'queued' ? 1 : 0]);
      await addEvent(client, goal.id, row.stage === 'queued' ? 'attempt_started' : 'work_resumed', row.stage === 'queued' ? `Attempt ${row.cycle} started` : row.stage === 'publishing' ? 'Reconciling interrupted publication' : 'Resuming tested artifact publication');
      const updated = await goalFrom(client, goal.id);
      if (!updated) throw new Error('Missing claimed goal');
      return decodeJob(await loadJob(client, id), updated);
    });
  }
  async heartbeat(jobId: string, workerId: string, leaseMs = 30_000): Promise<boolean> {
    z.number().int().positive().max(3_600_000).parse(leaseMs);
    const result = await this.pool.query("UPDATE jobs SET lease_expires_at=clock_timestamp()+$3*interval '1 millisecond' WHERE id=$1 AND lease_owner=$2 AND lease_expires_at>clock_timestamp()", [jobId, workerId, leaseMs]);
    return result.rowCount === 1;
  }
  async appendEvent(goalId: string, type: string, message: string): Promise<void> {
    await this.transaction(client => addEvent(client, goalId, type, message));
  }
  async saveArtifact(jobId: string, workerId: string, changes: DaytonaAttemptChanges): Promise<Job> {
    const artifact = artifactSchema.parse({ ...changes, patchBase64: changes.patch.toString('base64') });
    return this.transaction(async client => {
      const { row, goal } = await lockJob(client, jobId, workerId);
      if (row.stage !== 'running') throw conflict('Only a running attempt can save an artifact');
      const cancelled = goal.stopRequested === 'cancel';
      const paused = goal.stopRequested === 'pause';
      await client.query('UPDATE jobs SET stage=$2,artifact=$3,lease_owner=CASE WHEN $4 THEN NULL ELSE lease_owner END,lease_expires_at=CASE WHEN $4 THEN NULL ELSE lease_expires_at END WHERE id=$1', [jobId, cancelled ? 'cancelled' : 'ready', cancelled ? null : JSON.stringify(artifact), cancelled || paused]);
      await client.query('UPDATE goals SET state=$2,stop_requested=NULL,updated_at=clock_timestamp() WHERE id=$1', [goal.id, cancelled ? 'cancelled' : paused ? 'paused' : 'running']);
      await addEvent(client, goal.id, cancelled ? 'cancelled' : paused ? 'paused' : 'artifact_ready', cancelled ? 'Completed attempt discarded after cancellation' : paused ? 'Tested artifact held while paused' : 'Tested artifact saved durably');
      const updated = await goalFrom(client, goal.id);
      if (!updated) throw new Error('Missing artifact goal');
      return decodeJob(await loadJob(client, jobId), updated);
    });
  }
  async beginPublication(jobId: string, workerId: string): Promise<boolean> {
    return this.transaction(async client => {
      const { row, goal } = await lockJob(client, jobId);
      if (goal.state === 'paused' || goal.state === 'cancelled') return false;
      if (row.lease_owner !== workerId || !row.lease_valid) throw conflict('Worker lease expired or belongs to another worker');
      if (row.stage !== 'ready' || !row.artifact) throw conflict('Publication requires a tested artifact ready for its first publication');
      await client.query("UPDATE jobs SET stage='publishing' WHERE id=$1", [jobId]);
      await addEvent(client, goal.id, 'publishing', 'Publishing tested artifact from the trusted service');
      return true;
    });
  }
  async completePublication(jobId: string, workerId: string, pullRequest: Omit<PullRequest, 'state'>): Promise<Goal> {
    const pr = goalSchema.shape.pullRequest.unwrap().parse({ ...pullRequest, state: 'open' });
    return this.transaction(async client => {
      const { row, goal } = await lockJob(client, jobId, workerId);
      if (row.stage !== 'publishing' || pr.branch !== row.branch || pr.state !== 'open') throw conflict('Publication does not match the expected attempt branch');
      await client.query("UPDATE jobs SET stage='awaiting_review',lease_owner=NULL,lease_expires_at=NULL WHERE id=$1", [jobId]);
      await client.query("UPDATE goals SET state='awaiting_review',pull_request=$2,error=NULL,updated_at=clock_timestamp() WHERE id=$1", [goal.id, JSON.stringify(pr)]);
      await addEvent(client, goal.id, 'pull_request_opened', `Pull request #${pr.number} awaits review: ${pr.url}`);
      const updated = await goalFrom(client, goal.id);
      if (!updated) throw new Error('Missing published goal');
      return updated;
    });
  }

  async publicationUncertain(jobId: string, workerId: string, error: string): Promise<void> {
    await this.transaction(async client => {
      const { row, goal } = await lockJob(client, jobId, workerId);
      if (row.stage !== 'publishing') throw conflict('Only a started publication can have an uncertain outcome');
      await client.query("UPDATE jobs SET lease_owner=NULL,lease_expires_at=NULL,eligible_at=clock_timestamp()+interval '60 seconds' WHERE id=$1", [jobId]);
      await client.query("UPDATE goals SET state='needs_attention',error=$2,updated_at=clock_timestamp() WHERE id=$1", [goal.id, error]);
      await addEvent(client, goal.id, 'publication_uncertain', error);
    });
  }
  async fail(jobId: string, workerId: string, error: string, needsAttention = false): Promise<void> {
    await this.transaction(async client => {
      const { row, goal } = await lockJob(client, jobId, workerId);
      if (!['running','ready'].includes(row.stage)) throw conflict('Only unpublished work may fail; publication must reconcile');
      const state = needsAttention ? 'needs_attention' : goal.stopRequested === 'cancel' ? 'cancelled' : 'failed';
      await client.query("UPDATE jobs SET stage=$2,lease_owner=NULL,lease_expires_at=NULL,artifact=CASE WHEN $2='cancelled' THEN NULL ELSE artifact END WHERE id=$1", [jobId, state]);
      await client.query('UPDATE goals SET state=$2,error=$3,stop_requested=NULL,updated_at=clock_timestamp() WHERE id=$1', [goal.id, state, error]);
      await addEvent(client, goal.id, state, error);
    });
  }
  async recoverExpired(): Promise<number> {
    return this.transaction(async client => {
      const result = await client.query<Record<string, unknown>>(`SELECT j.id FROM jobs j JOIN goals g ON g.id=j.goal_id
        WHERE j.lease_expires_at<=clock_timestamp() AND j.stage IN ('running','ready','publishing')
        FOR UPDATE OF g,j SKIP LOCKED`);
      for (const selected of result.rows) {
        const id = z.object({ id: z.string().uuid() }).parse(selected).id;
        const { row, goal } = await lockJob(client, id);
        const uncertain = row.stage === 'running' || row.stage === 'publishing';
        await client.query("UPDATE jobs SET stage=CASE WHEN stage='running' THEN 'needs_attention' ELSE stage END,lease_owner=NULL,lease_expires_at=NULL,eligible_at=clock_timestamp() WHERE id=$1", [id]);
        if (uncertain) {
          const error = row.stage === 'running' ? 'Worker lease expired during an attempt; sandbox cleanup and outcome require operator attention. The paid attempt will not automatically repeat.' : 'Worker lease expired during publication; checking the existing branch before any further action.';
          await client.query("UPDATE goals SET state='needs_attention',error=$2,stop_requested=NULL,updated_at=clock_timestamp() WHERE id=$1", [goal.id, error]);
          await addEvent(client, goal.id, 'recovery_required', error);
        } else await addEvent(client, goal.id, 'artifact_recovered', 'Recovered saved artifact after worker lease expired');
      }
      return result.rows.length;
    });
  }

  async reviewJobs(mode?: 'demo' | 'live'): Promise<Job[]> {
    const result = await this.pool.query<Record<string, unknown>>(`SELECT j.*, (j.lease_expires_at > clock_timestamp()) IS TRUE AS lease_valid FROM jobs j JOIN goals g ON g.id=j.goal_id
      WHERE j.stage='awaiting_review' AND g.state IN ('awaiting_review','paused') AND ($1::text IS NULL OR g.mode=$1) ORDER BY j.created_at`, [mode ?? null]);
    const jobs: Job[] = [];
    for (const selected of result.rows) {
      const row = jobRow.parse(selected);
      const goal = await goalFrom(this.pool, row.goal_id);
      if (goal) jobs.push(decodeJob(row, goal));
    }
    return jobs;
  }
  async reconcile(jobId: string, outcome: 'merged' | 'closed'): Promise<Goal> {
    return this.transaction(async client => {
      const { row, goal } = await lockJob(client, jobId);
      if (row.stage === 'completed' || row.stage === 'cancelled') return goal;
      if (row.stage !== 'awaiting_review' || !goal.pullRequest || goal.pullRequest.branch !== row.branch) throw conflict('Only the current published pull request can be reconciled');
      const cancelled = outcome === 'closed';
      const next = !cancelled && goal.attemptCount < goal.maxAttempts;
      const state = cancelled ? 'cancelled' : next ? goal.state === 'paused' ? 'paused' : 'queued' : 'completed';
      await client.query('UPDATE jobs SET stage=$2,lease_owner=NULL,lease_expires_at=NULL WHERE id=$1', [jobId, cancelled ? 'cancelled' : 'completed']);
      await client.query('UPDATE goals SET state=$2,pull_request=$3,stop_requested=NULL,error=NULL,updated_at=clock_timestamp() WHERE id=$1', [goal.id, state, JSON.stringify({ ...goal.pullRequest, state: outcome })]);
      await addEvent(client, goal.id, cancelled ? 'pull_request_closed' : 'pull_request_merged', cancelled ? 'Pull request closed without merging; goal stopped' : next ? 'Pull request merged; next bounded attempt queued' : 'Pull request merged; attempt budget complete');
      if (next) await insertJob(client, goal.id, row.cycle + 1);
      const updated = await goalFrom(client, goal.id);
      if (!updated) throw new Error('Missing reconciled goal');
      return updated;
    });
  }

}
