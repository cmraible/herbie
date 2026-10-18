import { randomUUID } from "node:crypto";
import { failureDiagnosticRecord, logFailure } from "./diagnostic-log.js";
import { AgentAttemptError, type AgentAttemptChanges } from "@herbie/loop/agent-attempt";
import type { Adapters, Execution } from "./adapters.js";
import type { Store } from "./store.js";

// Only actual agent execution creates a session; publication retries reuse saved work.
export async function runAgentSession(
  store: Store,
  adapters: Adapters,
  execution: Execution,
  runId: string,
  workerId: string,
  kind: "implementation" | "ci_repair" | "pr_feedback",
) {
  const id = await store.startAgentSession(
    runId,
    execution.attemptId,
    kind,
    workerId,
    execution.project,
  );
  let threadId: string | undefined;
  let changes: AgentAttemptChanges | undefined;
  try {
    changes = await adapters.attempt(
      {
        ...execution,
        agentSessionId: id,
        onEnvironment: (environment) => store.recordAgentSession(id, { environment }),
        onActivity: async (message) => {
          await store.appendEvent(execution.project.id, "agent", message, runId, id);
          const record = JSON.parse(message);
          if (
            typeof record?.params?.threadId === "string" &&
            (record.params.threadId !== threadId || record.method === "thread/tokenUsage/updated")
          ) {
            threadId = record.params.threadId;
            await store.recordAgentSession(id, {
              threadId,
              ...(record.method === "thread/tokenUsage/updated"
                ? { usage: record.params.tokenUsage }
                : {}),
            });
          }
        },
      },
      (message) =>
        store.appendEvent(
          execution.project.id,
          kind === "implementation" ? "attempt" : kind,
          message.slice(0, 2000),
          runId,
          id,
        ),
    );
    await store.finishAgentSession(
      id,
      "completed",
      changes.verification?.sandboxDeleted ? "confirmed" : "unconfirmed",
      changes,
    );
    return changes;
  } catch (error) {
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
