import {logFailure} from './diagnostic-log.js';
import {DaytonaAttemptError} from '@herbie/loop/daytona-attempt';
import { setTimeout as delay } from 'node:timers/promises';
import { KnownAttemptFailure, type Adapters, type Execution } from './adapters.js';
import type { Job } from './store.js';
import { Store, StoreError } from './store.js';
import {publicationDiagnostic,publicationDiagnosticMessage} from './publication-diagnostics.js';
import type {PublicationPhase} from './adapters.js';

async function executionFor(adapters: Adapters, job: Job, readOnly = false): Promise<Execution> {
  const repository = readOnly ? await adapters.reconciliationRepository(job.goal.repository) : await adapters.authorize(job.goal.ownerId, job.goal.repository);
  return {goal:job.goal, repository, attemptId:job.attemptId, branch:job.branch};
}

// One claim per tick. Leases fence database writes; uncertain external effects never retry.
export async function runWorkerOnce(store: Store, adapters: Adapters, workerId: string, timing = {leaseMs:30_000,heartbeatMs:5_000}): Promise<boolean> {
  const {leaseMs,heartbeatMs} = timing;
  await store.recoverExpired();
  const job = await store.claim(workerId,leaseMs,adapters.mode);
  if (!job) return false;
  let leaseLost = false;
  let renewing = false;
  const heartbeat = setInterval(() => {
    if (renewing) return;
    renewing = true;
    void store.heartbeat(job.id,workerId,leaseMs).then(owned => { if (!owned) leaseLost = true; })
      .catch(error => { leaseLost = true; logFailure(error,{component:'worker-heartbeat',goalId:job.goal.id,jobId:job.id}); }).finally(() => { renewing = false; });
  },heartbeatMs);
  const requireLease = async (): Promise<void> => {
    if (leaseLost) throw new StoreError(409,'Worker lease lost');
    const owned = await store.heartbeat(job.id,workerId,leaseMs);
    if (!owned || leaseLost) {
      leaseLost = true;
      throw new StoreError(409,'Worker lease lost');
    }
  };
  let publishing = job.stage === 'publishing';
  let publicationPhase:PublicationPhase='preflight_reconciliation';
  const reportPublicationPhase=async(phase:PublicationPhase):Promise<void>=>{
    publicationPhase=phase;
    await store.recordPublicationPhase(job.id,workerId,phase);
  };
  try {
    const execution = await executionFor(adapters,job,publishing);
    if (publishing) {
      // No effectful replay after a crash or ambiguous publication response.
      await reportPublicationPhase('preflight_reconciliation');
      const existing = await adapters.reconcile(execution);
      if (!existing) await store.publicationUncertain(job.id,workerId,publicationDiagnosticMessage({phase:'preflight_reconciliation',cause:'pull_request_not_found'}));
      else {
        await reportPublicationPhase('state_persistence');
        await store.completePublication(job.id,workerId,{url:existing.url,number:existing.number,branch:existing.branch});
        if (existing.state !== 'open') await store.reconcile(job.id,existing.state);
      }
      return true;
    }
    let changes = job.artifact;
    if (!changes) {
      // Authorization can outlive the lease; fence the paid operation after that read.
      await requireLease();
      changes = await adapters.attempt(execution, async message => {
        await store.appendEvent(job.goal.id,'attempt',message.slice(0,2000));
      });
      if (leaseLost) throw new Error('Worker lease lost');
      await store.saveArtifact(job.id,workerId,changes);
    }
    if (leaseLost) throw new Error('Worker lease lost');
    if (!await store.beginPublication(job.id,workerId)) return true;
    publishing = true;
    await reportPublicationPhase('preflight_reconciliation');
    const existing = await adapters.reconcile(execution);
    // Reconciliation can outlive the lease too; do not begin a new write from stale work.
    if (!existing) await requireLease();
    if(existing)await reportPublicationPhase('state_persistence');
    const result = existing ?? await adapters.publish(execution,changes,requireLease,reportPublicationPhase);
    if(!existing)await reportPublicationPhase('state_persistence');
    await store.completePublication(job.id,workerId,result);
    if (existing && existing.state !== 'open') await store.reconcile(job.id,existing.state);
  } catch (error) {
    const errorId=logFailure(error,{component:publishing?'publication':'attempt',goalId:job.goal.id,jobId:job.id,stage:publishing?publicationPhase:error instanceof DaytonaAttemptError?error.diagnostics[0]?.stage:undefined});
    // Keep detailed redacted causes in runtime logs and only a safe reference in UI.
    try {
      if (publishing) {
        await store.publicationUncertain(job.id,workerId,publicationDiagnosticMessage(publicationDiagnostic(error,publicationPhase)));
        await store.appendEvent(job.goal.id,'diagnostic_reference',`Failure reference: ${errorId}`);
      }
      else await store.fail(job.id,workerId,error instanceof KnownAttemptFailure ? error.message : error instanceof DaytonaAttemptError ? `${error.safeMessage()} Reference: ${errorId}` : `Attempt did not complete safely. Check service diagnostics and sandbox cleanup before starting another goal. Reference: ${errorId}`,!(error instanceof KnownAttemptFailure));
    } catch (saveError) {
      logFailure(saveError,{component:'failure-persistence',goalId:job.goal.id,jobId:job.id});
      // A stale worker must not overwrite the new owner's recovery decision.
      if (!(saveError instanceof StoreError && saveError.status === 409)) throw saveError;
    }
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}

export async function reconcileReviews(store: Store, adapters: Adapters): Promise<void> {
  for (const job of await store.reviewJobs(adapters.mode)) {
    try {
      const current = await adapters.reconcile(await executionFor(adapters,job,true));
      if (current && current.state !== 'open') await store.reconcile(job.id,current.state);
    } catch(error) {
      logFailure(error,{component:'review-reconciliation',goalId:job.goal.id,jobId:job.id});
      // Transient GitHub failures do not change the durable review state. Poll again later.
    }
  }
}

export async function runWorker(store: Store, adapters: Adapters, workerId: string, signal: AbortSignal): Promise<void> {
  let nextReconciliation = 0;
  while (!signal.aborted) {
    try {
      if (Date.now() >= nextReconciliation) {
        await reconcileReviews(store,adapters);
        nextReconciliation = Date.now()+30_000;
      }
      if (!signal.aborted) await runWorkerOnce(store,adapters,workerId);
    } catch(error) {
      logFailure(error,{component:'worker-tick'});
      // Database interruptions leave leases to expire safely; keep the daemon alive.
      console.error('Worker tick unavailable; retrying after backoff. No external operation is automatically replayed.');
      await delay(4000,undefined,{signal}).catch(() => undefined);
    }
    await delay(1000,undefined,{signal}).catch(() => undefined);
  }
}
