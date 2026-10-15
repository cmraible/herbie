import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { Store } from "../src/store.js";
import { runWorkerOnce, reconcileReviews } from "../src/worker.js";
import { runCiRepairOnce } from "../src/ci-repair.js";
import { createDemoAdapters } from "../src/demo.js";
import { StaleRepairError, type Adapters } from "../src/adapters.js";

for (const outcome of [
  "success",
  "failure",
  "stale",
  "cancel",
  "lease",
  "crash",
  "queue",
  "late-stale",
  "audit-closed",
  "audit-pending",
  "rerun",
] as const) {
  test(`durable CI repair: ${outcome}`, async (t) => {
    const database = process.env.HERBIE_TEST_DATABASE_URL;
    if (!database) return t.skip("Set HERBIE_TEST_DATABASE_URL");
    const schema = `ci_${randomUUID().replaceAll("-", "")}`;
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
    const { goal } = await store.createGoal(
      "demo-user",
      { repository: "demo/example", prompt: "Fix arithmetic" },
      "demo",
      randomUUID(),
    );
    const demo = createDemoAdapters();
    await runWorkerOnce(store, demo, "original");
    await store.pool.query("UPDATE goals SET mode='live' WHERE id=$1", [goal.id]);
    const [job] = await store.reviewJobs("live");
    assert.ok(job);
    const pr = job.goal.pullRequests[0]!;
    if (outcome === "audit-closed" || outcome === "audit-pending") {
      await store.beginReadiness(job.id);
      if (outcome === "audit-closed") await store.reconcile(job.id, "closed");
      const adapters: Adapters = {
        ...demo,
        mode: "live",
        isReady: async () => true,
        ciStatus: async () => null,
        authorize: async () => {
          throw new Error("User authorization unavailable");
        },
      };
      await reconcileReviews(store, adapters);
      await reconcileReviews(store, adapters);
      assert.equal(
        (await store.pool.query("SELECT readiness_pending FROM jobs WHERE id=$1", [job.id])).rows[0]
          .readiness_pending,
        false,
      );
      assert.equal(
        (
          await store.pool.query(
            "SELECT 1 FROM goal_events WHERE goal_id=$1 AND type='pull_request_ready'",
            [goal.id],
          )
        ).rowCount,
        1,
      );
      return;
    }
    if (outcome === "queue") {
      for (let i = 0; i < 2; i++) {
        await store.createGoal(
          "demo-user",
          { repository: "demo/example", prompt: "Other goal" },
          "demo",
          randomUUID(),
        );
        await runWorkerOnce(store, demo, "original");
      }
      await store.pool.query("UPDATE goals SET mode='live'");
      await store.requestCiReview();
      await runCiRepairOnce(
        store,
        {
          ...demo,
          mode: "live",
          ciStatus: async () => null,
          authorize: async () => {
            throw new Error("Revoked login");
          },
        },
        "failed-read",
      );
      const second = await store.takeCiReview();
      assert.ok(
        second && second.id !== job.id,
        "failed read must not requeue the oldest job immediately",
      );
      await store.requestCiReview();
      const third = await store.takeCiReview();
      assert.ok(
        third && third.id !== job.id && third.id !== second.id,
        "global poll must not starve unreviewed PRs",
      );
      return;
    }
    if (outcome === "crash") {
      const claims = await Promise.all([
        store.startCiRepair(job.id, "a".repeat(40), "one"),
        store.startCiRepair(job.id, "a".repeat(40), "two"),
      ]);
      assert.equal(claims.filter(Boolean).length, 1);
      await store.pool.query(
        "UPDATE ci_repairs SET lease_expires_at=clock_timestamp()-interval '1 second'",
      );
      await store.recoverCiRepairs();
      assert.equal(await store.startCiRepair(job.id, "b".repeat(40), "replacement"), null);
      await store.finishCiRepair(claims.find(Boolean)!, "one", true, "stale completion");
      assert.equal(
        (await store.pool.query("SELECT state FROM ci_repairs")).rows[0].state,
        "failed",
      );
      return;
    }

    let attempts = 0,
      pushes = 0,
      reads = 0;
    let head = "a".repeat(40);
    let rerunning = outcome === "rerun";
    const adapters: Adapters = {
      ...demo,
      mode: "live",
      ciStatus: async () =>
        rerunning && attempts > 0
          ? null
          : {
              state: "failed",
              head: outcome === "stale" && ++reads > 1 ? "b".repeat(40) : head,
              pullRequest: pr,
              details: "test addition failed",
            },
      attempt: async (execution) => {
        attempts++;
        assert.equal(execution.ciRepair?.head, head);
        assert.equal(execution.branch, job.branch);
        if (outcome === "failure") throw new Error("Verification failed");
        if (outcome === "cancel") await store.control(goal.id, "demo-user", "cancel");
        if (outcome === "lease")
          await store.pool.query(
            "UPDATE ci_repairs SET lease_expires_at=clock_timestamp()-interval '1 second'",
          );
        const changes = await demo.attempt(execution, async () => {});
        return {
          ...changes,
          baseCommit: head,
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
        if (outcome === "late-stale") throw new StaleRepairError("PR head advanced before push");
        pushes++;
        return pr;
      },
    };
    await store.requestCiReview("unrelated/repo");
    assert.equal(await runCiRepairOnce(store, adapters, "repair"), false);
    await store.requestCiReview("demo/example");
    await runCiRepairOnce(store, adapters, "repair");
    assert.equal(attempts, 1);
    assert.equal(pushes, outcome === "success" ? 1 : 0);
    if (outcome !== "stale") {
      await store.requestCiReview();
      await runCiRepairOnce(store, adapters, "duplicate");
      assert.equal(attempts, 1);
    }
    assert.equal((await store.getGoal(goal.id))?.pullRequests.length, 1);
    if (outcome === "rerun") {
      assert.equal(
        (await store.pool.query("SELECT state FROM ci_repairs")).rows[0].state,
        "waiting",
      );
      rerunning = false;
      await store.requestCiReview();
      await runCiRepairOnce(store, adapters, "after-restart");
      assert.equal(attempts, 1, "resume saved verified artifact without another paid session");
      assert.equal(pushes, 1);
    }
    if (outcome === "late-stale") {
      head = "b".repeat(40);
      await store.requestCiReview();
      await runCiRepairOnce(store, adapters, "new-head");
      assert.equal(attempts, 2, "a definitive stale head must not disable future repairs");
    }

    if (outcome === "success") {
      for (const char of ["b", "c", "d"]) {
        head = char.repeat(40);
        await store.requestCiReview();
        await runCiRepairOnce(store, adapters, "next");
      }
      assert.equal(attempts, 3, "repair budget is per PR");
      assert.equal(pushes, 3);
      let ready = false;
      adapters.ciStatus = async () => ({ state: "passed", head, pullRequest: pr });
      adapters.markReady = async (_execution, expectedHead, beforeWrite) => {
        assert.equal(expectedHead, head);
        if (ready) return true;
        await beforeWrite();
        ready = true;
        return true;
      };
      await store.requestCiReview();
      const confirm = store.confirmReadiness.bind(store);
      let failedConfirmation = false;
      t.mock.method(store, "confirmReadiness", async (id: string, url: string) => {
        if (!failedConfirmation) {
          failedConfirmation = true;
          throw new Error("Database disconnected after GitHub mutation");
        }
        return confirm(id, url);
      });
      await runCiRepairOnce(store, adapters, "ready");
      assert.equal(
        (await store.pool.query("SELECT readiness_pending FROM jobs WHERE id=$1", [job.id])).rows[0]
          .readiness_pending,
        true,
      );

      await store.requestCiReview();
      await runCiRepairOnce(store, adapters, "ready-again");
      assert.equal(ready, true);
      assert.equal(attempts, 3, "marking ready does not launch another session");
      assert.equal(
        (
          await store.pool.query(
            "SELECT 1 FROM goal_events WHERE goal_id=$1 AND type='pull_request_ready'",
            [goal.id],
          )
        ).rowCount,
        1,
      );
      assert.equal(await store.ciReviewActive(job.id), true);
      await store.control(goal.id, "demo-user", "pause");
      assert.equal(await store.ciReviewActive(job.id), false);
    }
    const events = await store.pool.query<{ type: string }>(
      "SELECT type FROM goal_events WHERE goal_id=$1",
      [goal.id],
    );
    assert.ok(
      events.rows.some(
        (row) =>
          row.type ===
          (["success", "stale", "late-stale", "rerun"].includes(outcome)
            ? "ci_repair_completed"
            : "ci_repair_failed"),
      ),
    );
  });
}

test("CI repairs are unavailable when execution adapters are disabled", async () => {
  assert.equal(await runCiRepairOnce({} as Store, createDemoAdapters(), "worker"), false);
});
