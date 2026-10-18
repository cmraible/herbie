import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { AgentAttemptError } from "@herbie/loop/agent-attempt";
import { runAgentSession } from "../src/agent-session.js";
import { projectSchema } from "@herbie/contracts";
import { Store } from "../src/store.js";
import { createDemoAdapters } from "../src/demo.js";
import { runWorkerOnce } from "../src/worker.js";

test("sessions retain execution telemetry and recover abandoned execution without changing historical activity", async (t) => {
  const database = process.env.HERBIE_TEST_DATABASE_URL;
  if (!database) return t.skip("Set HERBIE_TEST_DATABASE_URL");
  const schema = `sessions_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: database });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const store = new Store(
    new pg.Pool({ connectionString: database, options: `-c search_path=${schema}` }),
  );
  t.after(async () => {
    await store.close();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  await store.migrate();
  const { project } = await store.createProject(
    "demo-user",
    { repository: "demo/example", prompt: "Fix arithmetic" },
    "demo",
    randomUUID(),
  );
  const demo = createDemoAdapters();
  await runWorkerOnce(
    store,
    {
      ...demo,
      async authorize(userId, repository) {
        await store.updateProject(project.id, "demo-user", {
          model: "gpt-6-sol",
          reasoningEffort: "high",
        });
        return demo.authorize(userId, repository);
      },
      async attempt(execution, report) {
        assert.ok(execution.agentSessionId);
        await execution.onEnvironment?.({ provider: "e2b", id: "test-environment" });
        await execution.onActivity?.(
          JSON.stringify({
            method: "thread/tokenUsage/updated",
            params: {
              threadId: "test-thread",
              tokenUsage: { total: { inputTokens: 123, outputTokens: 45 } },
            },
          }),
        );
        return demo.attempt(execution, report);
      },
    },
    "worker",
  );
  const after = await store.getProject(project.id);
  const run = after!.attempts![0]!;
  const session = run.sessions![0]!;
  assert.equal(session.state, "completed");
  assert.equal(session.model, project.model);
  assert.equal(session.reasoningEffort, project.reasoningEffort);
  assert.equal(after?.model, "gpt-6-sol");
  assert.ok(session.finishedAt);
  assert.equal(session.threadId, "test-thread");
  assert.deepEqual(session.environment, { provider: "e2b", id: "test-environment" });
  assert.deepEqual(session.usage, { total: { inputTokens: 123, outputTokens: 45 } });
  await store.migrate();
  const legacy = await store.pool.query(
    "SELECT agent_session_id FROM project_events WHERE job_id=$1 AND type='queued'",
    [run.id],
  );
  assert.ok(legacy.rows.every((row) => row.agent_session_id === null));
  await runWorkerOnce(store, demo, "second-worker");
  assert.equal((await store.getProject(project.id))?.attempts?.[0]?.sessions?.length, 1);

  const second = await store.createProject(
    "demo-user",
    { repository: "demo/second", prompt: "Fix arithmetic" },
    "demo",
    randomUUID(),
  );
  const job = await store.claim("lost-worker", 30_000, "demo");
  assert.equal(job?.project.id, second.project.id);
  await assert.rejects(
    store.startAgentSession(job!.id, job!.id, "implementation", "wrong-worker", job!.project),
  );
  const interrupted = await store.startAgentSession(
    job!.id,
    job!.id,
    "implementation",
    "lost-worker",
    job!.project,
  );
  await store.pool.query(
    "UPDATE jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [job!.id],
  );
  await store.recoverAgentSessions();
  await store.finishAgentSession(interrupted, "completed", "confirmed");
  const recovered = (await store.getProject(second.project.id))!.attempts![0]!.sessions![0]!;
  assert.equal(recovered.state, "interrupted", "stale completion must not overwrite recovery");
  assert.equal(recovered.cleanup, "unconfirmed");
});

for (const successfulExecution of [false, true]) {
  test(`session persistence failure preserves patches and cleanup evidence (execution succeeded: ${successfulExecution})`, async () => {
    const project = projectSchema.parse({
      id: randomUUID(),
      ownerId: "test",
      repository: "demo/example",
      name: "Test",
      prompt: "Test",
      state: "running",
      mode: "demo",
      attemptCount: 1,
      createdAt: "now",
      updatedAt: "now",
      stopRequested: null,
      cleanupStatus: "pending",
      error: null,
      pullRequest: null,
    });
    const execution = {
      project,
      attemptId: randomUUID(),
      branch: "test",
      repository: { repository: project.repository, defaultBranch: "main", installationId: 1 },
    };
    const demo = createDemoAdapters();
    const changes = await demo.attempt(execution, async () => {});
    changes.verification = {
      version: 3,
      repoUrl: "https://github.com/demo/example.git",
      baseCommit: changes.baseCommit,
      patchSha256: "test",
      goalCompleted: true,
      sandboxDeleted: true,
    };
    const original = new AgentAttemptError([], "Execution failed after retrieving patches");
    original.changes = changes;
    original.cleanup = "confirmed";
    const store = {
      startAgentSession: async () => randomUUID(),
      finishAgentSession: async () => {
        throw new Error("Database unavailable");
      },
    } as unknown as Store;
    await assert.rejects(
      runAgentSession(
        store,
        {
          ...demo,
          attempt: async () => {
            if (!successfulExecution) throw original;
            return changes;
          },
        },
        execution,
        execution.attemptId,
        "worker",
        "implementation",
      ),
      (error: unknown) => {
        assert.ok(error instanceof AgentAttemptError);
        assert.equal(error.changes, changes);
        assert.equal(error.cleanup, "confirmed");
        if (!successfulExecution) assert.equal(error, original);
        return true;
      },
    );
  });
}
