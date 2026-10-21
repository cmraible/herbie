import { parsePublicationDecision, type PublicationDecision } from "./publication-decision.js";
import { executeDurably, SessionDetached, type DurableAttempt } from "./durable-execution.js";
export {
  SessionDetached,
  type DurableAttempt,
  type AttemptCheckpoint,
} from "./durable-execution.js";
import { streamAgentTranscript } from "./agent-transcript.js";
import { followAgentTranscript } from "./transcript-stream.js";
export { parseFeedbackDecision } from "./feedback-decision.js";
import { parseFeedbackDecision, type FeedbackDecision } from "./feedback-decision.js";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Environment, EnvironmentProvider } from "./environment.js";

import {
  AttemptCommandError,
  AttemptResultError,
  AttemptReportError,
  attemptDiagnostic,
  attemptDiagnosticMessage,
  type AttemptStage,
  type AttemptDiagnostic,
} from "./attempt-diagnostics.js";

import { environmentPath } from "./environment-runtime.js";
import { MAX_ARTIFACT_BYTES, MAX_PATCH_BYTES } from "./artifact-limits.js";
import { registerDiagnosticSecret } from "./diagnostic-log.js";

export const AGENT_RUNTIME_FILES = [
  "codex-initialize.js",
  "codex-thread.js",
  "codex-turn.js",
  "codex-process.js",
  "agent-runner.js",
  "feedback-decision.js",
  "publication-decision.js",
  "diagnostic-log.js",
  "repository-checkout.js",
] as const;

export interface AgentAttemptArtifact {
  baseCommit: string;
  patchBase64: string;
  pullRequestTitle?: string;
  pullRequestBody?: string;
  publicationDecision?: PublicationDecision;
  feedbackDecision?: FeedbackDecision;
  localChecksPassed?: true;
}

export type AttemptRequest = {
  durable?: DurableAttempt;
  onEnvironment?: (environment: { provider: string; id: string }) => Promise<void>;
  signal?: AbortSignal;
  resources?: { cpu: number; memory: number; disk: number };
  repoUrl: string;
  // Resolve only during checkout, never persist in a checkpoint or agent input.
  checkoutToken?: () => Promise<string>;
  branch?: string;
  commit?: string;
  project: string;
  model?: string;
  reasoningEffort?: string;
  verifyLocally?: boolean;
  onActivity?: (message: string, offset?: number) => Promise<void>;
  feedback?: boolean;
};

export interface AgentAttemptChanges {
  baseCommit: string;
  patch: Buffer;
  publicationDecision?: PublicationDecision;
  feedbackDecision?: FeedbackDecision;
  // Absent for explicit pause decisions and artifacts saved before agent-authored descriptions.
  pullRequestBody?: string;
  // Absent for explicit pause decisions and artifacts saved before agent-authored titles.
  pullRequestTitle?: string;
  // Issued by the host only after the project and sandbox deletion succeed.
  verification?: {
    // Version 2 also recorded tests; version 3 records completion and cleanup only.
    // Unversioned legacy artifacts remain ineligible for publication.
    version?: 2 | 3;
    repoUrl: string;
    baseCommit: string;
    patchSha256: string;
    goalCompleted: true;
    sandboxDeleted: true;
    localChecksPassed?: true;
  };
}

export class AgentAttemptError extends AggregateError {
  // Keep retrieved changes available even if subsequent deletion fails.
  changes?: AgentAttemptChanges;
  diagnostics: AttemptDiagnostic[] = [];
  cleanup: "confirmed" | "unconfirmed" = "unconfirmed";
  safeMessage(): string {
    return `Attempt failed (${this.diagnostics.map(attemptDiagnosticMessage).join("; ") || "diagnostic unavailable"}). Sandbox deletion ${this.cleanup}. No automatic retry.`;
  }
}

