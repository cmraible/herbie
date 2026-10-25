import { createHash } from "node:crypto";
import type { AgentAttemptChanges } from "./agent-attempt.js";
import { MAX_PATCH_BYTES } from "./artifact-limits.js";
import {
  createAndPushGitPublication,
  GitPublicationHeadChangedError,
  GitPublicationTransportError,
} from "./git-publication.js";

type CreatePullRequest = (request: {
  repository: string;
  base: string;
  head: string;
  title: string;
  body: string;
  draft: true;
}) => Promise<{ url: string }>;
type Request = {
  repository: string;
  baseBranch: string;
  branch: string;
  title: string;
  body: string;
  changes: AgentAttemptChanges;
  // Update an existing PR only while its head still matches the captured base.
  updatePullRequest?: { url: string; head: string };
  // Durable callers must confirm current lease ownership immediately before remote writes.
  beforeWrite?: () => Promise<void>;
  // Trusted caller-owned, per-process auth/identity. Never persist credentials in Git config.
  gitEnvironment?: Readonly<Record<string, string>>;
  onPhase?: (phase: PublicationState["stage"]) => Promise<void>;
};

export interface PublicationState {
  repository: string;
  branch: string;
  stage: "preparing" | "pushing" | "opening-pr" | "published";
  commit?: string;
  url?: string;
}

export class PatchHeadChangedError extends Error {}

export class PatchPublicationError extends AggregateError {
  constructor(
    errors: unknown[],
    readonly publication: PublicationState,
  ) {
    super(
      errors,
      `Patch publication failed during ${publication.stage} for ${publication.repository}:${publication.branch}; inspect remote state before retrying`,
    );
  }
}

export function hasValidPublicationEvidence(
  repository: string,
  changes: AgentAttemptChanges,
): boolean {
  const remoteUrl = `https://github.com/${repository}.git`;
  const { verification, baseCommit } = changes;
  const patch = Buffer.from(changes.patch);
  return (
    changes.patch.length <= MAX_PATCH_BYTES &&
    !!verification &&
    (verification.version === 2 || verification.version === 3) &&
    verification.goalCompleted === true &&
    verification.sandboxDeleted === true &&
    verification.baseCommit === baseCommit &&
    /^([0-9a-f]{40}|[0-9a-f]{64})$/.test(baseCommit) &&
    [remoteUrl, remoteUrl.slice(0, -4)].includes(verification.repoUrl) &&
    verification.patchSha256 === createHash("sha256").update(patch).digest("hex") &&
    (changes.changeSet === undefined ||
      verification.changeSetSha256 ===
        createHash("sha256").update(JSON.stringify(changes.changeSet)).digest("hex"))
  );
}

// Host-only: use existing Git authentication and a caller-owned GitHub API client.
// No checkout, repository scripts, dependency installation, or sandbox credentials.
export async function publishPatch(
  createPullRequest: CreatePullRequest,
  request: Request,
): Promise<{ url: string; branch: string; commit: string }> {
  const { repository, baseBranch, branch, title, body, changes } = request;
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(repository) ||
    !title.trim() ||
    !branch ||
    !baseBranch ||
    branch === baseBranch
  ) {
    throw new Error("Repository, distinct branch names, and a PR title are required");
  }
  if (changes.patch.length > MAX_PATCH_BYTES)
    throw new Error("Repository patch exceeds its byte limit");
  const patch = Buffer.from(changes.patch);
  const { baseCommit } = changes;
  if (!hasValidPublicationEvidence(repository, changes)) {
    throw new Error("Matching successful project and cleanup evidence is required for this patch");
  }
  if (
    request.updatePullRequest &&
    (request.updatePullRequest.head !== baseCommit || !changes.verification?.localChecksPassed)
  )
    throw new Error("PR updates require matching head and successful local checks");
  if (!patch.length) throw new Error("Cannot publish an empty patch");

  const state: PublicationState = { repository, branch, stage: "preparing" };
  const failures: unknown[] = [];
  let result: { url: string; branch: string; commit: string } | undefined;
  try {
    const update = request.updatePullRequest;
    const { commit } = await createAndPushGitPublication({
      repository,
      branch,
      baseBranch,
      baseCommit,
      title,
      patch,
      expectedHead: update?.head,
      gitEnvironment: request.gitEnvironment,
      beforeWrite: request.beforeWrite,
      onCommit: (commit) => {
        state.commit = commit;
      },
      onPhase: async (phase) => {
        state.stage = phase;
        await request.onPhase?.(phase);
      },
    });
    await request.beforeWrite?.();
    state.stage = "opening-pr";
    await request.onPhase?.("opening-pr");
    const { url } =
      update ??
      (await createPullRequest({
        repository,
        base: baseBranch,
        head: branch,
        title,
        body,
        draft: true,
      }));
    state.url = url;
    state.stage = "published";
    result = { url, branch, commit };
  } catch (error) {
    const transportErrors =
      error instanceof GitPublicationTransportError ? [...error.errors] : [error];
    // Only a definitive Git lease rejection is a discard; transport failures remain uncertain.
    const rejected =
      request.updatePullRequest &&
      state.stage === "pushing" &&
      transportErrors.some(
        (cause) =>
          cause instanceof Error &&
          "stdout" in cause &&
          typeof cause.stdout === "string" &&
          cause.stdout
            .split("\n")
            .some((line) => line.startsWith("!\t") && line.endsWith("[rejected] (stale info)")),
      );
    failures.push(
      ...transportErrors.map((cause) =>
        cause instanceof GitPublicationHeadChangedError ||
        (rejected && cause instanceof Error && "stdout" in cause)
          ? new PatchHeadChangedError("PR head changed")
          : cause,
      ),
    );
  }
  if (!failures.length && result) return result;
  throw new PatchPublicationError(failures, state);
}
