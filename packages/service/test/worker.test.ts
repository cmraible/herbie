import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { activityMessage } from "../../web/src/activity-message.js";
import { Store } from "../src/store.js";
import { createDemoAdapters } from "../src/demo.js";
import { runWorkerOnce } from "../src/worker.js";

// A real database and an explicitly simulated external executor: no sandbox/model spend.
test("worker completes queued work after the initiating client disconnects and does not duplicate publication", async (t) => {
  const database = process.env.HERBIE_TEST_DATABASE_URL;
  if (!database) return t.skip("Set HERBIE_TEST_DATABASE_URL for real PostgreSQL integration");
  const schema = `worker_${randomUUID().replaceAll("-", "")}`;
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
  const adapters = createDemoAdapters();
  await runWorkerOnce(store, adapters, "worker-one");
  const after = await store.getProject(project.id);
  assert.equal(after?.state, "awaiting_review");
  assert.ok(after?.pullRequest);
  await runWorkerOnce(store, adapters, "worker-two");
  assert.deepEqual((await store.getProject(project.id))?.pullRequest, after.pullRequest);
});

test("merged demo work keeps advancing until cancelled and a simulated failure stops", async (t) => {
  const database = process.env.HERBIE_TEST_DATABASE_URL;
  if (!database) return t.skip("Set HERBIE_TEST_DATABASE_URL for real PostgreSQL integration");
  const schema = `worker_${randomUUID().replaceAll("-", "")}`;
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
  const adapters = createDemoAdapters();
  await runWorkerOnce(store, adapters, "worker-one");
  const [job] = await store.reviewJobs();
  assert.ok(job);
  const first = (await store.getProject(project.id))?.pullRequest;
  assert.ok(first);
  await store.reconcile(job.id, "merged");
  await runWorkerOnce(store, adapters, "restarted-worker");
  const next = await store.getProject(project.id);
  assert.equal(next?.state, "awaiting_review");
  assert.equal(next.attemptCount, 2);
  assert.notEqual(next.pullRequest?.branch, first.branch);
  const [second] = await store.reviewJobs();
  assert.ok(second);
  await store.reconcile(second.id, "merged");
  assert.equal((await store.getProject(project.id))?.state, "queued");
  await runWorkerOnce(store, adapters, "worker-one");
  assert.equal((await store.getProject(project.id))?.attemptCount, 3);
  await store.control(project.id, "demo-user", "cancel");
  assert.equal(await runWorkerOnce(store, adapters, "worker-one"), false);
  const { project: failed } = await store.createProject(
    "demo-user",
    { repository: "demo/example", prompt: "[demo:fail]" },
    "demo",
    randomUUID(),
  );
  await runWorkerOnce(store, adapters, "worker-one");
  assert.equal((await store.getProject(failed.id))?.state, "failed");
  assert.equal((await store.getProject(failed.id))?.pullRequest, null);
});

test("worker persists a private redacted run diagnostic and a safe public reference without retry", async (t) => {
  const database = process.env.HERBIE_TEST_DATABASE_URL;
  if (!database) return t.skip("Set HERBIE_TEST_DATABASE_URL");
  const { DaytonaAttemptError } = await import("@herbie/loop/daytona-attempt");
  const schema = "diagnostic_" + randomUUID().replaceAll("-", "");
  const admin = new pg.Pool({ connectionString: database });
  await admin.query("CREATE SCHEMA " + schema);
  const store = new Store(
    new pg.Pool({ connectionString: database, options: "-c search_path=" + schema }),
  );
  t.after(async () => {
    await store.close();
    await admin.query("DROP SCHEMA " + schema + " CASCADE");
    await admin.end();
  });
  await store.migrate();
  const { project } = await store.createProject(
    "fixture-user",
    { repository: "demo/example", prompt: "Fixture" },
    "demo",
    randomUUID(),
  );
  const output: string[] = [];
  t.mock.method(console, "error", (line: string) => output.push(line));
  const error = new DaytonaAttemptError(
    [
      Object.assign(new Error("setup failed"), {
        stdout:
          "install progress\n".repeat(2000) +
          "herbie-runtime-failure step=node_installation exit=28",
        exitCode: 28,
        stderr: "useful synthetic failure\u0000details\ud800",
        authorization: "hidden-fixture-token",
      }),
    ],
    "wrapped failure",
  );
  error.diagnostics = [{ stage: "runtime_preparation", cause: "command_failed", exitCode: 28 }];
  error.cleanup = "confirmed";
  let attempts = 0;
  const adapters = {
    ...createDemoAdapters(),
    async attempt() {
      attempts++;
      throw error;
    },
  };
  await runWorkerOnce(store, adapters, "fixture-worker");
  const saved = await store.getProject(project.id);
  assert.equal(saved?.state, "needs_attention");
  assert.match(
    saved?.error ?? "",
    /^Run failed\. No patches were saved\. Reference: [0-9a-f-]{36}$/,
  );
  const record = JSON.parse(output.find((line) => line.includes("herbie_failure"))!);
  assert.ok(saved?.error?.includes(record.errorId));
  assert.equal(record.context.projectId, project.id);
  assert.match(JSON.stringify(record), /useful synthetic failure/);
  assert.ok(!JSON.stringify(record).includes("hidden-fixture-token"));
  const jobId = saved!.attempts![0].id;
  const diagnostic = (
    await store.pool.query("SELECT failure_diagnostic FROM jobs WHERE id=$1", [jobId])
  ).rows[0].failure_diagnostic;
  assert.equal(diagnostic.errorId, record.errorId);
  assert.equal(diagnostic.context.stage, "runtime_preparation");
  assert.match(JSON.stringify(diagnostic), /step=node_installation exit=28/);
  assert.match(JSON.stringify(diagnostic), /useful synthetic failure/);
  assert.ok(!JSON.stringify(diagnostic).includes("hidden-fixture-token"));
  assert.ok(!JSON.stringify(saved).includes("failure_diagnostic"));
  assert.ok(!JSON.stringify(await store.events(project.id)).includes("useful synthetic failure"));
  await store.migrate();
  assert.deepEqual(
    (await store.pool.query("SELECT failure_diagnostic FROM jobs WHERE id=$1", [jobId])).rows[0]
      .failure_diagnostic,
    diagnostic,
  );
  assert.ok(!saved?.error?.includes("runtime_preparation"));
  assert.ok(!saved?.error?.includes("useful synthetic failure"));
  assert.equal(await runWorkerOnce(store, adapters, "fixture-worker"), false);
  assert.equal(attempts, 1);
});

