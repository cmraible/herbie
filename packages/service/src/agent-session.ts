import { randomUUID } from "node:crypto";
import { failureDiagnosticRecord, logFailure } from "./diagnostic-log.js";
import {
  SessionDetached,
  AgentAttemptError,
  type AgentAttemptChanges,
} from "@herbie/loop/agent-attempt";
import type { Adapters, Execution } from "./adapters.js";
import type { Store } from "./store.js";

async function observe<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  let abort: () => void = () => {};
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        abort = () => {
          if (signal.reason instanceof SessionDetached) reject(signal.reason);
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

// Only actual agent execution creates a session; publication retries reuse saved work.
export async function runAgentSession(
  store: Store,
  adapters: Adapters,
  execution: Execution,
  runId: string,
  workerId: string,
  kind: "implementation" | "ci_repair" | "pr_feedback",
) {
  const id =
    execution.agentSessionId ??
    (await store.startAgentSession(
      runId,
      execution.attemptId,
      kind,
      workerId,
      execution.project,
      adapters.durableSessions ? execution : undefined,
    ));
  const saved = adapters.durableSessions ? await store.agentSessionExecution(id) : undefined;
  if (saved?.artifact) return saved.artifact;
  let threadId: string | undefined;
  let changes: AgentAttemptChanges | undefined;
  try {
    changes = await observe(
      adapters.attempt(
        {
          ...execution,
          agentSessionId: id,
          durable: saved
            ? {
                checkpoint: saved.checkpoint,
                save: (checkpoint) => store.checkpointAgentSession(id, workerId, checkpoint),
              }
            : undefined,
          onEnvironment: (environment) => {
            execution.signal?.throwIfAborted();
            return store.recordAgentSession(id, { environment }, workerId);
          },
          onActivity: async (message, offset) => {
            execution.signal?.throwIfAborted();
            const record = JSON.parse(message);
            if (
              typeof record?.params?.threadId === "string" &&
              (record.params.threadId !== threadId || record.method === "thread/tokenUsage/updated")
            ) {
              threadId = record.params.threadId;
              await store.recordAgentSession(
                id,
                {
                  threadId,
                  ...(record.method === "thread/tokenUsage/updated"
                    ? { usage: record.params.tokenUsage }
                    : {}),
                },
                workerId,
              );
            }
            // The saved offset acknowledges metadata as well as the transcript.
            await store.appendEvent(execution.project.id, "agent", message, runId, id, offset);
          },
        },
        (message) => {
          if (execution.signal?.reason instanceof SessionDetached) throw execution.signal.reason;
          return store.appendEvent(
            execution.project.id,
            kind === "implementation" ? "attempt" : kind,
            message.slice(0, 2000),
            runId,
            id,
          );
        },
      ),
      adapters.durableSessions ? execution.signal : undefined,
    );
    await store.finishAgentSession(
      id,
      "completed",
      changes.verification?.sandboxDeleted ? "confirmed" : "unconfirmed",
      changes,
      undefined,
      workerId,
    );
    return changes;
  } catch (error) {
    if (error instanceof SessionDetached || execution.signal?.reason instanceof SessionDetached)
      throw new SessionDetached("Session observer detached", { cause: error });
    if (changes && adapters.durableSessions)
      throw new SessionDetached("Session outcome will be recovered from its checkpoint", {
        cause: error,
      });
    // The outer worker still needs execution evidence when session persistence fails.
    let failure = error;
    if (changes && !(error instanceof AgentAttemptError)) {
      const persistenceError = new AgentAttemptError(
        [error],
        "Agent session outcome persistence failed",
        { cause: error },
      );
      persistenceError.changes = changes;
      persistenceError.cleanup = changes.verification?.sandboxDeleted ? "confirmed" : "unconfirmed";
      failure = persistenceError;
    }
    try {
      await store.finishAgentSession(
        id,
        execution.signal?.aborted ? "cancelled" : "failed",
        failure instanceof AgentAttemptError ? failure.cleanup : "unconfirmed",
        failure instanceof AgentAttemptError ? failure.changes : undefined,
        failureDiagnosticRecord(
          failure,
          { component: "agent-session", projectId: execution.project.id, jobId: runId },
          randomUUID(),
        ),
        workerId,
      );
    } catch (saveError) {
      logFailure(saveError, {
        component: "session-failure-persistence",
        projectId: execution.project.id,
        jobId: runId,
      });
    }
    throw failure;
  }
}
