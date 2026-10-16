import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { DaytonaAttemptError } from "@herbie/loop/daytona-attempt";
import { Store } from "../src/store.js";
import { runWorkerOnce } from "../src/worker.js";
import { runCiRepairOnce } from "../src/ci-repair.js";
import { createDemoAdapters } from "../src/demo.js";
import type { Adapters } from "../src/adapters.js";
import { createApiServer } from "../src/http.js";
import { testAuth, testSessionToken } from "./test-auth.js";

for (const scenario of [
  "retry",
  "status-failure",
  "cleanup-unknown",
  "publication",
  "paused",
  "closed",
  "changed-head",
  "legacy",
] as const) {
  test(`manual CI retry: ${scenario}`, async (t) => {
    const database = process.env.HERBIE_TEST_DATABASE_URL;
    if (!database) return t.skip("Set HERBIE_TEST_DATABASE_URL");
    const schema = `manual_ci_${randomUUID().replaceAll("-", "")}`;
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
    await runWorkerOnce(store, demo, "initial");
    await store.pool.query("UPDATE projects SET mode='live' WHERE id=$1", [project.id]);
    const [job] = await store.reviewJobs("live");
    const pr = job!.project.pullRequests[0]!;
    let attempts = 0;
    let pushes = 0;
    let statusFailed = false;
    let head = "a".repeat(40);
    const adapters: Adapters = {
      ...demo,
      mode: "live",
      ciStatus: async () => {
        if (scenario === "status-failure" && attempts === 1 && !statusFailed) {
          statusFailed = true;
          throw new Error("GitHub temporarily unavailable");
        }
        return {
          state: "failed",
          head,
          pullRequest: pr,
          details: "Formatting failed",
        };
      },
      attempt: async (execution, report) => {
        attempts++;
        if (attempts === 1 && scenario !== "status-failure") {
          await report("Attempt stage: repository_clone");
          if (scenario !== "cleanup-unknown")
            await report("Deletion confirmed for sandbox fixture");
          const error = new DaytonaAttemptError([new Error("Clone failed")]);
          error.cleanup = scenario === "cleanup-unknown" ? "unconfirmed" : "confirmed";
          throw error;
        }
        assert.equal(execution.ciRepair?.head, head);
        return {
          baseCommit: head,
          patch: Buffer.from("fixture"),
          verification: {
            version: 3,
            repoUrl: "https://github.com/demo/example.git",
            baseCommit: head,
            patchSha256: "fixture",
            goalCompleted: true,
            sandboxDeleted: true,
            localChecksPassed: true,
          },
        };
      },
      publish: async (_execution, _changes, requireLease) => {
        await requireLease();
        pushes++;
        return pr;
      },
    };
    await store.requestCiReview();
    await runCiRepairOnce(store, adapters, "repair");
    const repair = (await store.getProject(project.id))!.attempts![0]!.ciRepair!;
    assert.equal(repair.state, "failed");
    assert.equal(repair.canRetry, scenario !== "cleanup-unknown");
    await store.requestCiReview();
    await runCiRepairOnce(store, adapters, "automatic");
    assert.equal(attempts, 1, "failures must not automatically retry");
    await assert.rejects(
      store.retryCiRepair(project.id, "other-owner", repair.id),
      /Project not found/,
    );
    if (scenario === "publication")
      await store.pool.query("UPDATE ci_repairs SET publication_started=true WHERE id=$1", [
        repair.id,
      ]);
    if (scenario === "paused") await store.control(project.id, "demo-user", "pause");
    if (scenario === "closed") await store.reconcile(job!.id, "closed");
    if (["cleanup-unknown", "publication", "paused", "closed"].includes(scenario)) {
      await assert.rejects(store.retryCiRepair(project.id, "demo-user", repair.id));
      assert.equal((await store.pool.query("SELECT * FROM ci_repairs")).rowCount, 1);
      return;
    }
    if (scenario === "legacy") {
      await store.pool.query("UPDATE ci_repairs SET retryable=false WHERE id=$1", [repair.id]);
      await store.migrate();
      assert.equal((await store.getProject(project.id))!.attempts![0]!.ciRepair!.canRetry, true);
    }
    const server = createApiServer({
      store,
      adapters,
      auth: testAuth(),
      publicUrl: "http://localhost:8787",
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}/api/projects/${project.id}/retry-repair`;
    const headers = {
      "content-type": "application/json",
      authorization: `Bearer ${testSessionToken}`,
    };
    assert.equal(
      (
        await fetch(url, {
          method: "POST",
          headers: { origin: "http://localhost:8787" },
          body: JSON.stringify({ repairId: repair.id }),
        })
      ).status,
      401,
    );
    const responses = await Promise.all(
      [1, 2].map(() =>
        fetch(url, { method: "POST", headers, body: JSON.stringify({ repairId: repair.id }) }),
      ),
    );
    assert.deepEqual(
      responses.map((response) => response.status),
      [200, 200],
    );
    const rows = (await store.pool.query("SELECT * FROM ci_repairs ORDER BY created_at")).rows;
    assert.equal(rows.length, 2, "duplicate clicks queue only one retry");
    assert.equal(rows[0].state, "superseded");
    assert.equal(rows[1].retry_of, repair.id);
    assert.equal(rows[1].state, "waiting");
    assert.notEqual(rows[1].id, repair.id);
    await store.migrate(); // Restarts must preserve retry history and constraints.
    if (scenario === "changed-head") head = "b".repeat(40);
    await runCiRepairOnce(store, adapters, "manual");
    assert.equal(attempts, scenario === "changed-head" ? 1 : 2);
    assert.equal(pushes, scenario === "changed-head" ? 0 : 1);
    assert.ok((await store.events(project.id)).some((event) => event.type === "ci_repair_failed"));
    assert.ok(
      (await store.events(project.id)).some((event) => event.type === "ci_repair_retry_queued"),
    );
  });
}
