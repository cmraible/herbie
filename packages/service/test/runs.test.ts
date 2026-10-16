import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { Store } from "../src/store.js";
import { createDemoAdapters } from "../src/demo.js";
import { runWorkerOnce } from "../src/worker.js";

test("runs retain their PRs and event attribution when an older PR merges", async (t) => {
  const connectionString = process.env.HERBIE_TEST_DATABASE_URL;
  if (!connectionString) return t.skip("Set HERBIE_TEST_DATABASE_URL");
  const schema = "runs_" + randomUUID().replaceAll("-", "");
  const admin = new pg.Pool({ connectionString });
  await admin.query("CREATE SCHEMA " + schema);
  const store = new Store(new pg.Pool({ connectionString, options: "-c search_path=" + schema }));
  await store.migrate();
  t.after(async () => {
    await store.close();
    await admin.query("DROP SCHEMA " + schema + " CASCADE");
    await admin.end();
  });
  const { project } = await store.createProject(
    "owner",
    { repository: "demo/example", prompt: "Two runs", maxWip: 2 },
    "demo",
    randomUUID(),
  );
  const adapters = createDemoAdapters();
  await runWorkerOnce(store, adapters, "worker");
  await runWorkerOnce(store, adapters, "worker");
  const runs = (await store.getProject(project.id))!.runs!;
  assert.equal(runs.length, 2);
  assert.deepEqual(
    runs.map((a) => a.number),
    [1, 2],
  );
  assert.ok(runs.every((a) => a.state === "awaiting_review" && a.pullRequest));
  await store.reconcile(runs[0]!.id, "merged");
  const updated = (await store.getProject(project.id))!.runs!;
  assert.equal(updated[0]!.pullRequest!.state, "merged");
  assert.equal(updated[1]!.pullRequest!.state, "open");
  const events = await store.events(project.id);
  assert.equal(events.find((e) => e.type === "pull_request_merged")!.runId, runs[0]!.id);
  for (const run of runs) {
    const own = events.filter((e) => e.runId === run.id);
    assert.ok(own.some((e) => e.type === "run_started"));
    assert.ok(own.some((e) => e.type === "run"));
    assert.ok(
      own.some((e) => e.type === "pull_request_opened" && e.message.includes(run.pullRequest!.url)),
    );
  }
});
