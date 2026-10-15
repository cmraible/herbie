import { StaleRepairError } from "./adapters.js";
import type { Adapters, Execution } from "./adapters.js";
import { logFailure } from "./diagnostic-log.js";
import type { Store } from "./store.js";

// Webhooks only request a review. GitHub API reads establish the current PR and CI state.
export async function runCiRepairOnce(
  store: Store,
  adapters: Adapters,
  workerId: string,
): Promise<boolean> {
  if (!adapters.ciStatus) return false;
  await store.recoverCiRepairs();
  const job = await store.takeCiReview();
  if (!job) return false;
  let id: string | null = null;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const controller = new AbortController();
  try {
    const execution: Execution = {
      goal: job.goal,
      branch: job.branch,
      attemptId: job.attemptId,
      repository: await adapters.authorize(job.goal.ownerId, job.goal.repository),
      signal: controller.signal,
    };
    const failure = await adapters.ciStatus(execution);
    if (!failure) return true;
    if (failure.state === "passed") {
      await store.discardWaitingCi(job.id);
      if (!failure.draft) return true;
      const ready = await adapters.markReady?.(execution, failure.head, () =>
        store.beginReadiness(job.id),
      );
      if (ready) await store.confirmReadiness(job.id, failure.pullRequest.url);
      return true;
    }
    id = await store.startCiRepair(job.id, failure.head, workerId);
    if (!id) return true;
    execution.attemptId = id;
    execution.ciRepair = failure;
    const requireLease = async () => {
      controller.signal.throwIfAborted();
      if (!(await store.heartbeatCiRepair(id!, workerId))) {
        controller.abort();
        throw new Error("CI repair lease lost or goal stopped");
      }
      controller.signal.throwIfAborted();
    };
    let renewing = false;
    heartbeat = setInterval(() => {
      if (renewing) return;
      renewing = true;
      void requireLease()
        .catch(() => controller.abort())
        .finally(() => {
          renewing = false;
        });
    }, 5000);
    await requireLease();
    let changes = await store.ciArtifact(id);
    if (!changes) {
      changes = await adapters.attempt(execution, (message) =>
        store.appendEvent(job.goal.id, "ci_repair", message.slice(0, 2000)),
      );
      await requireLease();
      await store.saveCiArtifact(id, workerId, changes);
    }
    if (!changes.verification?.localChecksPassed || changes.baseCommit !== failure.head)
      throw new Error("CI repair lacks matching local verification");
    // A rerun may have passed, or the PR may have changed while the agent worked.
    const current = await adapters.ciStatus(execution);
    await requireLease();
    if (!current) {
      await store.waitForCi(id, workerId);
      return true;
    }
    if (current.state !== "failed" || current.head !== failure.head) {
      await store.finishCiRepair(
        id,
        workerId,
        true,
        "CI repair discarded: checks or PR head changed.",
      );
      return true;
    }
    await requireLease();
    await store.beginCiPublication(id, workerId);
    await adapters.publish(execution, changes, requireLease);
    await requireLease();
    await store.finishCiRepair(
      id,
      workerId,
      true,
      `Locally verified CI fix pushed to ${failure.pullRequest.url}`,
    );
  } catch (error) {
    if (id && error instanceof StaleRepairError) {
      await store.finishCiRepair(
        id,
        workerId,
        true,
        "CI repair discarded: PR head changed before publication.",
      );
      return true;
    }
    const reference = logFailure(error, {
      component: "ci-repair",
      goalId: job.goal.id,
      jobId: job.id,
    });
    if (id)
      await store.finishCiRepair(
        id,
        workerId,
        false,
        `CI repair stopped. Inspect diagnostics, sandbox cleanup, and PR state before manual recovery. Reference: ${reference}`,
      );
    // The periodic poll retries failed reads; immediate requeue starves other PRs.
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
  return true;
}
