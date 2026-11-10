import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prepareCommit,
  reconcilePublication,
  type Publication,
  type PublicationRemote,
} from "../src/publication.js";
import { artifactSchema, AttentionRequired } from "../src/artifact.js";

const sha = "a".repeat(40);
const pr = { number: 1, url: "https://github.com/test/repo/pull/1", headSha: sha };

function remote(overrides: Partial<PublicationRemote> = {}) {
  const calls: string[] = [];
  return {
    calls,
    api: {
      head: async () => null,
      findPullRequest: async () => null,
      push: async () => {
        calls.push("push");
      },
      openPullRequest: async () => {
        calls.push("open");
        return pr;
      },
      ...overrides,
    } satisfies PublicationRemote,
  };
}

test("publication reuses an existing PR without any write", async () => {
  const { api, calls } = remote({ findPullRequest: async () => pr });
  assert.deepEqual(await reconcilePublication(sha, api, async () => {}), pr);
  assert.deepEqual(calls, []);
});

test("lost push acknowledgement is reconciled before creating PR", async () => {
  let pushed = false;
  const { api, calls } = remote({
    head: async () => (pushed ? sha : null),
    push: async () => {
      pushed = true;
      throw new Error("response lost");
    },
  });
  assert.deepEqual(await reconcilePublication(sha, api, async () => {}), pr);
  assert.deepEqual(calls, ["open"]);
});

test("lost PR acknowledgement returns the created PR without a second create", async () => {
  let opened = 0;
  const { api } = remote({
    head: async () => sha,
    findPullRequest: async () => (opened ? pr : null),
    openPullRequest: async () => {
      opened++;
      throw new Error("response lost");
    },
  });
  assert.deepEqual(await reconcilePublication(sha, api, async () => {}), pr);
  assert.equal(opened, 1);
});

test("unexpected branch prevents all writes", async () => {
  const { api, calls } = remote({ head: async () => "b".repeat(40) });
  await assert.rejects(
    reconcilePublication(sha, api, async () => {}),
    AttentionRequired,
  );
  assert.deepEqual(calls, []);
});

test("uncertain push never proceeds to PR creation", async () => {
  const { api, calls } = remote({
    push: async () => {
      throw new Error("timeout");
    },
  });
  await assert.rejects(
    reconcilePublication(sha, api, async () => {}),
    AttentionRequired,
  );
  assert.deepEqual(calls, []);
});

test("lost ownership prevents publication", async () => {
  const { api, calls } = remote();
  await assert.rejects(
    reconcilePublication(sha, api, async () => {
      throw new Error("lease lost");
    }),
  );
  assert.deepEqual(calls, []);
});

test("artifacts cannot mislabel changes as no-change", () => {
  assert.throws(() =>
    artifactSchema.parse({
      repositoryId: 1,
      baseSha: sha,
      patch: "some changes",
      result: { outcome: "no_changes", title: "", summary: "Nothing", verification: "None" },
    }),
  );
});

test("real Git publication creates deterministic commits including new files", async () => {
  const root = await mkdtemp(join(tmpdir(), "publication-test-"));
  const source = join(root, "source");
  const execute = promisify(execFile);
  const git = async (cwd: string, ...args: string[]) =>
    (
      await execute("git", args, {
        cwd,
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      })
    ).stdout.trim();
  try {
    await mkdir(source);
    await git(source, "init");
    await writeFile(join(source, "README.md"), "before\n");
    await git(source, "add", ".");
    await git(
      source,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "base",
    );
    const baseSha = await git(source, "rev-parse", "HEAD");
    await writeFile(join(source, "README.md"), "after\n");
    await writeFile(join(source, "new.txt"), "new file\n");
    await git(source, "add", ".");
    const patch = (await execute("git", ["diff", "--cached", "--binary"], { cwd: source })).stdout;
    const input: Publication = {
      repositoryId: 1,
      repository: "test/repo",
      baseBranch: "main",
      branch: "bot/run-00000000-0000-0000-0000-000000000001",
      createdAt: "2026-11-10T00:00:00.000Z",
      artifact: {
        repositoryId: 1,
        baseSha,
        patch,
        result: {
          outcome: "changes",
          title: "Update readme",
          summary: "Updates readme and adds a file",
          verification: "Checked files",
        },
      },
    };
    const first = join(root, "first");
    const second = join(root, "second");
    await git(root, "clone", "--no-checkout", source, first);
    await git(root, "clone", "--no-checkout", source, second);
    const commit = await prepareCommit(input, first);
    assert.equal(await prepareCommit(input, second), commit);
    assert.equal(await readFile(join(first, "new.txt"), "utf8"), "new file\n");
    assert.equal(await git(first, "rev-parse", "HEAD^"), baseSha);
    await assert.rejects(prepareCommit({ ...input, repositoryId: 2 }, second));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
