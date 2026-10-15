import { runCiRepairOnce } from "./ci-repair.js";
import { hasValidPublicationEvidence } from "@herbie/loop/publish-patch";
import { logFailure } from "./diagnostic-log.js";
import { DaytonaAttemptError } from "@herbie/loop/daytona-attempt";
import { setTimeout as delay } from "node:timers/promises";
import {
  KnownAttemptFailure,
  PublicationBlockedError,
  type Adapters,
  type Execution,
} from "./adapters.js";
import type { Job } from "./store.js";
import { Store, StoreError } from "./store.js";
import { publicationDiagnostic, publicationDiagnosticMessage } from "./publication-diagnostics.js";
import type { PublicationPhase } from "./adapters.js";

async function executionFor(adapters: Adapters, job: Job, readOnly: boolean): Promise<Execution> {
  const repository = readOnly
    ? await adapters.reconciliationRepository(job.goal.repository)
    : await adapters.authorize(job.goal.ownerId, job.goal.repository);
  return { goal: job.goal, repository, attemptId: job.attemptId, branch: job.branch };
}

// One claim per tick. Saved publication retries require lease and remote-state checks.
export async function runWorkerOnce(
  store: Store,
  adapters: Adapters,
  workerId: string,
  timing = { leaseMs: 30_000, heartbeatMs: 5_000 },
): Promise<boolean> {
  const { leaseMs, heartbeatMs } = timing;
  await store.recoverExpired();
  const job = await store.claim(workerId, leaseMs, adapters.mode);
  if (!job) return false;
  let leaseLost = false;
  const controller = new AbortController();
  const loseLease = () => {
    leaseLost = true;
    controller.abort();
  };
  let renewing = false;
  const heartbeat = setInterval(() => {
    if (renewing) return;
    renewing = true;
    void store
      .heartbeat(job.id, workerId, leaseMs)
      .then((owned) => {
        if (!owned) loseLease();
      })
      .catch((error) => {
        loseLease();
        logFailure(error, { component: "worker-heartbeat", goalId: job.goal.id, jobId: job.id });
      })
      .finally(() => {
        renewing = false;
      });
  }, heartbeatMs);
  const requireLease = async (): Promise<void> => {
    if (leaseLost) throw new StoreError(409, "Worker lease lost");
    const owned = await store.heartbeat(job.id, workerId, leaseMs);
    if (!owned || leaseLost) {
      loseLease();
      throw new StoreError(409, "Worker lease lost");
    }
  };
  const recoveringPublication = job.stage === "publishing";
  let publishing = recoveringPublication;
  let publicationPhase: PublicationPhase = "preflight_reconciliation";
  const reportPublicationPhase = async (phase: PublicationPhase): Promise<void> => {
    publicationPhase = phase;
    if (!recoveringPublication) await store.recordPublicationPhase(job.id, workerId, phase);
  };
  let changes = job.artifact;
  let published: { url: string; number: number; branch: string } | undefined;
  try {
    await requireLease();
    // A recovered ready artifact must enter publication before authorization can fail;
    // otherwise an auth outage would strand saved work as an attempt failure.
    if (changes && !publishing) {
      if (!(await store.beginPublication(job.id, workerId))) return true;
      publishing = true;
    }
    const execution = {
      ...(await executionFor(adapters, job, publishing)),
      signal: controller.signal,
    };
    await requireLease();
    if (recoveringPublication) {
      // Reconcile first, including after a crash or ambiguous remote write.
      await reportPublicationPhase("preflight_reconciliation");
      const existing = await adapters.reconcile(execution);
      if (!existing) {
        if (!changes || !hasValidPublicationEvidence(job.goal.repository, changes)) {
          await store.blockPublication(
            job.id,
            workerId,
            "saved artifact lacks matching test and cleanup evidence",
          );
          return true;
        }
        if (!adapters.checkPublicationRetry) {
          await store.publicationUncertain(
            job.id,
            workerId,
            publicationDiagnosticMessage({
              phase: "preflight_reconciliation",
              cause: "pull_request_not_found",
            }),
          );
          return true;
        }
        const check = await adapters.checkPublicationRetry(execution, changes);
        await requireLease();
        if (check === "branch_exists" || check === "base_changed") {
          await store.blockPublication(
            job.id,
            workerId,
            check === "branch_exists"
              ? "the attempt branch exists without a confirmed pull request; it will not be overwritten"
              : "repository history no longer contains the original base",
          );
          return true;
        }
        if (check === "pull_request_exists") {
          await store.publicationUncertain(
            job.id,
            workerId,
            "A pull request appeared during the safety check; reconciliation will confirm it.",
          );
          return true;
        }
        published = await adapters.publish(
          execution,
          changes,
          requireLease,
          reportPublicationPhase,
        );
        await requireLease();
        await reportPublicationPhase("state_persistence");
        await store.completePublication(job.id, workerId, published);
      } else {
        published = existing;
        await reportPublicationPhase("state_persistence");
        await store.completePublication(job.id, workerId, existing);
      }
      return true;
    }
    controller.signal.throwIfAborted();
    if (!changes) {
      // Authorization can outlive the lease; fence the paid operation after that read.
      await requireLease();
      changes = await adapters.attempt(execution, async (message) => {
        await store.appendEvent(job.goal.id, "attempt", message.slice(0, 2000), job.id);
      });
      await requireLease();
      await store.saveArtifact(job.id, workerId, changes);
    }
    if (leaseLost) throw new Error("Worker lease lost");
    if (!publishing && !(await store.beginPublication(job.id, workerId))) {
      await store.finishCancelled(
        job.id,
        workerId,
        changes?.verification?.sandboxDeleted ? "complete" : "needs_attention",
        changes ?? undefined,
      );
      return true;
    }
    publishing = true;
    await reportPublicationPhase("preflight_reconciliation");
    const existing = await adapters.reconcile(execution);
    // Reconciliation can outlive the lease too; do not begin a new write from stale work.
    if (!existing) await requireLease();
    if (existing) await reportPublicationPhase("state_persistence");
    const result =
      existing ??
      (await adapters.publish(execution, changes, requireLease, reportPublicationPhase));
    published = result;
    if (!existing) await reportPublicationPhase("state_persistence");
    await store.completePublication(job.id, workerId, result);
  } catch (error) {
    const cancelled = await store.getGoal(job.goal.id);
    if (cancelled?.state === "cancelled") {
      controller.abort();
      await store.finishCancelled(
        job.id,
        workerId,
        !publishing &&
          (error instanceof DaytonaAttemptError
            ? error.cleanup === "confirmed"
            : changes?.verification?.sandboxDeleted === true)
          ? "complete"
          : "needs_attention",
        changes ?? (error instanceof DaytonaAttemptError ? error.changes : undefined),
        published,
      );
      return true;
    }
    const errorId = logFailure(error, {
      component: publishing ? "publication" : "attempt",
      goalId: job.goal.id,
      jobId: job.id,
      stage: publishing
        ? publicationPhase
        : error instanceof DaytonaAttemptError
          ? error.diagnostics[0]?.stage
          : undefined,
    });
    // Keep detailed redacted causes in runtime logs and only a safe reference in UI.
    try {
      if (publishing && error instanceof PublicationBlockedError) {
        await store.blockPublication(job.id, workerId, error.message);
      } else if (publishing) {
        await store.publicationUncertain(
          job.id,
          workerId,
          publicationDiagnosticMessage(publicationDiagnostic(error, publicationPhase)),
          errorId,
        );
      } else
        await store.fail(
          job.id,
          workerId,
          error instanceof KnownAttemptFailure
            ? error.message
            : error instanceof DaytonaAttemptError
              ? `Run failed. ${error.changes ? "Your patches are saved." : "No patches were saved."} Reference: ${errorId}`
              : `Run failed. No patches were saved. Reference: ${errorId}`,
          !(error instanceof KnownAttemptFailure),
          changes ?? (error instanceof DaytonaAttemptError ? error.changes : undefined),
        );
    } catch (saveError) {
      logFailure(saveError, {
        component: "failure-persistence",
        goalId: job.goal.id,
        jobId: job.id,
      });
      // A stale worker must not overwrite the new owner's recovery decision.
      if (!(saveError instanceof StoreError && saveError.status === 409)) throw saveError;
    }
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}

export async function reconcileReviews(store: Store, adapters: Adapters): Promise<void> {
  // Recovery of a past write must not depend on current CI, goal state, or PR state.
  if (adapters.readinessState)
    for (const job of await store.reviewJobs(adapters.mode, true)) {
      try {
        const state = await adapters.readinessState(await executionFor(adapters, job, true));
        if (
          state === "closed" ||
          (state === "draft" && ["cancelled", "completed", "failed"].includes(job.goal.state))
        )
          await store.cancelReadiness(job.id);
        if (state === "ready") {
          const pr = job.goal.pullRequests.find((pr) => pr.branch === job.branch);
          if (pr) await store.confirmReadiness(job.id, pr.url);
        }
      } catch (error) {
        logFailure(error, {
          component: "readiness-reconciliation",
          goalId: job.goal.id,
          jobId: job.id,
        });
      }
    }
  for (const job of await store.reviewJobs(adapters.mode)) {
    try {
      const current = await adapters.reconcile(await executionFor(adapters, job, true));
      if (current?.state === "open" && current.headSha)
        await store.reconcilePullRequestHead(job.id, current.headSha);
      else if (current && current.state !== "open") await store.reconcile(job.id, current.state);
    } catch (error) {
      logFailure(error, { component: "review-reconciliation", goalId: job.goal.id, jobId: job.id });
      // Transient GitHub failures do not change the durable review state. Poll again later.
    }
  }
}

export async function runWorker(
  store: Store,
  adapters: Adapters,
  workerId: string,
  signal: AbortSignal,
): Promise<void> {
  let nextReconciliation = 0;
  let nextCiPoll = 0;
  while (!signal.aborted) {
    try {
      if (Date.now() >= nextReconciliation) {
        await reconcileReviews(store, adapters);
        nextReconciliation = Date.now() + 30_000;
      }
      if (adapters.ciStatus && Date.now() >= nextCiPoll) {
        await store.requestCiReview();
        nextCiPoll = Date.now() + 10 * 60_000;
      }
      if (!signal.aborted) await runCiRepairOnce(store, adapters, workerId);
      if (!signal.aborted) await runWorkerOnce(store, adapters, workerId);
    } catch (error) {
      logFailure(error, { component: "worker-tick" });
      // Database interruptions leave leases to expire safely; keep the daemon alive.
      console.error(
        "Worker tick unavailable; retrying after backoff. No external operation is automatically replayed.",
      );
      await delay(4000, undefined, { signal }).catch(() => undefined);
    }
    await delay(1000, undefined, { signal }).catch(() => undefined);
  }
}

/**
 * Run one coordinator per database while allowing multiple HTTP processes to
 * overlap during a zero-downtime rollout. PostgreSQL releases the session lock
 * if the owning process or connection disappears.
 */
export async function runExclusiveWorker(
  store: Store,
  adapters: Adapters,
  workerId: string,
  signal: AbortSignal,
): Promise<void> {
  const client = await store.pool.connect();
  let locked = false;
  const connectionLost = new AbortController();
  const onError = (error: Error) => {
    logFailure(error, { component: "coordinator-lock" });
    connectionLost.abort(error);
  };
  client.on("error", onError);
  try {
    while (!signal.aborted) {
      const result = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtext(current_database()),hashtext(current_schema())) AS locked",
      );
      locked = result.rows[0]?.locked === true;
      if (locked) break;
      try {
        await delay(1000, undefined, { signal });
      } catch (error) {
        if (!signal.aborted) throw error;
      }
    }
    if (!locked) return;
    console.log(`Herbie coordinator ${workerId} acquired exclusive database ownership.`);
    await runWorker(store, adapters, workerId, AbortSignal.any([signal, connectionLost.signal]));
    if (connectionLost.signal.aborted && !signal.aborted) throw connectionLost.signal.reason;
  } finally {
    client.off("error", onError);
    if (locked && !connectionLost.signal.aborted) {
      try {
        await client.query(
          "SELECT pg_advisory_unlock(hashtext(current_database()),hashtext(current_schema()))",
        );
      } catch (error) {
        logFailure(error, { component: "coordinator-unlock" });
      }
    }
    client.release(connectionLost.signal.aborted);
  }
}
