import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import pg from "pg";
import { Store } from "../src/store.js";
import { runWorkerOnce } from "../src/worker.js";
import { createDemoAdapters } from "../src/demo.js";
import { DaytonaRunError } from "@herbie/loop/daytona-run";

async function fixture(t: TestContext) {
  const connectionString = process.env.HERBIE_TEST_DATABASE_URL;
  if (!connectionString) {
    t.skip("Set HERBIE_TEST_DATABASE_URL");
    return;
  }
  const schema = "cancel_" + randomUUID().replaceAll("-", "");
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
    { repository: "demo/example", prompt: "Synthetic fixture" },
    "demo",
    randomUUID(),
  );
  return { store, project };
}
const changes = { baseCommit: "a".repeat(40), patch: Buffer.from("retained fixture") };

test("cancelled projects reject edits without changing their saved definition", async (t) => {
  const f = await fixture(t);
  if (!f) return;
  const { store, project } = f;
  const cancelled = await store.control(project.id, "owner", "cancel");
  const events = await store.events(project.id);
  for (const edit of [
    () => store.renameProject(project.id, "owner", "Changed name"),
    () => store.editProjectPrompt(project.id, "owner", "Changed prompt"),
    () =>
      store.updateProject(project.id, "owner", { name: "Changed", prompt: "Changed", maxWip: 2 }),
  ]) {
    await assert.rejects(edit(), /Cancelled projects cannot be edited/);
  }
  assert.deepEqual(await store.getProject(project.id, "owner"), cancelled);
  assert.deepEqual(await store.events(project.id), events);
});

test("stuck publication with undecodable App key cancels without invoking reconciliation and stays fenced", async (t) => {
  const f = await fixture(t);
  if (!f) return;
  const { store, project } = f;
  const run = await store.claim("publisher");
  assert.ok(run);
  await store.saveArtifact(run.id, "publisher", changes);
  await store.beginPublication(run.id, "publisher");
  await store.publicationUncertain(run.id, "publisher", "ERR_OSSL_UNSUPPORTED");
  const result = await store.control(project.id, "owner", "cancel");
  assert.equal(result.state, "cancelled");
  assert.equal(result.cleanupStatus, "needs_attention");
  assert.deepEqual(await store.control(project.id, "owner", "cancel"), result);
  const adapters = {
    ...createDemoAdapters(),
    async reconciliationRepository() {
      throw new Error("Must not decode App key");
    },
    async run() {
      throw new Error("Must not spend");
    },
  };
  assert.equal(await runWorkerOnce(store, adapters, "next"), false);
  await assert.rejects(
    store.queueSavedPublication(run.id, "owner", run.branch, changes.baseCommit),
    /no longer eligible/,
  );
  assert.equal((await store.events(project.id)).filter((e) => e.type === "cancel").length, 1);
  assert.ok(
    (await store.pool.query("SELECT artifact FROM project_runs WHERE id=$1", [run.id])).rows[0]
      .artifact,
  );
});

for (const cleanup of ["confirmed", "unconfirmed"] as const)
  test(
    "running run receives cancellation; cleanup " + cleanup + " never revives work",
    async (t) => {
      const f = await fixture(t);
      if (!f) return;
      const { store, project } = f;
      const entered = Promise.withResolvers<void>();
      let stopped = false,
        publishes = 0;
      const adapters = {
        ...createDemoAdapters(),
        async run(execution: Parameters<ReturnType<typeof createDemoAdapters>["run"]>[0]) {
          entered.resolve();
          await new Promise<void>((resolve) => {
            if (execution.signal?.aborted) resolve();
            else execution.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          stopped = true;
          const error = new DaytonaRunError([], "synthetic cancelled run");
          error.cleanup = cleanup;
          error.changes = changes;
          throw error;
        },
        async publish() {
          publishes++;
          throw new Error("Must not publish");
        },
      };
      const work = runWorkerOnce(store, adapters, "active", { leaseMs: 1000, heartbeatMs: 10 });
      await entered.promise;
      assert.equal((await store.control(project.id, "owner", "cancel")).cleanupStatus, "pending");
      await work;
      assert.equal(stopped, true);
      assert.equal(publishes, 0);
      const saved = await store.getProject(project.id);
      assert.equal(saved?.state, "cancelled");
      assert.equal(saved.cleanupStatus, cleanup === "confirmed" ? "complete" : "needs_attention");
      assert.equal(await runWorkerOnce(store, adapters, "next"), false);
      assert.ok(
        (
          await store.pool.query("SELECT artifact FROM project_runs WHERE project_id=$1", [
            project.id,
          ])
        ).rows[0].artifact,
      );
    },
  );

test("cancel fences a publisher already in flight and preserves its eventual PR as unresolved cleanup", async (t) => {
  const f = await fixture(t);
  if (!f) return;
  const { store, project } = f;
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let fence: (() => Promise<void>) | undefined;
  const adapters = {
    ...createDemoAdapters(),
    async run() {
      return changes;
    },
    async publish(
      execution: Parameters<ReturnType<typeof createDemoAdapters>["publish"]>[0],
      _changes: unknown,
      requireLease: () => Promise<void>,
    ) {
      await requireLease();
      fence = requireLease;
      entered.resolve();
      await release.promise;
      return { url: "https://github.com/example/repo/pull/1", number: 1, branch: execution.branch };
    },
  };
  const work = runWorkerOnce(store, adapters, "publisher");
  await entered.promise;
  await store.control(project.id, "owner", "cancel");
  await assert.rejects(fence!(), /lease/);
  release.resolve();
  await work;
  const saved = await store.getProject(project.id);
  assert.equal(saved?.state, "cancelled");
  assert.equal(saved.cleanupStatus, "needs_attention");
  assert.equal(saved.pullRequest?.number, 1);
  assert.equal(await store.claim("next"), null);
  assert.equal((await store.reviewRuns()).length, 1);
  const run = (
    await store.pool.query("SELECT id FROM project_runs WHERE project_id=$1", [project.id])
  ).rows[0];
  await store.reconcile(run.id, "merged");
  assert.equal((await store.getProject(project.id))?.state, "cancelled");
  assert.equal((await store.getProject(project.id))?.pullRequest?.state, "merged");
  assert.deepEqual(await store.reviewRuns(), []);
  assert.equal(
    (
      await store.pool.query("SELECT count(*)::int n FROM project_runs WHERE project_id=$1", [
        project.id,
      ])
    ).rows[0].n,
    1,
  );
});

test("late worker writes cannot overwrite cancellation and abandoned cleanup becomes visible", async (t) => {
  const f = await fixture(t);
  if (!f) return;
  const { store, project } = f;
  const run = await store.claim("lost");
  assert.ok(run);
  await store.control(project.id, "owner", "cancel");
  assert.equal(await store.heartbeat(run.id, "lost"), false);
  await assert.rejects(store.saveArtifact(run.id, "lost", changes), /lease/);
  await assert.rejects(store.fail(run.id, "lost", "failure"), /lease/);
  await assert.rejects(store.publicationUncertain(run.id, "lost", "failure"), /lease/);
  await store.pool.query(
    "UPDATE project_runs SET cancel_cleanup_deadline=clock_timestamp()-interval '1 second' WHERE id=$1",
    [run.id],
  );
  await store.recoverExpired();
  assert.equal((await store.getProject(project.id))?.cleanupStatus, "needs_attention");
  assert.equal(await store.finishCancelled(run.id, "unrelated", "complete"), false);
  assert.equal((await store.getProject(project.id))?.state, "cancelled");
});