async function downloadBounded(sandbox: Environment, path: string, limit: number): Promise<Buffer> {
  const controller = new AbortController();
  const stream = await sandbox.readFile(path, {
    timeoutMs: 30_000,
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
  });
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for await (const chunk of stream) {
      if (!Buffer.isBuffer(chunk)) throw new Error("Invalid artifact stream");
      length += chunk.length;
      if (length > limit) throw new Error("Sandbox artifact exceeds its byte limit");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, length);
  } finally {
    // Stop the HTTP transfer as well as its consumer on overflow, timeout, or read failure.
    controller.abort();
    stream.destroy();
  }
}

// Use the built adapter (or provide a directory containing the built runtime files).
// Providers keep model credentials outside the guest through their egress proxies.
export async function runAgentAttempt(
  provider: EnvironmentProvider,
  request: AttemptRequest,
  report: (message: string) => void | Promise<void>,
  runtimeDirectory = new URL(".", import.meta.url),
): Promise<AgentAttemptChanges> {
  if (
    request.resources &&
    Object.values(request.resources).some((value) => !Number.isSafeInteger(value) || value < 1)
  )
    throw new Error("Environment resources must be positive whole numbers");
  let stage: AttemptStage = "sandbox_creation";
  const persist = async (write: () => void | Promise<void>): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(write),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Attempt event persistence timed out")), 5000);
        }),
      ]);
    } catch (cause) {
      if (request.durable)
        throw new SessionDetached("Session observer persistence unavailable", { cause });
      throw new AttemptReportError("Attempt event persistence failed", { cause });
    } finally {
      clearTimeout(timer);
    }
  };
  const emit = (message: string, sink = report) => persist(() => sink(message));
  const begin = async (next: AttemptStage): Promise<void> => {
    if (next !== "sandbox_deletion") request.signal?.throwIfAborted();
    stage = next;
    await emit(`Attempt stage: ${stage}`);
    if (next !== "sandbox_deletion") request.signal?.throwIfAborted();
  };
  const repo = new URL(request.repoUrl);
  if (repo.protocol !== "https:" || repo.username || repo.password || repo.search || repo.hash) {
    throw new Error("Use an HTTPS repository URL without credentials, query, or fragment");
  }
  if (
    request.checkoutToken &&
    (repo.origin !== "https://github.com" || !/^\/[\w.-]+\/[\w.-]+\.git$/.test(repo.pathname))
  )
    throw new Error("Authenticated checkout requires a GitHub repository URL");
  if (!request.project.trim()) throw new Error("Project must not be empty");
  const runtime = await Promise.all(
    AGENT_RUNTIME_FILES.map(async (name) => ({
      name,
      contents: await readFile(new URL(name, runtimeDirectory)),
    })),
  );
  const durable = request.durable;
  let checkpoint = durable?.checkpoint;
  if (
    checkpoint &&
    (checkpoint.version !== 1 || (checkpoint.provider && checkpoint.provider !== provider.name))
  )
    throw new SessionDetached("Session requires its original environment provider and protocol");
  const save = async (update: Partial<NonNullable<typeof checkpoint>>) => {
    if (!durable || !checkpoint) return;
    checkpoint = { ...checkpoint, ...update };
    try {
      await durable.save(checkpoint);
    } catch (cause) {
      throw new SessionDetached("Session checkpoint could not be saved", { cause });
    }
  };
  const name = checkpoint?.name ?? `herbie-attempt-${randomUUID()}`;
  if (!/^herbie-attempt-[a-f0-9-]+$/.test(name))
    throw new Error("Invalid session environment name");
  const directory = `/tmp/${name}`;
  const cwd = `${directory}/repo`;
  if (!checkpoint || !request.signal?.aborted) {
    await begin("sandbox_creation");
    await emit(`Creating sandbox ${name}`);
  }
  let sandbox: Environment;
  try {
    if (!checkpoint || request.signal?.reason instanceof SessionDetached)
      request.signal?.throwIfAborted();
    await save({ provider: provider.name });
    const connected =
      checkpoint?.phase === "deleted"
        ? null
        : checkpoint?.environmentId
          ? await provider.connect!(checkpoint.environmentId, request.resources)
          : ((checkpoint ? await provider.find?.(name, request.resources) : null) ??
            (request.signal?.aborted
              ? null
              : await provider.create({
                  name,
                  resources: request.resources,
                  signal: request.signal,
                  timeoutMs: (request.verifyLocally ? 45 : 35) * 60_000,
                })));
    if (!connected && !["collected", "deleted"].includes(checkpoint?.phase ?? "")) {
      const error = new AgentAttemptError(
        [],
        "Session environment no longer exists; execution cannot be repeated automatically",
      );
      error.cleanup = checkpoint?.environmentId || provider.find ? "confirmed" : "unconfirmed";
      throw error;
    }
    const absent = async (): Promise<never> => {
      throw new Error("Environment already deleted");
    };
    sandbox = connected ?? {
      id: checkpoint!.environmentId!,
      prepare: absent,
      mkdir: absent,
      writeFile: absent,
      readFile: absent,
      clone: absent,
      exec: absent,
      destroy: async () => {},
    };
    if (!request.signal?.aborted) await save({ environmentId: sandbox.id });
  } catch (cause) {
    if (cause instanceof AgentAttemptError) throw cause;
    if (durable) throw new SessionDetached("Environment connection unavailable", { cause });
    const error = new AgentAttemptError(
      [cause],
      `Creation failed for ${name}; cleanup is unconfirmed. Check the environment provider by name.`,
      { cause },
    );
    error.diagnostics = [attemptDiagnostic(cause, stage)];
    throw error;
  }
  const failures: Error[] = [];
  const diagnostics: AttemptDiagnostic[] = [];
  let cleanupConfirmed = false;
  // Deletion interrupts an in-flight model command. Do not wait for its normal
  // completion before attempting to stop paid execution. A failed delete remains
  // unconfirmed; it never permits another attempt or a publication.
  let deletion: Promise<void> | undefined;
  const removeSandbox = () =>
    (deletion ??= (async () => {
      let lastError: unknown;
      for (let retry = 0; retry < 3; retry++) {
        try {
          await sandbox.destroy();
          cleanupConfirmed = true;
          return;
        } catch (error) {
          lastError = error;
          if (retry < 2) await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** retry));
        }
      }
      throw lastError;
    })());
  const abort = () => {
    if (request.signal?.reason instanceof SessionDetached) return;
    void removeSandbox().catch(() => undefined);
  };
  request.signal?.addEventListener("abort", abort, { once: true });
  if (request.signal?.aborted) abort();
  let changes: AgentAttemptChanges | undefined;
  let legacyArtifact: string | undefined;
  let detached = false;
  let cleanupPending: SessionDetached | undefined;
  try {
    request.signal?.throwIfAborted();
    await emit(`Created sandbox ${sandbox.id}`);
    if (request.onEnvironment)
      await persist(() => request.onEnvironment!({ provider: provider.name, id: sandbox.id }));
    if (!checkpoint || checkpoint.phase === "created") {
      await begin("runtime_preparation");
      await sandbox.prepare(
        checkpoint
          ? {
              directory: `${directory}/setup`,
              deadline: checkpoint.deadline,
              signal: request.signal,
            }
          : undefined,
      );
      if (request.resources)
        await emit(
          `Environment resources: ${request.resources.cpu} CPUs, ${request.resources.memory} GiB memory, ${request.resources.disk} GiB disk`,
        );
      await begin("runtime_upload");
      if (checkpoint) {
        const created = await sandbox.exec(`mkdir -p ${directory}`, { timeoutMs: 30_000 });
        if (created.exitCode !== 0) throw new Error("Cannot create runtime directory");
      } else await sandbox.mkdir(directory);
      for (const file of runtime) {
        await sandbox.writeFile(file.contents, `${directory}/${file.name}`);
      }
      await sandbox.writeFile(Buffer.from('{"type":"module"}'), `${directory}/package.json`);
      await sandbox.writeFile(
        Buffer.from(
          JSON.stringify({
            cwd,
            project: request.project,
            model: request.model,
            reasoningEffort: request.reasoningEffort,
            verifyLocally: request.verifyLocally,
            feedback: request.feedback,
          }),
        ),
        `${directory}/attempt.json`,
      );
      await begin("repository_clone");
      if (request.checkoutToken) {
        const token = await request.checkoutToken();
        registerDiagnosticSecret(token);
        const authDirectory = `${directory}-git-auth`;
        const created = await sandbox.exec(
          `mkdir -p -m 700 ${authDirectory} && chmod 700 ${authDirectory}`,
          { timeoutMs: 30_000 },
        );
        if (created.exitCode !== 0) throw new AttemptCommandError(created.exitCode, created.result);
        await sandbox.writeFile(
          Buffer.from(
            JSON.stringify({
              token,
              repoUrl: repo.href,
              cwd,
              branch: request.branch,
              commit: request.commit,
            }),
          ),
          `${authDirectory}/input.json`,
        );
        const command = `node ${directory}/repository-checkout.js ${authDirectory}/input.json`;
        const cloned = checkpoint
          ? await executeDurably(
              sandbox,
              `${directory}/checkout`,
              command,
              checkpoint.deadline,
              request.signal,
            )
          : await sandbox.exec(command, { timeoutMs: 5 * 60_000 });
        if (cloned.exitCode !== 0) throw new AttemptCommandError(cloned.exitCode, cloned.result);
        // A reconnect may have uploaded a fresh credential after checkout completed.
        // Remove it before making any attempt files accessible to the agent.
        const removed = await sandbox.exec(`rm -rf ${authDirectory}`, { timeoutMs: 30_000 });
        if (removed.exitCode !== 0) throw new AttemptCommandError(removed.exitCode, removed.result);
      } else if (checkpoint) {
        const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
        const cloned = await executeDurably(
          sandbox,
          `${directory}/checkout`,
          `git clone ${request.branch ? `--branch ${quote(request.branch)} ` : ""}-- ${quote(repo.href)} ${cwd}${request.commit ? ` && git -C ${cwd} checkout --detach ${quote(request.commit)}` : ""}`,
          checkpoint.deadline,
          request.signal,
        );
        if (cloned.exitCode !== 0) throw new AttemptCommandError(cloned.exitCode, cloned.result);
      } else await sandbox.clone(repo.href, cwd, request.branch, request.commit);
      await save({ phase: "prepared" });
    }
    if (!checkpoint || !["collected", "deleted"].includes(checkpoint.phase)) {
      await begin("model_execution");
      await emit(`Running project in sandbox ${sandbox.id}`);
      // Only the generated UUID path enters the shell. The project and repo URL never do.
      request.signal?.throwIfAborted();
      const commandText = `chown -R compat:compat ${directory} && runuser -u compat -- env HOME=/home/compat PATH=${environmentPath} node ${directory}/agent-runner.js`;
      await save({ phase: "running" });
      const observer = new AbortController();
      const observerSignal = request.signal
        ? AbortSignal.any([request.signal, observer.signal])
        : observer.signal;
      const execution = checkpoint
        ? executeDurably(sandbox, directory, commandText, checkpoint.deadline, observerSignal)
        : sandbox.exec(commandText, {
            cwd: directory,
            timeoutMs: (request.verifyLocally ? 32 : 22) * 60_000,
          });
      let finished = false;
      const command = execution
        .then((result) => {
          if (
            durable &&
            result.exitCode === 124 &&
            result.result === "Agent session deadline exceeded"
          )
            observer.abort(new AttemptCommandError(result.exitCode, result.result));
          return result;
        })
        .catch((error) => {
          if (durable) observer.abort(error);
          throw error;
        })
        .finally(() => {
          finished = true;
        });
      const transcript = request.onActivity
        ? (checkpoint && sandbox.streamCommand
            ? followAgentTranscript(
                sandbox.streamCommand.bind(sandbox),
                directory,
                (message, offset) => persist(() => request.onActivity!(message, offset)),
                observerSignal,
                checkpoint.transcriptOffset,
              )
            : streamAgentTranscript(
                async (offset) => {
                  request.signal?.throwIfAborted();
                  const response = await sandbox.exec(
                    `bash -o pipefail -c 'if [ -f ${directory}/transcript.jsonl ]; then dd if=${directory}/transcript.jsonl iflag=skip_bytes,count_bytes skip=${offset} count=65536 status=none | base64 -w0; fi'`,
                    { timeoutMs: 30_000 },
                  );
                  if (response.exitCode !== 0) throw new Error("Agent transcript read failed");
                  const bytes = Buffer.from(response.result, "base64");
                  if (bytes.toString("base64") !== response.result)
                    throw new Error("Invalid agent transcript encoding");
                  return bytes;
                },
                (message, offset) => persist(() => request.onActivity!(message, offset)),
                () => finished,
              )
          ).catch(async (error) => {
            if (request.signal?.aborted && !(request.signal.reason instanceof SessionDetached))
              throw error;
            if (durable) {
              const detached = new SessionDetached("Transcript observer disconnected", {
                cause: error,
              });
              observer.abort(detached);
              throw detached;
            }
            await removeSandbox();
            throw error;
          })
        : Promise.resolve();
      // Drain the transcript even if execution failed, before deleting the environment.
      const [outcome, recording] = await Promise.allSettled([command, transcript]);
      if (outcome.status === "rejected" && outcome.reason instanceof SessionDetached)
        throw outcome.reason;
      // A deadline deliberately interrupts the reader. Ordinary execution errors
      // must still preserve an environment whose transcript could not be drained.
      if (
        outcome.status === "fulfilled" &&
        outcome.value.exitCode === 124 &&
        outcome.value.result === "Agent session deadline exceeded"
      )
        throw new AttemptCommandError(outcome.value.exitCode, outcome.value.result);
      if (recording.status === "rejected") throw recording.reason;
      if (outcome.status === "rejected") throw outcome.reason;
      const result = outcome.value;
      if (result.exitCode !== 0) throw new AttemptCommandError(result.exitCode, result.result);
      if (result.result !== "herbie-attempt-completed\n")
        throw new AttemptResultError("Invalid project completion marker", result.result);
      await emit(`Project completed in sandbox ${sandbox.id}`);
      await begin("artifact_download");
      const artifactText = (
        await downloadBounded(sandbox, `${directory}/changes.json`, MAX_ARTIFACT_BYTES)
      ).toString("utf8");
      await save({ phase: "collected", artifact: artifactText });
      // Legacy callers do not persist checkpoints, but share artifact validation.
      legacyArtifact = artifactText;
    }
    const artifact: unknown = JSON.parse(checkpoint?.artifact ?? legacyArtifact!);
    if (
      typeof artifact !== "object" ||
      artifact === null ||
      !("baseCommit" in artifact) ||
      typeof artifact.baseCommit !== "string" ||
      !/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(artifact.baseCommit) ||
      !("patchBase64" in artifact) ||
      typeof artifact.patchBase64 !== "string"
    )
      throw new Error("Invalid repository changes artifact");
    if (artifact.patchBase64.length > Math.ceil(MAX_PATCH_BYTES / 3) * 4)
      throw new Error("Repository patch exceeds its byte limit");
    const patch = Buffer.from(artifact.patchBase64, "base64");
    if (patch.length > MAX_PATCH_BYTES) throw new Error("Repository patch exceeds its byte limit");
    if (patch.toString("base64") !== artifact.patchBase64)
      throw new Error("Invalid repository patch encoding");
    const publicationDecision =
      "publicationDecision" in artifact
        ? parsePublicationDecision(artifact.publicationDecision)
        : undefined;
    if (publicationDecision && (patch.length > 0 || request.feedback || request.verifyLocally))
      throw new Error(
        "Pause decision requires an unchanged repository in an implementation attempt",
      );
    if (
      !publicationDecision &&
      (!("pullRequestBody" in artifact) ||
        typeof artifact.pullRequestBody !== "string" ||
        !artifact.pullRequestBody.trim() ||
        artifact.pullRequestBody.length > 60_000)
    )
      throw new Error("Invalid pull request description");
    if (
      !publicationDecision &&
      (!("pullRequestTitle" in artifact) ||
        typeof artifact.pullRequestTitle !== "string" ||
        !artifact.pullRequestTitle.trim() ||
        artifact.pullRequestTitle.length > 256 ||
        /[\r\n]/.test(artifact.pullRequestTitle))
    )
      throw new Error("Invalid pull request title");
    const feedbackDecision = request.feedback
      ? parseFeedbackDecision(
          "feedbackDecision" in artifact ? artifact.feedbackDecision : undefined,
        )
      : undefined;
    if (feedbackDecision && (feedbackDecision.action === "update") !== patch.length > 0)
      throw new Error("Feedback decision does not match repository changes");
    if (
      request.verifyLocally &&
      (!feedbackDecision || feedbackDecision.action === "update") &&
      (!("localChecksPassed" in artifact) || artifact.localChecksPassed !== true)
    )
      throw new Error("Local verification did not pass");
    changes = {
      ...(feedbackDecision ? { feedbackDecision } : {}),
      ...(publicationDecision
        ? { publicationDecision }
        : {
            pullRequestTitle: (artifact as AgentAttemptArtifact).pullRequestTitle!.trim(),
            pullRequestBody: (artifact as AgentAttemptArtifact).pullRequestBody!,
          }),
      baseCommit: artifact.baseCommit,
      patch,
    };
    await emit(`Changes retrieved from sandbox ${sandbox.id}`);
  } catch (cause) {
    if (cause instanceof SessionDetached || request.signal?.reason instanceof SessionDetached) {
      detached = true;
      throw cause;
    }
    if (
      durable &&
      !request.signal?.aborted &&
      !["collected", "deleted"].includes(checkpoint?.phase ?? "") &&
      !(cause instanceof AttemptCommandError) &&
      !(cause instanceof AttemptResultError)
    ) {
      detached = true;
      throw new SessionDetached("Session observation will resume", { cause });
    }
    diagnostics.push(attemptDiagnostic(cause, stage));
    failures.push(new Error(`Attempt failed in sandbox ${sandbox.id}`, { cause }));
  } finally {
    request.signal?.removeEventListener("abort", abort);
    if (!detached) {
      // A failed event write must never prevent sandbox cleanup.
      try {
        await begin("sandbox_deletion");
      } catch (cause) {
        if (durable)
          cleanupPending = new SessionDetached("Session cleanup checkpoint pending", { cause });
        diagnostics.push(attemptDiagnostic(cause, "sandbox_deletion"));
        failures.push(new Error("Cleanup stage could not be persisted", { cause }));
      }
      try {
        if (!cleanupPending) {
          await removeSandbox();
          await save({ phase: "deleted" });
          await emit(`Deletion confirmed for sandbox ${sandbox.id}`);
        }
      } catch (cause) {
        if (durable)
          cleanupPending = new SessionDetached("Session cleanup checkpoint pending", { cause });
        diagnostics.push(attemptDiagnostic(cause, "sandbox_deletion"));
        failures.push(
          new Error(
            cleanupConfirmed
              ? "Deletion confirmation event could not be persisted"
              : `Deletion unconfirmed for sandbox ${sandbox.id}; check the environment provider before retrying`,
            { cause },
          ),
        );
      }
    }
  }
  request.signal?.removeEventListener("abort", abort);
  if (cleanupPending) throw cleanupPending;
  if (!failures.length && changes) {
    changes.verification = {
      ...(request.verifyLocally &&
      (!changes.feedbackDecision || changes.feedbackDecision.action === "update")
        ? { localChecksPassed: true as const }
        : {}),
      version: 3,
      repoUrl: repo.href,
      baseCommit: changes.baseCommit,
      patchSha256: createHash("sha256").update(changes.patch).digest("hex"),
      goalCompleted: true,
      sandboxDeleted: true,
    };
    return changes;
  }
  const error = new AgentAttemptError(failures, failures.map((error) => error.message).join("; "));
  error.changes = changes;
  error.diagnostics = diagnostics;
  error.cleanup = cleanupConfirmed ? "confirmed" : "unconfirmed";
  throw error;
}
