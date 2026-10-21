import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { Store } from "../src/store.js";
import { createDemoAdapters } from "../src/demo.js";
import { runWorkerOnce } from "../src/worker.js";

for (const outcome of ["merged", "closed"] as const) {
  test(`single PR survives pause, resume, and ${outcome} without replenishing`, async (t) => {
    const database = process.env.HERBIE_TEST_DATABASE_URL;
    if (!database) return t.skip("Requires local PostgreSQL");
    const schema = `single_pr_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString: database });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const store = new Store(
      new Pool({ connectionString: database, options: `-c search_path=${schema}` }),
    );
    t.after(async () => {
      await store.close();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    });
    await store.migrate();
    const input = {
      repository: "demo/example",
      prompt: "Fix arithmetic",
      workflow: "single_pr" as const,
    };
    const key = randomUUID();
    const { project } = await store.createProject("owner", input, "demo", key);
    await store.migrate();
    assert.equal((await store.createProject("owner", input, "demo", key)).created, false);
    await assert.rejects(
      store.createProject("owner", { ...input, workflow: "loop" }, "demo", key),
      /different request/,
    );
    await assert.rejects(store.updateProject(project.id, "owner", { targetWip: 2 }), /targetWip/);
    await store.control(project.id, "owner", "pause");
    assert.equal(await store.claim("paused"), null);
    await store.control(project.id, "owner", "resume");
    const adapters = createDemoAdapters();
    assert.equal(await runWorkerOnce(store, adapters, "worker"), true);
    let current = (await store.getProject(project.id))!;
    assert.equal(current.state, "awaiting_review");
    assert.equal(current.pullRequests.length, 1);
    assert.equal(await store.claim("overflow"), null);
    await store.control(project.id, "owner", "pause");
    await store.control(project.id, "owner", "resume");
    await store.control(project.id, "owner", "pause");
    current = await store.reconcile(current.attempts![0]!.id, outcome);
    assert.equal(current.state, "completed");
    assert.equal(current.pullRequests[0]!.state, outcome);
    await store.reconcile(current.attempts![0]!.id, outcome);
    assert.equal(await runWorkerOnce(store, adapters, "after-close"), false);
    await assert.rejects(store.control(project.id, "owner", "resume"), /completed/);
    await assert.rejects(store.retryAttempt(project.id, "owner"), /retried/);
    assert.equal((await store.getProject(project.id))!.attempts!.length, 1);
  });
}

test("failed single PR runs require an explicit retry and can then publish once", async (t) => {
  const database = process.env.HERBIE_TEST_DATABASE_URL;
  if (!database) return t.skip("Requires local PostgreSQL");
  const schema = `single_retry_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: database });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const store = new Store(
    new Pool({ connectionString: database, options: `-c search_path=${schema}` }),
  );
  t.after(async () => {
    await store.close();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  await store.migrate();
  const { project } = await store.createProject(
    "owner",
    {
      repository: "demo/example",
      prompt: "[demo:fail] Fix arithmetic",
      workflow: "single_pr",
    },
    "demo",
    randomUUID(),
  );
  const adapters = createDemoAdapters();
  await runWorkerOnce(store, adapters, "failure");
  assert.equal((await store.getProject(project.id))!.state, "failed");
  assert.equal(await store.claim("automatic-retry"), null);
  await store.editProjectPrompt(project.id, "owner", "Fix arithmetic");
  assert.equal((await store.retryAttempt(project.id, "owner")).state, "queued");
  await runWorkerOnce(store, adapters, "retry");
  const current = (await store.getProject(project.id))!;
  assert.equal(current.pullRequests.length, 1);
  assert.equal(current.attempts!.length, 2);
  await store.reconcile(current.attempts![1]!.id, "merged");
  assert.equal(await store.claim("after-merge"), null);
});

test("single PR publication recovery reconciles the original PR without repeating work", async (t) => {
  const database = process.env.HERBIE_TEST_DATABASE_URL;
  if (!database) return t.skip("Requires local PostgreSQL");
  const schema = `single_recovery_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: database });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const store = new Store(
    new Pool({ connectionString: database, options: `-c search_path=${schema}` }),
  );
  t.after(async () => {
    await store.close();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  t.mock.method(console, "error", () => {});
  await store.migrate();
  const { project } = await store.createProject(
    "owner",
    {
      repository: "demo/example",
      prompt: "Fix the ticket",
      workflow: "single_pr",
    },
    "demo",
    randomUUID(),
  );
  const adapters = createDemoAdapters();
  let attempts = 0,
    publications = 0;
  let remote: Awaited<ReturnType<typeof adapters.publish>> | null = null;
  const attempt = adapters.attempt,
    publish = adapters.publish;
  adapters.attempt = async (...args) => {
    attempts++;
    return attempt(...args);
  };
  adapters.publish = async (...args) => {
    publications++;
    remote = await publish(...args);
    throw new Error("Connection lost after creating PR");
  };
  adapters.reconcile = async () => (remote ? { ...remote, state: "open" } : null);
  await runWorkerOnce(store, adapters, "initial");
  assert.equal((await store.getProject(project.id))!.state, "needs_attention");
  await store.pool.query("UPDATE jobs SET eligible_at=clock_timestamp() WHERE project_id=$1", [
    project.id,
  ]);
  assert.equal(await runWorkerOnce(store, adapters, "recovery"), true);
  const current = (await store.getProject(project.id))!;
  assert.equal(current.state, "awaiting_review");
  assert.equal(current.pullRequests.length, 1);
  assert.equal(current.attempts!.length, 1);
  assert.equal(attempts, 1);
  assert.equal(publications, 1);
  await store.reconcile(current.attempts![0]!.id, "merged");
  assert.equal(await store.claim("after-recovery"), null);
});
