import { parseFeedbackDecision } from "@herbie/loop/daytona-attempt";
import { hasValidPublicationEvidence } from "@herbie/loop/publish-patch";
import { StaleRepairError, type Adapters, type Execution } from "./adapters.js";
import { logFailure } from "./diagnostic-log.js";
import type { Store } from "./store.js";

export async function runFeedbackOnce(
  store: Store,
  adapters: Adapters,
  workerId: string,
): Promise<boolean> {
  if (!adapters.feedback || !adapters.replyToFeedback) return false;
  await store.recoverFeedback();
  const job = await store.takeFeedbackReview();
  if (!job) return false;
  let id: string | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const controller = new AbortController();
  try {
    const execution: Execution = {
      project: job.project,
      branch: job.branch,
      attemptId: job.attemptId,
      repository: await adapters.authorize(job.project.ownerId, job.project.repository),
      signal: controller.signal,
      onActivity: (message) => store.appendEvent(job.project.id, "agent", message, job.id),
    };
    const current = await adapters.reconcile(execution);
    if (!current || current.state !== "open" || !current.headSha) return true;
    if (await store.reconcilePullRequestHead(job.id, current)) return true;
    const context = await adapters.feedback(execution);
    const claimed = await store.startFeedback(job.id, context, workerId);
    if (!claimed) return true;
    id = claimed.id;
    execution.attemptId = id;
    execution.feedback = {
      head: current.headSha,
      pullRequest: current,
      item: claimed.item,
      context,
    };
    const requireLease = async () => {
      controller.signal.throwIfAborted();
      if (!(await store.heartbeatFeedback(id!, workerId))) {
        controller.abort();
        throw new Error("Feedback lease lost or project stopped");
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
    try {
      await adapters.acknowledgeFeedback?.(execution, requireLease);
    } catch (error) {
      logFailure(error, { component: "feedback-acknowledgement", jobId: job.id });
    }
    await requireLease();
    const changes = await adapters.attempt(execution, (message) =>
      store.appendEvent(job.project.id, "pr_feedback", message.slice(0, 2000), job.id),
    );
    await requireLease();
    const decision = parseFeedbackDecision(changes.feedbackDecision);
    if (
      !hasValidPublicationEvidence(job.project.repository, changes) ||
      changes.baseCommit !== current.headSha
    )
      throw new Error("Feedback lacks matching completion and cleanup evidence");
    if ((decision.action === "update") !== changes.patch.length > 0)
      throw new Error("Feedback decision does not match repository changes");
    if (decision.action === "update" && !changes.verification?.localChecksPassed)
      throw new Error("Feedback update lacks local verification");
    await store.saveFeedbackArtifact(id, workerId, changes);
    // Re-read feedback before any write: an edited or deleted comment invalidates this decision.
    const latest = await adapters.feedback(execution);
    const unchanged = latest.some(
      (item) =>
        item.kind === claimed.item.kind &&
        item.id === claimed.item.id &&
        item.revision === claimed.item.revision,
    );
    if (!unchanged) {
      await store.finishFeedback(
        id,
        workerId,
        true,
        "Feedback changed or was deleted; discarded the stale decision.",
      );
      return true;
    }
    const fresh = await adapters.reconcile(execution);
    await requireLease();
    if (!fresh || fresh.state !== "open") {
      await store.finishFeedback(id, workerId, true, "PR closed; discarded feedback decision.");
      return true;
    }
    if (fresh.headSha !== current.headSha)
      throw new StaleRepairError("PR changed while considering feedback");
    if (decision.action === "update") {
      const published = await adapters.publish(execution, changes, requireLease);
      await requireLease();
      await store.recordFeedbackPublication(id, workerId, {
        ...published,
        state: published.state ?? "open",
      });
      if (!published.headSha) throw new Error("Published feedback update has no confirmed head");
      execution.feedback.head = published.headSha;
    }
    if (decision.action !== "ignore")
      await adapters.replyToFeedback(execution, decision.reply, requireLease);
    await requireLease();
    await store.finishFeedback(
      id,
      workerId,
      true,
      decision.action === "ignore"
        ? `Ignored feedback: ${decision.reason}`
        : decision.action === "reply"
          ? `Replied to feedback: ${claimed.item.url}`
          : `Updated PR and replied to feedback: ${claimed.item.url}`,
    );
  } catch (error) {
    const reference = logFailure(error, {
      component: "pr-feedback",
      projectId: job.project.id,
      jobId: job.id,
    });
    if (id)
      await store.finishFeedback(
        id,
        workerId,
        false,
        `Feedback stopped. Inspect sandbox cleanup and PR writes before manual recovery. Reference: ${reference}`,
      );
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}
