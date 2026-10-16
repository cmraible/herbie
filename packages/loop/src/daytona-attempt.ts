import { streamAgentTranscript } from "./agent-transcript.js";
export { parseFeedbackDecision } from "./feedback-decision.js";
import { parseFeedbackDecision, type FeedbackDecision } from "./feedback-decision.js";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Readable } from "node:stream";
import type {
  CreateSandboxFromImageParams,
  CreateSandboxFromSnapshotParams,
  Sandbox,
} from "@daytona/sdk";

import {
  AttemptCommandError,
  AttemptResultError,
  AttemptReportError,
  attemptDiagnostic,
  attemptDiagnosticMessage,
  type AttemptStage,
  type AttemptDiagnostic,
} from "./attempt-diagnostics.js";

import { installDaytonaRuntime, configureDaytonaRuntime, daytonaPath } from "./daytona-runtime.js";
import { MAX_ARTIFACT_BYTES, MAX_PATCH_BYTES } from "./artifact-limits.js";

export const DAYTONA_RUNTIME_FILES = [
  "codex-initialize.js",
  "codex-thread.js",
  "codex-turn.js",
  "codex-process.js",
  "daytona-runner.js",
  "feedback-decision.js",
  "diagnostic-log.js",
] as const;

export interface DaytonaAttemptArtifact {
  baseCommit: string;
  patchBase64: string;
  pullRequestTitle: string;
  pullRequestBody: string;
  feedbackDecision?: FeedbackDecision;
  localChecksPassed?: true;
}

type AttemptSandbox = Pick<Sandbox, "id" | "delete"> &
  Partial<Pick<Sandbox, "cpu" | "memory" | "disk">> & {
    git: Pick<Sandbox["git"], "clone">;
    fs: {
      createFolder: Sandbox["fs"]["createFolder"];
      uploadFile(file: Buffer, path: string, timeout: number): Promise<void>;
      downloadFileStream(
        path: string,
        options: { timeout: number; signal: AbortSignal },
      ): Promise<Readable>;
    };
    process: Pick<Sandbox["process"], "executeCommand">;
  };
type CreateSandbox = (
  params: CreateSandboxFromSnapshotParams | CreateSandboxFromImageParams,
  options: { timeout: number },
) => Promise<AttemptSandbox>;
type Request = Pick<CreateSandboxFromSnapshotParams, "secrets" | "outboundProxyUrl"> & {
  signal?: AbortSignal;
  snapshot?: string;
  resources?: { cpu: number; memory: number; disk: number };
  domainAllowList?: string;
  repoUrl: string;
  branch?: string;
  commit?: string;
  project: string;
  model?: string;
  reasoningEffort?: string;
  verifyLocally?: boolean;
  onActivity?: (message: string) => Promise<void>;
  feedback?: boolean;
};

