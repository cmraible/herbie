import {publicationBackoffMs} from './publication-backoff.js';
import {demoGoalName} from './demo.js';
import {logFailure} from './diagnostic-log.js';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { goalName, goalInput, goalSchema, eventSchema, type Goal, type GoalInput, type GoalAction, type GoalEvent } from '@herbie/contracts';
import {hasValidPublicationEvidence} from '@herbie/loop/publish-patch';
import type { PublicationPhase } from './adapters.js';
import type { DaytonaAttemptChanges } from '@herbie/loop/daytona-attempt';

const goalColumns = `id, owner_id AS "ownerId", repository, name, prompt,
  max_wip AS "maxWip", attempt_count AS "attemptCount", mode, state, stop_requested AS "stopRequested",
  pull_request AS "pullRequest",
  COALESCE((SELECT jsonb_agg(j.pull_request ORDER BY j.cycle) FROM jobs j WHERE j.goal_id=goals.id AND j.pull_request IS NOT NULL),'[]'::jsonb) AS "pullRequests",
  cleanup_status AS "cleanupStatus", error, created_at AS "createdAt", updated_at AS "updatedAt"`;
const databaseGoal = goalSchema.extend({ createdAt: z.date().transform(d => d.toISOString()), updatedAt: z.date().transform(d => d.toISOString()) });
const artifactSchema = z.object({
  baseCommit: z.string(), patchBase64: z.string(),
  verification: z.object({ version: z.union([z.literal(2), z.literal(3)]).optional(), repoUrl: z.string(), baseCommit: z.string(), patchSha256: z.string(), goalCompleted: z.literal(true), sandboxDeleted: z.literal(true) }).optional(),
});
const jobRow = z.object({
  id: z.string().uuid(), goal_id: z.string().uuid(), branch: z.string(), cycle: z.number().int(),
  stage: z.enum(['queued','running','ready','publishing','awaiting_review','completed','cancelled','failed','needs_attention']),
  artifact: artifactSchema.nullable(), lease_owner: z.string().nullable(),
  lease_expires_at: z.date().nullable(), lease_valid: z.boolean(),
  publication_retry_count: z.number().int().nonnegative(), publication_blocked: z.boolean(),
});
export interface Job {
  id: string; attemptId: string; goal: Goal; branch: string;
  stage: z.infer<typeof jobRow>['stage']; artifact: DaytonaAttemptChanges | null;
}
export type PublicationRetryCandidate={kind:'retryable';job:Job}|{kind:'already_queued'|'in_progress'|'unavailable';goal:Goal};
export type PullRequest = NonNullable<Goal['pullRequest']>;
export class StoreError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'StoreError'; }
}
const conflict = (message: string) => new StoreError(409, message);
function requestFingerprint({repository,prompt,name,maxWip}:GoalInput, mode:Goal['mode'], legacyLimit?:number):string {
  return createHash('sha256').update(JSON.stringify({repository:repository.toLowerCase(),prompt,...(legacyLimit === undefined ? {} : {maxAttempts:legacyLimit}),mode,...(name === undefined ? {} : {name}),...(maxWip === undefined || maxWip === 1 ? {} : {maxWip})})).digest('hex');
}
function decodeJob(row: z.infer<typeof jobRow>, goal: Goal): Job {
  const encoded = row.artifact;
  const artifact = encoded ? { baseCommit: encoded.baseCommit, patch: Buffer.from(encoded.patchBase64, 'base64'), ...(encoded.verification ? { verification: encoded.verification } : {}) } : null;
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

// Call with the goal locked. One attempt runs at a time, while published PRs
// continue occupying capacity until merged. Queued work reserves a slot too.
async function advanceGoal(client: PoolClient, goal: Goal): Promise<void> {
  if (['cancelled','failed','needs_attention'].includes(goal.state)) return;
  const {rows} = await client.query<{stage:string;cycle:number}>('SELECT stage,cycle FROM jobs WHERE goal_id=$1 ORDER BY cycle', [goal.id]);
  let pending = rows.find(job => ['queued','running','ready','publishing'].includes(job.stage));
  const reviewing = rows.filter(job => job.stage === 'awaiting_review').length;
  const cycle = rows.at(-1)?.cycle ?? 0;
  if (!pending && reviewing < goal.maxWip) {
    await insertJob(client, goal.id, cycle + 1);
    pending = {stage:'queued',cycle:cycle+1};
  }
  const state = goal.state === 'paused' || goal.stopRequested === 'pause' && pending?.stage !== 'running' ? 'paused'
    : pending ? ['running','publishing'].includes(pending.stage) ? 'running' : 'queued' : 'awaiting_review';
  await client.query("UPDATE goals SET state=$2,stop_requested=CASE WHEN $2='paused' THEN NULL ELSE stop_requested END,updated_at=clock_timestamp() WHERE id=$1", [goal.id,state]);
}

async function cancelGoal(client: PoolClient, goal: Goal): Promise<void> {
  const {rows} = await client.query<{stage:string;lease_valid:boolean}>(
    'SELECT stage,(lease_expires_at>clock_timestamp()) IS TRUE AS lease_valid FROM jobs WHERE goal_id=$1 FOR UPDATE',[goal.id]);
  const uncertain = rows.some(j=>['publishing','awaiting_review','needs_attention'].includes(j.stage)||j.stage==='running'&&!j.lease_valid);
  const active = rows.some(j=>j.stage==='running'&&j.lease_valid);
  const cleanup = uncertain ? 'needs_attention' : active ? 'pending' : 'not_required';
  await client.query("UPDATE jobs SET cancelled_worker=lease_owner,cancel_cleanup_deadline=clock_timestamp()+interval '5 minutes',stage='cancelled',lease_owner=NULL,lease_expires_at=NULL WHERE goal_id=$1 AND stage NOT IN ('completed','cancelled','failed')",[goal.id]);
  await client.query("UPDATE goals SET state='cancelled',stop_requested=NULL,cleanup_status=$2,updated_at=clock_timestamp() WHERE id=$1",[goal.id,cleanup]);
  await addEvent(client,goal.id,'cancel','Goal cancelled. No further attempts or publication retries will start. Saved work and audit history retained.');
  if(cleanup!=='not_required')await addEvent(client,goal.id,'cleanup_required',cleanup==='pending'
    ? 'Stopping the active sandbox. Cleanup confirmation is pending.'
    : 'Remote work may remain. Cleanup requires attention; cancellation remains in effect.');
}

export class Store {
  constructor(readonly pool: Pool, private readonly retryRandom:()=>number=Math.random, private readonly nameGoal?:(prompt:string)=>string|Promise<string>) {}
  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; }
    catch (error) { try{await client.query('ROLLBACK');}catch(error){logFailure(error,{component:'store-rollback'});} throw error; }
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
    const fingerprint = requestFingerprint(request,mode);
    let name=request.name;
    if(name===undefined){
      const existing=await this.pool.query('SELECT 1 FROM goal_requests WHERE owner_id=$1 AND request_key=$2',[ownerId,key]);
      if(!existing.rowCount){
        if(mode==='live'&&!this.nameGoal)throw new Error('Live goal naming is not configured');
        name=goalName.parse(await (mode==='demo'?demoGoalName(request.prompt):this.nameGoal!(request.prompt)));
      }
    }
    return this.transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`request:${ownerId}:${key}`]);
      const existing = await client.query<Record<string, unknown>>('SELECT r.fingerprint,r.goal_id,(g.test_command IS NOT NULL) AS legacy FROM goal_requests r JOIN goals g ON g.id=r.goal_id WHERE r.owner_id=$1 AND r.request_key=$2', [ownerId, key]);
      if (existing.rows[0]) {
        const previous = z.object({ fingerprint: z.string(), goal_id: z.string().uuid(), legacy: z.boolean() }).parse(existing.rows[0]);
        const goal = await goalFrom(client, previous.goal_id);
        if (!goal) throw new Error('Missing idempotent goal');
        // Match old request hashes without retaining a limit on the goal.
        const matchesFingerprint = [undefined,1,2,3,4,5].some(limit => requestFingerprint(request,mode,limit) === previous.fingerprint);
        // Older testCommand requests replay against immutable input, excluding the mutable name.
        if (!matchesFingerprint && (!previous.legacy || request.name !== undefined || requestFingerprint({...goal,name:undefined},goal.mode) !== fingerprint)) throw conflict('Idempotency key was already used for a different request');
        return { goal, created: false };
      }
      const id = randomUUID();
      if(name===undefined)throw new Error('Missing goal name');
      await client.query("INSERT INTO goals(id,owner_id,repository,prompt,mode,name,max_wip,state) VALUES($1,$2,$3,$4,$5,$6,$7,'queued')", [id, ownerId, request.repository, request.prompt, mode, name, request.maxWip]);
      await client.query('INSERT INTO goal_requests(owner_id,request_key,fingerprint,goal_id) VALUES($1,$2,$3,$4)', [ownerId, key, fingerprint, id]);
      await insertJob(client, id, 1);
      await addEvent(client, id, 'queued', 'Goal queued for a durable worker');
      const goal = await goalFrom(client, id);
      if (!goal) throw new Error('Missing created goal');
      return { goal, created: true };
    });
  }
  async renameGoal(id: string, ownerId: string, name: string): Promise<Goal> {
    const parsed = goalName.parse(name);
    return this.transaction(async client=>{
      const result = await client.query<Record<string, unknown>>(
        `UPDATE goals SET name=$3,updated_at=clock_timestamp() WHERE id=$1 AND owner_id=$2 RETURNING ${goalColumns}`,
        [id,ownerId,parsed]);
      if (!result.rows[0]) throw new StoreError(404, 'Goal not found');
      await addEvent(client,id,'renamed','Goal renamed');
      return databaseGoal.parse(result.rows[0]);
    });
  }
  async getGoal(id: string, ownerId?: string): Promise<Goal | null> {
    const goal = await goalFrom(this.pool, id);
    return goal && (ownerId === undefined || goal.ownerId === ownerId) ? goal : null;
  }
  async publicationRetryCandidate(id:string,ownerId:string):Promise<PublicationRetryCandidate|null>{
    const goal=await goalFrom(this.pool,id);
    if(!goal||goal.ownerId!==ownerId)return null;
    const result=await this.pool.query<Record<string,unknown>>('SELECT *, (lease_expires_at > clock_timestamp()) IS TRUE AS lease_valid FROM jobs WHERE goal_id=$1 ORDER BY cycle DESC LIMIT 1',[id]);
    if(!result.rows[0])return {kind:'unavailable',goal};
    const row=jobRow.parse(result.rows[0]);
    const job=decodeJob(row,goal);
    if(row.stage==='publishing'&&row.lease_valid)return {kind:'in_progress',goal};
    if(row.stage==='ready'&&row.artifact&&['queued','running'].includes(goal.state))return {kind:'already_queued',goal};
    if(goal.mode==='live'&&row.stage==='publishing'&&!row.lease_valid&&['needs_attention','running'].includes(goal.state)
      &&!goal.stopRequested&&job.artifact&&hasValidPublicationEvidence(goal.repository,job.artifact))return {kind:'retryable',job};
    return {kind:'unavailable',goal};
  }
  async retryAttempt(id:string,ownerId:string):Promise<Goal>{
    return this.transaction(async client=>{
      const goal=await goalFrom(client,id,true);
      if(!goal||goal.ownerId!==ownerId)throw new StoreError(404,'Goal not found');
      if(['queued','running','awaiting_review'].includes(goal.state)&&!goal.stopRequested)return goal;
      if(!['failed','needs_attention'].includes(goal.state)||goal.stopRequested)throw conflict('Only failed or interrupted goals can be retried');
      const {rows}=await client.query<{stage:string}>("SELECT stage FROM jobs WHERE goal_id=$1 FOR UPDATE",[id]);
      if(rows.some(row=>['queued','running','ready','publishing'].includes(row.stage)))throw conflict('Saved work must finish publication recovery before a new attempt can start');
      await client.query("UPDATE goals SET state='queued',error=NULL,stop_requested=NULL,updated_at=clock_timestamp() WHERE id=$1",[id]);
      await advanceGoal(client,{...goal,state:'queued',error:null,stopRequested:null});
      await addEvent(client,id,'retry','Retry requested. A fresh attempt will run when capacity is available; previous work and activity are retained.');
      return (await goalFrom(client,id))!;
    });
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
      if (action === 'cancel') {
        // Cancellation is a local durable decision, never dependent on GitHub or
        // remote cleanup. Revoking every lease fences callbacks and future claims.
        if (['cancelled','completed','failed'].includes(goal.state)) return goal;
        await cancelGoal(client,goal);
        return (await goalFrom(client,id))!;
      }
      const result = await client.query<Record<string, unknown>>('SELECT *, (lease_expires_at > clock_timestamp()) IS TRUE AS lease_valid FROM jobs WHERE goal_id=$1 ORDER BY cycle DESC LIMIT 1 FOR UPDATE', [id]);
      const job = jobRow.parse(result.rows[0]);
      if(job.stage==='publishing')throw conflict('Wait for publication reconciliation before pausing or resuming this goal');
      if (action === 'pause' && (goal.state === 'paused' || goal.stopRequested === 'pause') || action === 'resume' && ['queued','running','awaiting_review'].includes(goal.state) && !goal.stopRequested) return goal;
      if (['completed','cancelled','failed','needs_attention'].includes(goal.state)) throw conflict(`Cannot ${action} a ${goal.state} goal`);
      if (action === 'resume') {
        if (goal.state !== 'paused' && goal.stopRequested !== 'pause') throw conflict('Goal is not paused');
        await client.query("UPDATE goals SET state='queued',stop_requested=NULL,updated_at=clock_timestamp() WHERE id=$1", [id]);
        await advanceGoal(client,{...goal,state:'queued',stopRequested:null});
      } else if (job.stage === 'running') {
        await client.query('UPDATE goals SET stop_requested=$2,updated_at=clock_timestamp() WHERE id=$1', [id, action]);
      } else {
        await client.query("UPDATE goals SET state='paused',stop_requested=NULL,updated_at=clock_timestamp() WHERE id=$1", [id]);
        await client.query('UPDATE jobs SET lease_owner=NULL,lease_expires_at=NULL WHERE id=$1', [job.id]);
      }
      await addEvent(client, id, action, `${action === 'resume' ? 'Resume' : 'Pause'} requested`);
      return (await goalFrom(client,id))!;
    });
  }
  // A fenced worker may report cleanup/evidence, but never revive the job or goal.
  async finishCancelled(jobId:string,workerId:string,cleanup:'complete'|'needs_attention',changes?:DaytonaAttemptChanges,pullRequest?:Omit<PullRequest,'state'>):Promise<boolean>{
    return this.transaction(async client=>{
      const {row,goal}=await lockJob(client,jobId);
      if(goal.state!=='cancelled'||row.stage!=='cancelled')return false;
      const owner=await client.query('SELECT 1 FROM jobs WHERE id=$1 AND cancelled_worker=$2',[jobId,workerId]);
      if(!owner.rowCount)return false;
      if(changes){
        const artifact=artifactSchema.parse({...changes,patchBase64:changes.patch.toString('base64')});
        await client.query('UPDATE jobs SET artifact=COALESCE(artifact,$2) WHERE id=$1',[jobId,JSON.stringify(artifact)]);
      }
      if(pullRequest&&pullRequest.branch===row.branch){
        const pr=goalSchema.shape.pullRequest.unwrap().parse({state:'open',...pullRequest});
        await client.query('UPDATE jobs SET pull_request=$2 WHERE id=$1',[jobId,JSON.stringify(pr)]);
        await client.query('UPDATE goals SET pull_request=$2 WHERE id=$1',[goal.id,JSON.stringify(pr)]);
      }
      // An uncertain publication cannot become clean merely because its caller returned.
      const status=goal.cleanupStatus==='needs_attention'?'needs_attention':cleanup;
      await client.query('UPDATE goals SET cleanup_status=$2,updated_at=clock_timestamp() WHERE id=$1',[goal.id,status]);
      await client.query('UPDATE jobs SET cancelled_worker=NULL WHERE id=$1',[jobId]);
      await addEvent(client,goal.id,'cancellation_cleanup',status==='complete'?'Sandbox deletion confirmed after cancellation. Saved work retained.':'Cancellation remains in effect. Remote cleanup or publication outcome requires attention.');
      return true;
    });
  }

  async claim(workerId: string, leaseMs = 30_000, mode?: 'demo' | 'live'): Promise<Job | null> {
    z.number().int().positive().max(3_600_000).parse(leaseMs);
    return this.transaction(async client => {
      const selected = await client.query<Record<string, unknown>>(`SELECT j.id FROM jobs j JOIN goals g ON g.id=j.goal_id
        WHERE j.stage IN ('queued','ready','publishing') AND j.eligible_at<=clock_timestamp() AND ($1::text IS NULL OR g.mode=$1)
        AND NOT j.publication_blocked AND g.stop_requested IS NULL
        AND (j.lease_owner IS NULL OR j.lease_expires_at<=clock_timestamp())
        AND (g.state IN ('queued','running') OR (j.stage='publishing' AND g.state='needs_attention'))
        ORDER BY j.created_at LIMIT 1 FOR UPDATE OF g,j SKIP LOCKED`, [mode ?? null]);
      if (!selected.rows[0]) return null;
      const id = z.object({ id: z.string().uuid() }).parse(selected.rows[0]).id;
      const { row, goal } = await lockJob(client, id);
      await client.query("UPDATE jobs SET stage=CASE WHEN stage='queued' THEN 'running' ELSE stage END,lease_owner=$2,lease_expires_at=clock_timestamp()+$3*interval '1 millisecond' WHERE id=$1", [id, workerId, leaseMs]);
      if (row.stage !== 'publishing') await client.query("UPDATE goals SET state='running',attempt_count=attempt_count+$2,error=NULL,updated_at=clock_timestamp() WHERE id=$1", [goal.id, row.stage === 'queued' ? 1 : 0]);
      if(row.stage!=='publishing')await addEvent(client, goal.id, row.stage === 'queued' ? 'attempt_started' : 'work_resumed', row.stage === 'queued' ? `Attempt ${row.cycle} started` : 'Resuming captured artifact publication');
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
  async recordPublicationPhase(jobId:string,workerId:string,phase:PublicationPhase):Promise<void>{
    await this.transaction(async client=>{
      const {row,goal}=await lockJob(client,jobId,workerId);
      if(row.stage!=='publishing')throw conflict('Publication phase requires a publishing job');
      const previous=await client.query<{message:string}>('SELECT message FROM goal_events WHERE goal_id=$1 AND type=$2 ORDER BY id DESC LIMIT 1',[goal.id,'publication_phase']);
      const message=`Publication phase: ${phase}`;
      if(previous.rows[0]?.message!==message)await addEvent(client,goal.id,'publication_phase',message);
    });
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
      await addEvent(client, goal.id, cancelled ? 'cancelled' : paused ? 'paused' : 'artifact_ready', cancelled ? 'Completed attempt discarded after cancellation' : paused ? 'Captured artifact held while paused' : 'Captured artifact saved durably');
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
      if (row.stage !== 'ready' || !row.artifact) throw conflict('Publication requires a captured artifact ready for its first publication');
      await client.query("UPDATE jobs SET stage='publishing' WHERE id=$1", [jobId]);
      await addEvent(client, goal.id, 'publishing', 'Publishing captured artifact from the trusted service');
      return true;
    });
  }
  async completePublication(jobId: string, workerId: string, pullRequest: Omit<PullRequest, 'state'> & {state?:PullRequest['state']}): Promise<Goal> {
    const pr = goalSchema.shape.pullRequest.unwrap().parse({ state: 'open', ...pullRequest });
    return this.transaction(async client => {
      const { row, goal } = await lockJob(client, jobId, workerId);
      if (row.stage !== 'publishing' || pr.branch !== row.branch) throw conflict('Publication does not match the expected attempt branch');
      await client.query("UPDATE jobs SET stage='awaiting_review',pull_request=$2,lease_owner=NULL,lease_expires_at=NULL,publication_retry_count=0,publication_blocked=false WHERE id=$1", [jobId,JSON.stringify(pr)]);
      await client.query("UPDATE goals SET state='awaiting_review',pull_request=$2,error=NULL,updated_at=clock_timestamp() WHERE id=$1", [goal.id, JSON.stringify(pr)]);
      // Apply an already-known merge/close in this transaction before exposing capacity.
      if (pr.state !== 'open') return this.reconcileReview(client,jobId,pr.state);
      await advanceGoal(client,{...goal,state:'awaiting_review',error:null});
      await addEvent(client, goal.id, 'pull_request_opened', `Pull request #${pr.number} awaits review: ${pr.url}`);
      const updated = await goalFrom(client, goal.id);
      if (!updated) throw new Error('Missing published goal');
      return updated;
    });
  }

  async publicationUncertain(jobId: string, workerId: string, error: string, diagnosticReference?:string): Promise<void> {
    await this.transaction(async client => {
      const { row, goal } = await lockJob(client, jobId, workerId);
      if (row.stage !== 'publishing') throw conflict('Only a started publication can have an uncertain outcome');
      const count=row.publication_retry_count+1;
      const delayMs=publicationBackoffMs(count,this.retryRandom);
      const scheduled=await client.query<{eligible_at:Date}>("UPDATE jobs SET lease_owner=NULL,lease_expires_at=NULL,publication_retry_count=$2,eligible_at=clock_timestamp()+$3*interval '1 millisecond' WHERE id=$1 RETURNING eligible_at",[jobId,count,delayMs]);
      const message=`${error} Automatic publication recovery #${count} scheduled for ${scheduled.rows[0]!.eligible_at.toISOString()}. Saved work retained; no new model attempt.${diagnosticReference?` Failure reference: ${diagnosticReference}`:''}`;
      await client.query("UPDATE goals SET state='needs_attention',error=$2,updated_at=clock_timestamp() WHERE id=$1", [goal.id, message]);
      // The status always carries the latest deadline/reference. The feed records
      // changed causes and increasing backoff tiers, not every identical capped retry.
      const previousCause=goal.error?.split(' Automatic publication recovery #')[0];
      if(count<=5||previousCause!==error)await addEvent(client, goal.id, 'publication_uncertain', message);
    });
  }
  async blockPublication(jobId:string,workerId:string,reason:string):Promise<void>{
    await this.transaction(async client=>{
      const {row,goal}=await lockJob(client,jobId,workerId);
      if(row.stage!=='publishing')throw conflict('Only publication may be blocked');
      await client.query("UPDATE jobs SET publication_blocked=true,lease_owner=NULL,lease_expires_at=NULL WHERE id=$1",[jobId]);
      const message=`Automatic publication recovery stopped: ${reason}. Saved work retained; no new model attempt. Resolve the safety conflict before retrying publication.`;
      await client.query("UPDATE goals SET state='needs_attention',error=$2,updated_at=clock_timestamp() WHERE id=$1",[goal.id,message]);
      await addEvent(client,goal.id,'publication_blocked',message);
    });
  }
  async queueSavedPublication(jobId:string,ownerId:string,expectedBranch:string,expectedBaseCommit:string):Promise<Goal>{
    return this.transaction(async client=>{
      const {row,goal}=await lockJob(client,jobId);
      if(goal.ownerId!==ownerId)throw new StoreError(404,'Goal not found');
      if(row.stage==='ready'&&row.artifact&&['queued','running'].includes(goal.state))return goal;
      const job=decodeJob(row,goal);
      if(goal.mode!=='live'||row.stage!=='publishing'||row.lease_valid||!['needs_attention','running'].includes(goal.state)||goal.stopRequested
        ||!job.artifact||row.branch!==expectedBranch||job.artifact.baseCommit!==expectedBaseCommit
        ||!hasValidPublicationEvidence(goal.repository,job.artifact))throw conflict('Saved publication is no longer eligible for a safe retry');
      await client.query("UPDATE jobs SET stage='ready',lease_owner=NULL,lease_expires_at=NULL,publication_blocked=false,eligible_at=clock_timestamp() WHERE id=$1",[jobId]);
      await client.query("UPDATE goals SET state='queued',error=NULL,updated_at=clock_timestamp() WHERE id=$1",[goal.id]);
      await addEvent(client,goal.id,'publication_retry_queued','Queued the saved captured artifact for publication; no new attempt will run.');
      const updated=await goalFrom(client,goal.id);
      if(!updated)throw new Error('Missing retried publication goal');
      return updated;
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
      const abandoned = await client.query<{id:string}>(`SELECT g.id FROM goals g JOIN jobs j ON j.goal_id=g.id
        WHERE g.state='cancelled' AND g.cleanup_status='pending' AND j.cancel_cleanup_deadline<=clock_timestamp()
        FOR UPDATE OF g,j SKIP LOCKED`);
      for(const {id} of abandoned.rows){
        await client.query("UPDATE goals SET cleanup_status='needs_attention',updated_at=clock_timestamp() WHERE id=$1",[id]);
        await addEvent(client,id,'cleanup_required','Cleanup confirmation timed out. Goal remains cancelled; inspect remote resources.');
      }
      const result = await client.query<Record<string, unknown>>(`SELECT j.id FROM jobs j JOIN goals g ON g.id=j.goal_id
        WHERE j.lease_expires_at<=clock_timestamp() AND j.stage IN ('running','ready','publishing')
        FOR UPDATE OF g,j SKIP LOCKED`);
      for (const selected of result.rows) {
        const id = z.object({ id: z.string().uuid() }).parse(selected).id;
        const { row, goal } = await lockJob(client, id);
        const uncertain = row.stage === 'running' || row.stage === 'publishing';
        await client.query("UPDATE jobs SET stage=CASE WHEN stage='running' THEN 'needs_attention' ELSE stage END,lease_owner=NULL,lease_expires_at=NULL,eligible_at=clock_timestamp() WHERE id=$1", [id]);
        if (uncertain) {
          const error = row.stage === 'running' ? 'Worker connection was lost during an attempt. Use Retry to start a new attempt. The previous sandbox cleanup is unconfirmed; the paid attempt will not automatically repeat.' : 'Worker lease expired during publication; checking the existing branch before any further action.';
          await client.query("UPDATE goals SET state='needs_attention',error=$2,stop_requested=NULL,updated_at=clock_timestamp() WHERE id=$1", [goal.id, error]);
          await addEvent(client, goal.id, 'recovery_required', error);
        } else await addEvent(client, goal.id, 'artifact_recovered', 'Recovered saved artifact after worker lease expired');
      }
      return result.rows.length;
    });
  }

  async reviewJobs(mode?: 'demo' | 'live'): Promise<Job[]> {
    const result = await this.pool.query<Record<string, unknown>>(`SELECT j.*, (j.lease_expires_at > clock_timestamp()) IS TRUE AS lease_valid FROM jobs j JOIN goals g ON g.id=j.goal_id
      WHERE j.stage IN ('awaiting_review','cancelled') AND j.pull_request->>'state'='open'
      AND ($1::text IS NULL OR g.mode=$1) ORDER BY j.created_at`, [mode ?? null]);
    const jobs: Job[] = [];
    for (const selected of result.rows) {
      const row = jobRow.parse(selected);
      const goal = await goalFrom(this.pool, row.goal_id);
      if (goal) jobs.push(decodeJob(row, goal));
    }
    return jobs;
  }
  async reconcile(jobId: string, outcome: 'merged' | 'closed'): Promise<Goal> {
    return this.transaction(client => this.reconcileReview(client,jobId,outcome));
  }
  private async reconcileReview(client: PoolClient, jobId: string, outcome: 'merged' | 'closed'): Promise<Goal> {
    const { row, goal } = await lockJob(client, jobId);
    const pr = goal.pullRequests.find(pr => pr.branch === row.branch);
    if (row.stage === 'completed' || row.stage === 'cancelled' && pr?.state !== 'open') return goal;
    if (!['awaiting_review','cancelled'].includes(row.stage) || !pr) throw conflict('Only a published pull request can be reconciled');
    const cancelled = outcome === 'closed';
    const updatedPr = JSON.stringify({...pr,state:outcome});
    await client.query('UPDATE jobs SET stage=$2,pull_request=$3,lease_owner=NULL,lease_expires_at=NULL WHERE id=$1', [jobId, cancelled ? 'cancelled' : 'completed',updatedPr]);
    await client.query("UPDATE goals SET pull_request=CASE WHEN pull_request->>'branch'=$2 THEN $3::jsonb ELSE pull_request END WHERE id=$1", [goal.id,row.branch,updatedPr]);
    if (cancelled && goal.state !== 'cancelled') await cancelGoal(client,goal);
    else await advanceGoal(client,goal);
    const updated = await goalFrom(client, goal.id);
    if (!updated) throw new Error('Missing reconciled goal');
    await addEvent(client, goal.id, cancelled ? 'pull_request_closed' : 'pull_request_merged', cancelled ? 'Pull request closed without merging; goal stopped' : 'Pull request merged');
    return updated;
  }

}
