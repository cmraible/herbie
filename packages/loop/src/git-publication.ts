import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import type { PortableChangeArtifact } from "./portable-change-artifact.js";

export class GitPublicationHeadChangedError extends Error {}

export class GitPublicationTransportError extends AggregateError {
  constructor(errors: unknown[]) {
    super(errors, "Native Git publication failed");
  }
}

/** Native Git implementation of publication object construction and ref updates. */
export async function createAndPushGitPublication(request: {
  repository: string;
  branch: string;
  baseBranch: string;
  baseCommit: string;
  title: string;
  patch: Buffer;
  changeSet?: PortableChangeArtifact;
  expectedHead?: string;
  gitEnvironment?: Readonly<Record<string, string>>;
  beforeWrite?: () => Promise<void>;
  onCommit?: (commit: string) => void;
  onPhase?: (phase: "preparing" | "pushing") => Promise<void>;
}): Promise<{ commit: string }> {
  const directory = await mkdtemp(join(tmpdir(), "herbie-publish-"));
  const failures: unknown[] = [];
  let result: { commit: string } | undefined;
  try {
    const bare = join(directory, "repo.git");
    const git = async (...args: string[]) =>
      (
        await promisify(execFile)("git", ["--git-dir", bare, ...args], {
          cwd: directory,
          timeout: 30_000,
          killSignal: "SIGKILL",
          env: {
            ...process.env,
            ...request.gitEnvironment,
            GIT_INDEX_FILE: join(directory, "index"),
            GIT_TERMINAL_PROMPT: "0",
          },
        })
      ).stdout.trim();
    await git("init", "--bare", "--template=", bare);
    const headRef = `refs/heads/${request.branch}`;
    await git("check-ref-format", headRef);
    await git("check-ref-format", `refs/heads/${request.baseBranch}`);
    await request.onPhase?.("preparing");
    const remoteUrl = `https://github.com/${request.repository}.git`;
    await git("remote", "add", "origin", remoteUrl);
    const remoteHead = (await git("ls-remote", "--heads", "origin", headRef)).split("\t")[0];
    if (request.expectedHead && remoteHead !== request.expectedHead)
      throw new GitPublicationHeadChangedError("PR head changed");
    if (!request.expectedHead && remoteHead) throw new Error("Publication branch already exists");
    await git(
      "fetch",
      "--no-tags",
      "origin",
      request.expectedHead ? headRef : `refs/heads/${request.baseBranch}`,
    );
    // Keep the exact captured tree and parent even when other work advances main.
    await git("merge-base", "--is-ancestor", request.baseCommit, "FETCH_HEAD");
    await git("read-tree", request.baseCommit);
    if (request.changeSet) {
      for (const change of request.changeSet.changes) {
        const indexed = await git("ls-files", "--stage", "--", change.path);
        const entry = indexed.trim().match(/^(\d+) ([0-9a-f]+) 0\t/);
        if (
          change.expectedBase === null
            ? Boolean(entry)
            : !entry ||
              entry[1] !== change.expectedBase.mode ||
              entry[2] !== change.expectedBase.objectId
        )
          throw new Error(`Captured base entry changed for ${change.path}`);
        if (change.final === null) {
          if (entry) await git("update-index", "--force-remove", "--", change.path);
          continue;
        }
        const contentFile = join(directory, "content-" + Math.random().toString(16).slice(2));
        await writeFile(contentFile, Buffer.from(change.final.contentBase64, "base64"));
        const blob = await git("hash-object", "-w", contentFile);
        await git("update-index", "--add", "--cacheinfo", change.final.mode, blob, change.path);
      }
    } else {
      const patchFile = join(directory, "changes.patch");
      await writeFile(patchFile, request.patch);
      await git("apply", "--cached", "--binary", patchFile);
    }
    const tree = await git("write-tree");
    if (tree === (await git("rev-parse", `${request.baseCommit}^{tree}`)))
      throw new Error("Patch has no repository changes");
    const commit = await git("commit-tree", tree, "-p", request.baseCommit, "-m", request.title);
    request.onCommit?.(commit);
    await request.beforeWrite?.();
    await request.onPhase?.("pushing");
    // An empty expected value makes branch creation atomic: never replace an existing ref.
    const pushed = await git(
      "push",
      "--porcelain",
      `--force-with-lease=${headRef}:${request.expectedHead ?? ""}`,
      "origin",
      `${commit}:${headRef}`,
    );
    if (!pushed.split("\n").some((line) => line.startsWith(request.expectedHead ? " \t" : "*\t")))
      throw new Error("Push did not create a new branch");
    result = { commit };
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      const { rm } = await import("node:fs/promises");
      await rm(directory, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new GitPublicationTransportError(failures);
  return result!;
}