export interface DaytonaAttemptChanges {
  baseCommit: string;
  patch: Buffer;
  feedbackDecision?: FeedbackDecision;
  // Optional only for artifacts saved before agent-authored descriptions.
  pullRequestBody?: string;
  // Optional only for artifacts saved before agent-authored titles.
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

export class DaytonaAttemptError extends AggregateError {
  // Keep retrieved changes available even if subsequent deletion fails.
  changes?: DaytonaAttemptChanges;
  diagnostics: AttemptDiagnostic[] = [];
  cleanup: "confirmed" | "unconfirmed" = "unconfirmed";
  safeMessage(): string {
    return `Attempt failed (${this.diagnostics.map(attemptDiagnosticMessage).join("; ") || "diagnostic unavailable"}). Sandbox deletion ${this.cleanup}. No automatic retry.`;
  }
}

async function downloadBounded(
  sandbox: AttemptSandbox,
  path: string,
  limit: number,
): Promise<Buffer> {
  const controller = new AbortController();
  const stream = await sandbox.fs.downloadFileStream(path, {
    timeout: 30,
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
// Secret values stay outside Herbie; secrets contains existing Daytona Secret names only.
export async function runDaytonaAttempt(
  create: CreateSandbox,
  request: Request,
  report: (message: string) => void | Promise<void>,
  runtimeDirectory = new URL(".", import.meta.url),
): Promise<DaytonaAttemptChanges> {
  if (request.snapshot && request.resources)
    throw new Error(
      "Custom resources require an image-based environment; snapshot resizing is unavailable.",
    );
  if (
    request.resources &&
    Object.values(request.resources).some((value) => !Number.isSafeInteger(value) || value < 1)
  )
    throw new Error("Environment resources must be positive whole numbers");
  let stage: AttemptStage = "sandbox_creation";
  const emit = async (message: string, sink = report): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(() => sink(message)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Attempt event persistence timed out")), 5000);
        }),
      ]);
    } catch (cause) {
      throw new AttemptReportError("Attempt event persistence failed", { cause });
    } finally {
      clearTimeout(timer);
    }
  };
  const begin = async (next: AttemptStage): Promise<void> => {
    if (next !== "sandbox_deletion") request.signal?.throwIfAborted();
    stage = next;
    await emit(`Attempt stage: ${stage}`);
    if (next !== "sandbox_deletion") request.signal?.throwIfAborted();
  };
  const repo = new URL(request.repoUrl);
  if (repo.protocol !== "https:" || repo.username || repo.password || repo.search || repo.hash) {
    throw new Error("Use a public HTTPS repository URL without credentials, query, or fragment");
  }
  if (
    (request.snapshot !== undefined && !request.snapshot.trim()) ||
    (request.domainAllowList !== undefined && !request.domainAllowList.trim()) ||
    !request.project.trim()
  ) {
    throw new Error("Project and any supplied snapshot or domain allowlist must not be empty");
  }
  const runtime = await Promise.all(
    DAYTONA_RUNTIME_FILES.map(async (name) => ({
      name,
      contents: await readFile(new URL(name, runtimeDirectory)),
    })),
  );
  const name = `herbie-attempt-${randomUUID()}`;
  const directory = `/tmp/${name}`;
  const cwd = `${directory}/repo`;
  await begin("sandbox_creation");
  await emit(`Creating sandbox ${name}`);
  let sandbox: AttemptSandbox;
  try {
    request.signal?.throwIfAborted();
    sandbox = await create(
      {
        name,
        ...(request.snapshot
          ? { snapshot: request.snapshot }
          : {
              image: "ubuntu:22.04",
              resources: request.resources ?? { cpu: 2, memory: 4, disk: 10 },
            }),
        ...(request.domainAllowList ? { domainAllowList: request.domainAllowList } : {}),
        secrets: request.secrets,
        outboundProxyUrl: request.outboundProxyUrl,
        ttlMinutes: request.verifyLocally ? 45 : 35,
      },
      { timeout: 120 },
    );
  } catch (cause) {
    const error = new DaytonaAttemptError(
      [cause],
      `Creation failed for ${name}; cleanup is unconfirmed. Check Daytona by name.`,
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
          await sandbox.delete(60, true);
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
    void removeSandbox().catch(() => undefined);
  };
  request.signal?.addEventListener("abort", abort, { once: true });
  if (request.signal?.aborted) abort();
  let changes: DaytonaAttemptChanges | undefined;
  try {
    request.signal?.throwIfAborted();
    await emit(`Created sandbox ${sandbox.id}`);
    if (request.resources) {
      for (const key of ["cpu", "memory", "disk"] as const) {
        if (sandbox[key] !== request.resources[key])
          throw new Error(
            `Daytona did not allocate the requested ${key}: expected ${request.resources[key]}, received ${sandbox[key]}`,
          );
      }
      await emit(
        `Environment resources: ${sandbox.cpu} CPUs, ${sandbox.memory} GiB memory, ${sandbox.disk} GiB disk`,
      );
    }
    await begin("runtime_preparation");
    const preflight = await sandbox.process.executeCommand(
      (request.snapshot ? "" : installDaytonaRuntime) + configureDaytonaRuntime,
      undefined,
      undefined,
      request.snapshot ? 60 : 300,
    );
    if (preflight.exitCode !== 0)
      throw new AttemptCommandError(preflight.exitCode, preflight.result);
    await begin("runtime_upload");
    await sandbox.fs.createFolder(directory, "700");
    for (const file of runtime) {
      await sandbox.fs.uploadFile(file.contents, `${directory}/${file.name}`, 30);
    }
    await sandbox.fs.uploadFile(Buffer.from('{"type":"module"}'), `${directory}/package.json`, 30);
    await sandbox.fs.uploadFile(
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
      30,
    );
    await begin("repository_clone");
    await sandbox.git.clone(repo.href, cwd, request.branch, request.commit);
    await begin("model_execution");
    await emit(`Running project in sandbox ${sandbox.id}`);
    // Only the generated UUID path enters the shell. The project and repo URL never do.
    request.signal?.throwIfAborted();
    const execution = sandbox.process.executeCommand(
      `chown -R compat:compat ${directory} && runuser -u compat -- env HOME=/home/compat PATH=${daytonaPath} node ${directory}/daytona-runner.js`,
      directory,
      undefined,
      (request.verifyLocally ? 32 : 22) * 60,
    );
    let finished = false;
    const command = execution.finally(() => {
      finished = true;
    });
    const transcript = request.onActivity
      ? streamAgentTranscript(
          async (offset) => {
            const response = await sandbox.process.executeCommand(
              `bash -o pipefail -c 'if [ -f ${directory}/transcript.jsonl ]; then dd if=${directory}/transcript.jsonl iflag=skip_bytes,count_bytes skip=${offset} count=65536 status=none | base64 -w0; fi'`,
              undefined,
              undefined,
              30,
            );
            if (response.exitCode !== 0) throw new Error("Agent transcript read failed");
            const bytes = Buffer.from(response.result, "base64");
            if (bytes.toString("base64") !== response.result)
              throw new Error("Invalid agent transcript encoding");
            return bytes;
          },
          (message) => emit(message, request.onActivity),
          () => finished,
        ).catch(async (error) => {
          await removeSandbox();
          throw error;
        })
      : Promise.resolve();
    // Drain the transcript even if execution failed, before deleting the environment.
    const [outcome, recording] = await Promise.allSettled([command, transcript]);
    if (recording.status === "rejected") throw recording.reason;
    if (outcome.status === "rejected") throw outcome.reason;
    const result = outcome.value;
    if (result.exitCode !== 0) throw new AttemptCommandError(result.exitCode, result.result);
    if (result.result !== "herbie-attempt-completed\n")
      throw new AttemptResultError("Invalid project completion marker", result.result);
    await emit(`Project completed in sandbox ${sandbox.id}`);
    await begin("artifact_download");
    const artifact: unknown = JSON.parse(
      (await downloadBounded(sandbox, `${directory}/changes.json`, MAX_ARTIFACT_BYTES)).toString(
        "utf8",
      ),
    );
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
    if (
      !("pullRequestBody" in artifact) ||
      typeof artifact.pullRequestBody !== "string" ||
      !artifact.pullRequestBody.trim() ||
      artifact.pullRequestBody.length > 60_000
    )
      throw new Error("Invalid pull request description");
    if (
      !("pullRequestTitle" in artifact) ||
      typeof artifact.pullRequestTitle !== "string" ||
      !artifact.pullRequestTitle.trim() ||
      artifact.pullRequestTitle.length > 256 ||
      /[\r\n]/.test(artifact.pullRequestTitle)
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
      pullRequestTitle: artifact.pullRequestTitle.trim(),
      baseCommit: artifact.baseCommit,
      patch,
      pullRequestBody: artifact.pullRequestBody,
    };
    await emit(`Changes retrieved from sandbox ${sandbox.id}`);
  } catch (cause) {
    diagnostics.push(attemptDiagnostic(cause, stage));
    failures.push(new Error(`Attempt failed in sandbox ${sandbox.id}`, { cause }));
  } finally {
    // A failed event write must never prevent sandbox cleanup.
    try {
      await begin("sandbox_deletion");
    } catch (cause) {
      diagnostics.push(attemptDiagnostic(cause, "sandbox_deletion"));
      failures.push(new Error("Cleanup stage could not be persisted", { cause }));
    }
    try {
      await removeSandbox();
      await emit(`Deletion confirmed for sandbox ${sandbox.id}`);
    } catch (cause) {
      diagnostics.push(attemptDiagnostic(cause, "sandbox_deletion"));
      failures.push(
        new Error(
          cleanupConfirmed
            ? "Deletion confirmation event could not be persisted"
            : `Deletion unconfirmed for sandbox ${sandbox.id}; check Daytona before retrying`,
          { cause },
        ),
      );
    }
  }
  request.signal?.removeEventListener("abort", abort);
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
  const error = new DaytonaAttemptError(
    failures,
    failures.map((error) => error.message).join("; "),
  );
  error.changes = changes;
  error.diagnostics = diagnostics;
  error.cleanup = cleanupConfirmed ? "confirmed" : "unconfirmed";
  throw error;
}
