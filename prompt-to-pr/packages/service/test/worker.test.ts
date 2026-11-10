import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { Store } from "../src/store.js";
import { executeRun } from "../src/worker.js";
import { GitHub } from "../src/github.js";
import { AttentionRequired } from "../src/artifact.js";
import type { createExecutor } from "../src/execution.js";

const repository = { id: 1, fullName: "owner/repo", defaultBranch: "main", installationId: 1 };
const artifact = {
  repositoryId: 1,
  baseSha: "a".repeat(40),
  patch: "",
  result: {
    outcome: "no_changes" as const,
    title: "",
    summary: "Already correct",
    verification: "Read the existing implementation",
  },
};

async function fixture(fn: (store: Store, github: GitHub) => Promise<void>) {
  assert.ok(process.env.TEST_DATABASE_URL);
  const schema = `worker_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    options: `-c search_path=${schema}`,
  });
  const github = new GitHub("test", "test");
  github.authorize = async () => repository;
  github.installationToken = async () => "fake-token";
  github.head = async () => artifact.baseSha;
  github.openPullRequest = async () => {
    throw new Error("Must not publish in this test");
  };
  try {
    const store = new Store(pool);
    await store.migrate();
    await fn(store, github);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}

for (const outcome of ["no_changes", "failed", "cleanup_uncertain", "launch_uncertain"] as const) {
  test(`worker records ${outcome} without restarting the agent`, () =>
    fixture(async (store, github) => {
      const run = await store.create(
        "alice",
        { repositoryId: 1, prompt: "Fix it" },
        randomUUID(),
        repository,
        1,
      );
      const worker = randomUUID();
      const claimed = (await store.claim(worker))!;
      let executions = 0;
      const execute: ReturnType<typeof createExecutor> = async (_input, _token, checkpoints) => {
        executions++;
        await checkpoints.stage("launching");
        if (outcome === "launch_uncertain")
          throw new AttentionRequired("launch_uncertain", "Launch outcome unknown");
        await checkpoints.sandbox("sandbox-123");
        await checkpoints.stage("coding");
        if (outcome === "cleanup_uncertain")
          throw new AttentionRequired("cleanup_uncertain", "Deletion outcome unknown");
        if (outcome === "failed") {
          await checkpoints.cleaned();
          throw new Error("Agent failed");
        }
        await checkpoints.artifact(artifact);
        await checkpoints.cleaned();
        return artifact;
      };
      await executeRun(
        store,
        claimed,
        worker,
        { userToken: async () => "user-token" },
        github,
        execute,
        "test",
      );
      const result = await store.get("alice", run.id);
      assert.equal(result.status, outcome.endsWith("uncertain") ? "needs_attention" : outcome);
      assert.equal(executions, 1);
      assert.equal(await store.claim(randomUUID()), null);
      assert.equal(result.pullRequest, null);
      if (outcome === "no_changes") assert.equal(result.summary, "Already correct");
      if (outcome.endsWith("uncertain")) assert.equal(result.error?.code, outcome);
    }));
}