for (const workflow of ["loop", "single_pr"] as const)
  for (const recovered of [false, true])
    test(`${workflow} explicit no-PR result pauses ${recovered ? "a recovered artifact" : "a fresh attempt"} and can resume`, async (t) => {
      const database = process.env.HERBIE_TEST_DATABASE_URL;
      if (!database) return t.skip("Set HERBIE_TEST_DATABASE_URL");
      const schema = `pause_${randomUUID().replaceAll("-", "")}`;
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
        {
          repository: "demo/example",
          prompt: "Explain the environment",
          workflow,
        },
        "demo",
        randomUUID(),
      );
      const result = {
        baseCommit: "a".repeat(40),
        patch: Buffer.alloc(0),
        publicationDecision: {
          action: "pause" as const,
          reason: "Information delivered; no repository change is needed.",
        },
        verification: {
          version: 3 as const,
          repoUrl: "https://github.com/demo/example.git",
          baseCommit: "a".repeat(40),
          patchSha256: createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
          goalCompleted: true as const,
          sandboxDeleted: true as const,
        },
      };
      const adapters = createDemoAdapters();
      const attempt = t.mock.method(adapters, "attempt", async () => result);
      const publish = t.mock.method(adapters, "publish", async () => {
        throw new Error("Must not publish");
      });
      if (recovered) {
        const job = await store.claim("previous-worker");
        assert.ok(job);
        await assert.rejects(
          store.pauseWithoutPublication(job.id, "previous-worker", {
            ...result,
            verification: undefined,
          }),
          /Pause result does not match/,
        );
        await assert.rejects(
          store.pauseWithoutPublication(job.id, "previous-worker", {
            ...result,
            patch: Buffer.from("unexpected changes"),
          }),
          /explicit decision, no changes/,
        );
        await store.saveArtifact(job.id, "previous-worker", result);
        await store.pool.query(
          "UPDATE jobs SET lease_owner=NULL,lease_expires_at=NULL WHERE id=$1",
          [job.id],
        );
      }
      await runWorkerOnce(store, adapters, "pause-worker");
      const after = await store.getProject(project.id);
      assert.equal(after?.state, "paused");
      assert.equal(after?.error, null);
      assert.equal(after?.pullRequest, null);
      const pauseEvent = (await store.events(project.id)).find((e) => e.type === "agent_paused");
      assert.ok(pauseEvent && after);
      assert.equal(
        activityMessage(after, pauseEvent),
        `Agent paused without a pull request: ${result.publicationDecision.reason}`,
      );

      const rows = (
        await store.pool.query("SELECT stage,artifact FROM jobs WHERE project_id=$1", [project.id])
      ).rows;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].stage, "completed");
      assert.deepEqual(rows[0].artifact.publicationDecision, result.publicationDecision);
      assert.ok(
        (await store.events(project.id)).some(
          (e) => e.type === "agent_paused" && e.message === result.publicationDecision.reason,
        ),
      );
      assert.equal(await runWorkerOnce(store, adapters, "another-worker"), false);
      assert.equal(attempt.mock.callCount(), recovered ? 0 : 1);
      assert.equal(publish.mock.callCount(), 0);
      await store.control(project.id, "demo-user", "resume");
      const next = await store.claim("resumed-worker");
      assert.equal(next?.project.id, project.id);
      assert.equal(next?.stage, "running");
      assert.equal(next?.artifact, null);
      assert.equal(next?.project.attemptCount, 2);
    });

test("agent pause prevents more work while other active attempts settle", async (t) => {
  const database = process.env.HERBIE_TEST_DATABASE_URL;
  if (!database) return t.skip("Set HERBIE_TEST_DATABASE_URL");
  const schema = `pause_wip_${randomUUID().replaceAll("-", "")}`;
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
    {
      repository: "demo/example",
      prompt: "Inspect the environment",
      targetWip: 2,
    },
    "demo",
    randomUUID(),
  );
  const first = await store.claim("first");
  const second = await store.claim("second");
  assert.ok(first && second);
  const result = {
    baseCommit: "a".repeat(40),
    patch: Buffer.alloc(0),
    publicationDecision: { action: "pause" as const, reason: "No change is warranted" },
    verification: {
      version: 3 as const,
      repoUrl: "https://github.com/demo/example.git",
      baseCommit: "a".repeat(40),
      patchSha256: createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
      goalCompleted: true as const,
      sandboxDeleted: true as const,
    },
  };
  await store.pauseWithoutPublication(first.id, "first", result);
  assert.equal((await store.getProject(project.id))?.stopRequested, "pause");
  assert.equal(await store.claim("third"), null);
  await store.pauseWithoutPublication(second.id, "second", result);
  assert.equal((await store.getProject(project.id))?.state, "paused");
  assert.equal(await store.claim("fourth"), null);
});
