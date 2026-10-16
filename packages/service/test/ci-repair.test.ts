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
  "external-change",
  "simple-rebase",
  "retry-at-capacity",
  "cancel",
  "lease",
  "crash",
  "queue",
  "late-stale",
  "audit-closed",
  "audit-pending",
  "audit-abandoned",
  "audit-cancelled",
  "rerun",
  "rerun-passed",
  "rerun-changed",
  "rerun-closed",
  "rerun-cancelled",
  "rerun-crash",
  "rerun-publishing-crash",
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
    if (outcome === "retry-at-capacity") {
      await store.pool.query("UPDATE goals SET state='failed',error='synthetic' WHERE id=$1", [
        goal.id,
      ]);
      await assert.rejects(
        store.retryAttempt(goal.id, "demo-user"),
        /Review or close an open pull request before retrying this project/,
      );
      assert.equal((await store.getGoal(goal.id))?.state, "failed");
      assert.equal(
        (
          await store.pool.query("SELECT 1 FROM goal_events WHERE goal_id=$1 AND type='retry'", [
            goal.id,
          ])
        ).rowCount,
        0,
      );
      return;
    }
    if (outcome === "external-change") {
      const originalHead = "a".repeat(40);
      const originalBase = "c".repeat(40);
      const originalPatch = "e".repeat(64);
      await store.pool.query(
        "UPDATE goals SET pull_request=jsonb_set(jsonb_set(jsonb_set(pull_request,'{headSha}',to_jsonb($2::text),true),'{baseSha}',to_jsonb($3::text),true),'{patchSha}',to_jsonb($4::text),true) WHERE id=$1",
        [goal.id, originalHead, originalBase, originalPatch],
      );
      await store.pool.query(
        "UPDATE jobs SET pull_request=jsonb_set(jsonb_set(jsonb_set(pull_request,'{headSha}',to_jsonb($2::text),true),'{baseSha}',to_jsonb($3::text),true),'{patchSha}',to_jsonb($4::text),true) WHERE id=$1",
        [job.id, originalHead, originalBase, originalPatch],
      );
      const adapters: Adapters = {
        ...demo,
        mode: "live",
        reconcile: async () => ({
          ...pr,
          state: "open",
          headSha: "b".repeat(40),
          baseSha: originalBase,
          patchSha: "f".repeat(64),
        }),
      };
      await reconcileReviews(store, adapters);
      await reconcileReviews(store, adapters);
      assert.equal((await store.getGoal(goal.id))?.state, "paused");
      assert.equal(
        (
          await store.pool.query(
            "SELECT 1 FROM goal_events WHERE goal_id=$1 AND type='external_change_paused'",
            [goal.id],
          )
        ).rowCount,
        1,
      );
      return;
    }
    if (outcome === "simple-rebase") {
      const originalHead = "a".repeat(40);
      const originalBase = "c".repeat(40);
      const originalPatch = "e".repeat(64);
      await store.pool.query(
        "UPDATE goals SET pull_request=jsonb_set(jsonb_set(jsonb_set(pull_request,'{headSha}',to_jsonb($2::text),true),'{baseSha}',to_jsonb($3::text),true),'{patchSha}',to_jsonb($4::text),true) WHERE id=$1",
        [goal.id, originalHead, originalBase, originalPatch],
      );
      await store.pool.query(
        "UPDATE jobs SET pull_request=jsonb_set(jsonb_set(jsonb_set(pull_request,'{headSha}',to_jsonb($2::text),true),'{baseSha}',to_jsonb($3::text),true),'{patchSha}',to_jsonb($4::text),true) WHERE id=$1",
        [job.id, originalHead, originalBase, originalPatch],
      );
      assert.equal(
        await store.reconcilePullRequestHead(job.id, {
          headSha: "b".repeat(40),
          baseSha: "d".repeat(40),
          patchSha: originalPatch,
        }),
        false,
      );
      assert.equal((await store.getGoal(goal.id))?.state, "awaiting_review");
      assert.equal((await store.getGoal(goal.id))?.pullRequests[0]?.headSha, "b".repeat(40));
      return;
    }
    if (outcome.startsWith("audit-")) {
      await store.beginReadiness(job.id);
      if (outcome === "audit-cancelled") await store.control(goal.id, "demo-user", "cancel");
      else if (outcome !== "audit-pending") await store.reconcile(job.id, "closed");
      const adapters: Adapters = {
        ...demo,
        mode: "live",
        readinessState: async () =>
          outcome === "audit-abandoned"
            ? "closed"
            : outcome === "audit-cancelled"
              ? "draft"
              : "ready",
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
        ["audit-abandoned", "audit-cancelled"].includes(outcome) ? 0 : 1,
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
    let rerunning = outcome.startsWith("rerun");
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
    if (outcome.startsWith("rerun-")) {
      if (outcome === "rerun-crash" || outcome === "rerun-publishing-crash") {
        const id = await store.startCiRepair(job.id, head, "interrupted");
        assert.ok(id);
        if (outcome === "rerun-publishing-crash") await store.beginCiPublication(id, "interrupted");
        await store.pool.query(
          "UPDATE ci_repairs SET lease_expires_at=clock_timestamp()-interval '1 second'",
        );
        await store.recoverCiRepairs();
        assert.equal(
          (await store.pool.query("SELECT state FROM ci_repairs")).rows[0].state,
          outcome === "rerun-crash" ? "waiting" : "failed",
        );
        rerunning = false;
        await store.requestCiReview();
        await runCiRepairOnce(store, adapters, "recovered");
        assert.equal(attempts, 1, "saved work never launches another session");
        assert.equal(
          pushes,
          outcome === "rerun-crash" ? 1 : 0,
          "only pre-publication crashes may resume",
        );
        return;
      }
      if (outcome === "rerun-cancelled") await store.control(goal.id, "demo-user", "cancel");
      else if (outcome === "rerun-closed") await store.reconcile(job.id, "closed");
      else {
        if (outcome === "rerun-passed")
          adapters.ciStatus = async () => ({
            state: "passed",
            draft: false,
            head,
            pullRequest: pr,
          });
        else {
          rerunning = false;
          head = "b".repeat(40);
        }
        await store.requestCiReview();
        await runCiRepairOnce(store, adapters, "discard");
      }
      const terminal = await store.pool.query(
        "SELECT message FROM goal_events WHERE goal_id=$1 AND type=$2",
        [goal.id, outcome === "rerun-changed" ? "external_change_paused" : "ci_repair_completed"],
      );
      if (outcome === "rerun-changed") {
        assert.equal(terminal.rowCount, 1);
        assert.equal((await store.getGoal(goal.id))?.state, "paused");
      } else assert.ok(terminal.rows.some((row) => row.message.includes("discarded")));
      assert.equal(
        (await store.pool.query("SELECT state FROM ci_repairs WHERE head=$1", ["a".repeat(40)]))
          .rows[0].state,
        "completed",
      );
      return;
    }
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
      assert.equal(attempts, 1, "external changes pause further repairs");
      assert.equal((await store.getGoal(goal.id))?.state, "paused");
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
      adapters.ciStatus = async () => ({ state: "passed", draft: true, head, pullRequest: pr });
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
      adapters.ciStatus = async () => ({ state: "passed", draft: false, head, pullRequest: pr });
      let redundantWrites = 0;
      adapters.markReady = async () => {
        redundantWrites++;
        throw new Error("Already-ready PR must not be revalidated");
      };
      await store.requestCiReview();
      await runCiRepairOnce(store, adapters, "already-ready");
      assert.equal(redundantWrites, 0);
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
          (["stale", "late-stale"].includes(outcome)
            ? "external_change_paused"
            : ["success", "rerun"].includes(outcome)
              ? "ci_repair_completed"
              : "ci_repair_failed"),
      ),
    );
  });
}

test("CI repairs are unavailable when execution adapters are disabled", async () => {
  assert.equal(await runCiRepairOnce({} as Store, createDemoAdapters(), "worker"), false);
});
