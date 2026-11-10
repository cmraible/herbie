import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { artifactSchema, AttentionRequired, type Artifact } from "./artifact.js";
import type { PullRequest } from "./github.js";

const execute = promisify(execFile);

export type Publication = {
  repositoryId: number;
  repository: string;
  baseBranch: string;
  branch: string;
  createdAt: string;
  artifact: Artifact;
};

// No inherited Git configuration, credential helpers, hooks, or repository filters.
function gitEnvironment(token?: string, repository?: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: token ? "4" : "3",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "/dev/null",
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: "",
    GIT_CONFIG_KEY_2: "http.followRedirects",
    GIT_CONFIG_VALUE_2: "false",
    ...(token
      ? {
          GIT_CONFIG_KEY_3: `http.https://github.com/${repository}.git.extraHeader`,
          GIT_CONFIG_VALUE_3: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
        }
      : {}),
  };
}

async function git(cwd: string, args: string[], env = gitEnvironment()) {
  try {
    return (
      await execute("git", args, { cwd, env, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 })
    ).stdout.trim();
  } catch {
    // Child-process errors include argv/env/output. Never propagate credentials or repository output.
    throw new Error("Git operation failed");
  }
}

export async function prepareCommit(input: Publication, directory: string): Promise<string> {
  const artifact = artifactSchema.parse(input.artifact);
  if (artifact.repositoryId !== input.repositoryId || artifact.result.outcome !== "changes")
    throw new Error("Artifact does not match publication");
  if (Number.isNaN(Date.parse(input.createdAt))) throw new Error("Invalid commit date");
  await git(directory, ["checkout", "--detach", artifact.baseSha, "--"]);
  const patchPath = join(directory, "..", "changes.patch");
  await writeFile(patchPath, artifact.patch, { mode: 0o600 });
  await git(directory, ["apply", "--index", "--binary", "--", patchPath]);
  const paths = await git(directory, ["diff", "--cached", "--name-only", "-z"]);
  if (!paths) throw new Error("Artifact did not change the repository");
  if (paths.split("\0").some((path) => path.toLowerCase().startsWith(".github/workflows/")))
    throw new Error("Workflow-file changes are outside this MVP's GitHub permissions");
  const env = {
    ...gitEnvironment(),
    GIT_AUTHOR_NAME: "Prompt to PR",
    GIT_AUTHOR_EMAIL: "bot@prompt-to-pr.invalid",
    GIT_COMMITTER_NAME: "Prompt to PR",
    GIT_COMMITTER_EMAIL: "bot@prompt-to-pr.invalid",
    GIT_AUTHOR_DATE: input.createdAt,
    GIT_COMMITTER_DATE: input.createdAt,
  };
  await git(directory, ["-c", "commit.gpgsign=false", "commit", "-m", artifact.result.title], env);
  return git(directory, ["rev-parse", "HEAD"]);
}

export type PublicationRemote = {
  head(): Promise<string | null>;
  findPullRequest(): Promise<PullRequest | null>;
  push(): Promise<void>;
  openPullRequest(): Promise<PullRequest>;
};

// The caller owns exclusivity. Persist expected SHA and intent before any GitHub write.
export async function reconcilePublication(
  expectedSha: string,
  remote: PublicationRemote,
  assertOwnership: () => Promise<void>,
): Promise<PullRequest> {
  await assertOwnership();
  const existing = await remote.findPullRequest();
  if (existing) {
    if (existing.headSha !== expectedSha)
      throw new AttentionRequired(
        "pr_changed",
        "The run's PR head changed; inspect it before recovery",
      );
    return existing;
  }
  const head = await remote.head();
  if (head && head !== expectedSha)
    throw new AttentionRequired("branch_changed", "The run's branch has unexpected changes");
  if (!head) {
    await assertOwnership();
    try {
      await remote.push();
    } catch {
      if ((await remote.head()) !== expectedSha)
        throw new AttentionRequired(
          "push_uncertain",
          "Could not confirm the branch push; inspect GitHub before retrying",
        );
    }
  }
  await assertOwnership();
  try {
    const pr = await remote.openPullRequest();
    if (pr.headSha !== expectedSha)
      throw new AttentionRequired("pr_changed", "Published PR has an unexpected head");
    return pr;
  } catch (error) {
    if (error instanceof AttentionRequired) throw error;
    const found = await remote.findPullRequest();
    if (found?.headSha === expectedSha) return found;
    throw new AttentionRequired(
      "pr_uncertain",
      "Could not confirm PR creation; inspect GitHub before retrying",
    );
  }
}

export async function publish(
  input: Publication,
  token: string,
  github: {
    head(repository: string, branch: string, token: string): Promise<string | null>;
    findPullRequest(repository: string, branch: string, token: string): Promise<PullRequest | null>;
    openPullRequest(
      repository: string,
      branch: string,
      base: string,
      title: string,
      body: string,
      token: string,
    ): Promise<PullRequest>;
  },
  checkpoint: (sha: string) => Promise<void>,
  assertOwnership: () => Promise<void>,
) {
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(input.repository) ||
    !/^bot\/run-[0-9a-f-]{36}$/.test(input.branch)
  )
    throw new Error("Invalid publication target");
  const root = await mkdtemp(join(tmpdir(), "prompt-to-pr-"));
  const directory = join(root, "repo");
  const remote = `https://github.com/${input.repository}.git`;
  try {
    await git(
      root,
      ["clone", "--no-checkout", "--template=", "--", remote, directory],
      gitEnvironment(token, input.repository),
    );
    const sha = await prepareCommit(input, directory);
    await checkpoint(sha);
    const result = input.artifact.result;
    return await reconcilePublication(
      sha,
      {
        head: () => github.head(input.repository, input.branch, token),
        findPullRequest: () => github.findPullRequest(input.repository, input.branch, token),
        push: () =>
          git(
            directory,
            [
              "push",
              "--porcelain",
              `--force-with-lease=refs/heads/${input.branch}:`,
              "origin",
              `${sha}:refs/heads/${input.branch}`,
            ],
            gitEnvironment(token, input.repository),
          ).then(() => undefined),
        openPullRequest: () =>
          github.openPullRequest(
            input.repository,
            input.branch,
            input.baseBranch,
            result.title,
            `${result.summary}\n\n## Verification\n${result.verification}`,
            token,
          ),
      },
      assertOwnership,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
