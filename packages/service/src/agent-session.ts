import { randomUUID } from "node:crypto";
import { failureDiagnosticRecord } from "./diagnostic-log.js";
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
  const id = await store.startAgentSession(runId, execution.attemptId, kind, workerId);
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
    await store.finishAgentSession(
      id,
      execution.signal?.aborted ? "cancelled" : "failed",
      error instanceof AgentAttemptError
        ? error.cleanup
        : changes?.verification?.sandboxDeleted
          ? "confirmed"
          : "unconfirmed",
      error instanceof AgentAttemptError ? error.changes : changes,
      failureDiagnosticRecord(
        error,
        { component: "agent-session", projectId: execution.project.id, jobId: runId },
        randomUUID(),
      ),
    );
    throw error;
  }
}
