import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { Store } from "../src/store.js";
import { createDemoAdapters } from "../src/demo.js";
import { runWorker } from "../src/worker.js";

test("coordinator fills WIP and replaces a merged PR while a sibling is running", async (t) => {
  const database = process.env.HERBIE_TEST_DATABASE_URL;
  if (!database) return t.skip("Requires local PostgreSQL");
  const schema = `wip_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: database });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const store = new Store(
    new Pool({ connectionString: database, options: `-c search_path=${schema}` }),
  );
  const stop = new AbortController();
  const releases = new Map<string, () => void>();
  let worker: Promise<void> | undefined;
  t.after(async () => {
    stop.abort();
    for (const release of releases.values()) release();
    await worker;
    await store.close();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  await store.migrate();
  const { project } = await store.createProject(
    "owner",
    { repository: "demo/example", prompt: "Keep working", targetWip: 2 },
    "demo",
    randomUUID(),
  );
  const adapters = createDemoAdapters();
  const attempt = adapters.attempt;
  adapters.attempt = async (...args) => {
    await new Promise<void>((resolve) => releases.set(args[0].attemptId, resolve));
    return attempt(...args);
  };
  const until = async (condition: () => Promise<boolean>) => {
    const deadline = Date.now() + 10_000;
    while (!(await condition())) {
      assert.ok(
        Date.now() < deadline,
        "coordinator must refill capacity before existing work finishes",
      );
      await delay(25);
    }
  };
  worker = runWorker(store, adapters, "coordinator", stop.signal);
  await until(async () => releases.size === 2);
  const owners = await store.pool.query(
    "SELECT lease_owner FROM jobs WHERE project_id=$1 AND stage='running'",
    [project.id],
  );
  assert.equal(
    new Set(owners.rows.map((row) => row.lease_owner)).size,
    2,
    "concurrent tasks must have distinct lease owners",
  );
  const [first, second] = [...releases.keys()];
  releases.get(first!)!();
  await until(async () => (await store.getProject(project.id))?.pullRequests.length === 1);
  await store.reconcile(first!, "merged");
  await until(async () => releases.size === 3);
  const current = await store.getProject(project.id);
  assert.equal(current?.attempts?.find((run) => run.id === second)?.state, "running");
  assert.equal(current?.attempts?.filter((run) => run.state === "running").length, 2);
  assert.equal(await store.claim("overflow"), null);
  await store.control(project.id, "owner", "pause");
  releases.get(second!)!();
  await until(
    async () =>
      (await store.getProject(project.id))?.attempts?.find((run) => run.id === second)?.state ===
      "ready",
  );
  assert.equal((await store.getProject(project.id))?.stopRequested, "pause");
  for (const release of releases.values()) release();
  await until(async () => (await store.getProject(project.id))?.state === "paused");
  assert.equal((await store.getProject(project.id))?.pullRequests.length, 1);
});
