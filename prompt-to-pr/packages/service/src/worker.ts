import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { ApiError } from "@prompt-to-pr/contracts";
import { AttentionRequired } from "./artifact.js";
import { ExecutionError } from "./diagnostic.js";
import type { Identity } from "./auth.js";
import type { GitHub } from "./github.js";
import type { createExecutor } from "./execution.js";
import { publish } from "./publication.js";
import { Store, type StoredRun } from "./store.js";

export async function publishSaved(
  store: Store,
  run: StoredRun,
  workerId: string,
  identity: Pick<Identity, "userToken">,
  github: GitHub,
) {
  if (!run.artifact || !run.base_sha || !run.cleanup_complete)
    throw new Error("Saved publication requires confirmed cleanup and changes");
  const authorized = await github.authorize(
    await identity.userToken(run.owner_id),
    run.repository.id,
  );
  const token = await github.installationToken(authorized.installationId, authorized.id, true);
  const pr = await publish(
    {
      repositoryId: authorized.id,
      repository: authorized.fullName,
      baseBranch: run.repository.defaultBranch,
      branch: `bot/run-${run.id}`,
      createdAt: run.created_at.toISOString(),
      artifact: run.artifact,
    },
    token,
    github,
    async (sha) => {
      if (run.expected_sha && run.expected_sha !== sha)
        throw new AttentionRequired(
          "artifact_changed",
          "Saved publication no longer matches the expected commit",
        );
      await store.checkpoint(run.id, workerId, { expected_sha: sha });
    },
    () => store.heartbeat(run.id, workerId),
  );
  await store.checkpoint(
    run.id,
    workerId,
    {
      status: "succeeded",
      pull_request: { number: pr.number, url: pr.url },
      summary: run.artifact.result.summary,
    },
    "Draft PR created",
  );
}

export async function executeRun(
  store: Store,
  run: StoredRun,
  workerId: string,
  identity: Pick<Identity, "userToken">,
  github: GitHub,
  execute: ReturnType<typeof createExecutor>,
  model: string,
) {
  let lostLease = false;
  let launchStarted = false;
  let cleaned = false;
  let stage = "preparing";
  const heartbeat = setInterval(() => {
    void store.heartbeat(run.id, workerId).catch(() => {
      lostLease = true;
    });
  }, 15_000);
  const assertOwnership = async () => {
    if (lostLease) throw new Error("Run lease lost");
    await store.heartbeat(run.id, workerId);
  };
  const checkpoint = async (fields: Parameters<Store["checkpoint"]>[2], message?: string) => {
    await assertOwnership();
    return store.checkpoint(run.id, workerId, fields, message);
  };
  try {
    const repository = await github.authorize(
      await identity.userToken(run.owner_id),
      run.repository.id,
    );
    const checkoutToken = await github.installationToken(
      repository.installationId,
      repository.id,
      false,
    );
    const baseSha = await github.head(
      repository.fullName,
      run.repository.defaultBranch,
      checkoutToken,
    );
    if (!baseSha)
      throw new ApiError(
        409,
        "empty_repository",
        "The repository's default branch is missing or empty",
      );
    await checkpoint({ base_sha: baseSha });
    const artifact = await execute(
      {
        id: run.id,
        repositoryId: repository.id,
        repository: repository.fullName,
        baseSha,
        prompt: run.prompt,
        model,
      },
      checkoutToken,
      {
        stage: async (next) => {
          stage = next;
          await checkpoint({ stage }, next === "coding" ? "Agent is working" : `Run is ${next}`);
          if (next === "launching") launchStarted = true;
        },
        sandbox: async (id) => {
          await checkpoint({ sandbox_id: id });
        },
        artifact: async (artifact) => {
          stage = "cleanup";
          await checkpoint({ artifact, stage }, "Changes saved; cleaning up sandbox");
        },
        cleaned: async () => {
          cleaned = true;
          await checkpoint({ cleanup_complete: true }, "Sandbox deletion confirmed");
        },
      },
    );
    if (artifact.result.outcome === "no_changes") {
      await checkpoint(
        { status: "no_changes", summary: artifact.result.summary },
        "No changes needed",
      );
      return;
    }
    stage = "publishing";
    await checkpoint({ stage }, "Publishing draft PR");
    await assertOwnership();
    await publishSaved(
      store,
      { ...run, artifact, base_sha: baseSha, cleanup_complete: cleaned },
      workerId,
      identity,
      github,
    );
  } catch (error) {
    const attention =
      error instanceof AttentionRequired || (launchStarted && !cleaned) || stage === "publishing";
    const code =
      error instanceof AttentionRequired || error instanceof ApiError ? error.code : "run_failed";
    const message =
      error instanceof AttentionRequired || error instanceof ApiError
        ? error.message
        : `Run stopped during ${stage}; inspect diagnostics before retrying`;
    await checkpoint(
      {
        status: attention ? "needs_attention" : "failed",
        cleanup_complete: cleaned || !launchStarted,
        error: { code, message },
        ...(error instanceof ExecutionError
          ? { failure_diagnostic: { stage, ...error.diagnostic } }
          : {}),
      },
      message,
    ).catch(() => {});
    // Log only controlled fields; SDK errors can contain credentials.
    console.error(JSON.stringify({ runId: run.id, stage, code }));
  } finally {
    clearInterval(heartbeat);
  }
}

export async function work(
  store: Store,
  identity: Identity,
  github: GitHub,
  execute: ReturnType<typeof createExecutor>,
  model: string,
  signal: AbortSignal,
) {
  const workerId = randomUUID();
  while (!signal.aborted) {
    await store.markInterrupted();
    const run = await store.claim(workerId);
    if (run) await executeRun(store, run, workerId, identity, github, execute, model);
    else await delay(2000, undefined, { signal }).catch(() => {});
  }
}
