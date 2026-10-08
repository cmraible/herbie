import { setTimeout as delay } from 'node:timers/promises';
import { KnownAttemptFailure, type Adapters, type Execution } from './adapters.js';
import type { Job } from './store.js';
import { Store, StoreError } from './store.js';

async function executionFor(adapters: Adapters, job: Job, readOnly = false): Promise<Execution> {
  const repository = readOnly ? await adapters.reconciliationRepository(job.goal.repository) : await adapters.authorize(job.goal.ownerId, job.goal.repository);
  return {goal:job.goal, repository, attemptId:job.attemptId, branch:job.branch};
}

// One claim per tick. Leases fence database writes; uncertain external effects never retry.
export async function runWorkerOnce(store: Store, adapters: Adapters, workerId: string): Promise<boolean> {
  await store.recoverExpired();
  const job = await store.claim(workerId,30_000,adapters.mode);
  if (!job) return false;
  let leaseLost = false;
  let renewing = false;
  const heartbeat = setInterval(() => {
    if (renewing) return;
    renewing = true;
    void store.heartbeat(job.id,workerId,30_000).then(owned => { if (!owned) leaseLost = true; })
      .catch(() => { leaseLost = true; }).finally(() => { renewing = false; });
  },5_000);
  let publishing = job.stage === 'publishing';
  try {
    const execution = await executionFor(adapters,job,publishing);
    if (publishing) {
      // No effectful replay after a crash or ambiguous publication response.
      const existing = await adapters.reconcile(execution);
      if (!existing) await store.publicationUncertain(job.id,workerId,'Publication outcome unknown; inspect the attempt branch on GitHub.');
      else {
        await store.completePublication(job.id,workerId,{url:existing.url,number:existing.number,branch:existing.branch});
        if (existing.state !== 'open') await store.reconcile(job.id,existing.state);
      }
      return true;
    }
    let changes = job.artifact;
    if (!changes) {
      changes = await adapters.attempt(execution, async message => {
        await store.appendEvent(job.goal.id,'attempt',message.slice(0,2000));
      });
      if (leaseLost) throw new Error('Worker lease lost');
      await store.saveArtifact(job.id,workerId,changes);
    }
    if (leaseLost) throw new Error('Worker lease lost');
    if (!await store.beginPublication(job.id,workerId)) return true;
    publishing = true;
    const existing = await adapters.reconcile(execution);
    const result = existing ?? await adapters.publish(execution,changes);
    await store.completePublication(job.id,workerId,result);
    if (existing && existing.state !== 'open') await store.reconcile(job.id,existing.state);
  } catch (error) {
    // Error text from SDKs can contain credentials, URLs or generated output. Store a safe summary.
    try {
      if (publishing) await store.publicationUncertain(job.id,workerId,'Publication could not be confirmed; reconciliation will check GitHub.');
      else await store.fail(job.id,workerId,error instanceof KnownAttemptFailure ? error.message : 'Attempt did not complete safely. Check service diagnostics and sandbox cleanup before starting another goal.',!(error instanceof KnownAttemptFailure));
    } catch (saveError) {
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
    } catch {
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
    } catch {
      // Database interruptions leave leases to expire safely; keep the daemon alive.
      console.error('Worker tick unavailable; retrying after backoff. No external operation is automatically replayed.');
      await delay(4000,undefined,{signal}).catch(() => undefined);
    }
    await delay(1000,undefined,{signal}).catch(() => undefined);
  }
}
