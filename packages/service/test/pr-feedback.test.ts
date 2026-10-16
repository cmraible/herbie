import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { Store } from "../src/store.js";
import { runWorkerOnce } from "../src/worker.js";
import { runFeedbackOnce } from "../src/pr-feedback.js";
import { createDemoAdapters } from "../src/demo.js";
import type { Adapters, PullRequestFeedback } from "../src/adapters.js";

for (const outcome of [
  "reply",
  "ignore",
  "update",
  "unverified",
  "cancel",
  "paused",
  "closed",
  "stale",
  "edited",
  "failure",
  "lease",
  "reply-failed",
  "crash",
  "ci-busy",
  "ci-failed",
  "dedup",
  "deleted",
  "bot",
] as const) {
  test(`durable PR feedback: ${outcome}`, async (t) => {
    const database = process.env.HERBIE_TEST_DATABASE_URL;
    if (!database) return t.skip("Set HERBIE_TEST_DATABASE_URL");
    const schema = `feedback_${randomUUID().replaceAll("-", "")}`;
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
    await runWorkerOnce(store, demo, "original");
    await store.pool.query("UPDATE projects SET mode='live' WHERE id=$1", [project.id]);
    const [job] = await store.reviewJobs("live");
    assert.ok(job);
    const pr = { ...job.project.pullRequests[0]!, headSha: "a".repeat(40) };
    const item: PullRequestFeedback = {
      kind: "inline",
      id: 1,
      revision: "v1",
      body: "Fix addition",
      author: "reviewer",
      url: `${pr.url}#discussion_r1`,
      replyTo: 1,
    };
    let context = [{ ...item, bot: outcome === "bot" }];
    let attempts = 0,
      pushes = 0,
      replies = 0;
    let current = pr;
    const action =
      outcome === "ignore"
        ? "ignore"
        : ["update", "unverified", "reply-failed"].includes(outcome)
          ? "update"
          : "reply";
    const adapters: Adapters = {
      ...demo,
      mode: "live",
      reconcile: async () => current,
      feedback: async () => context,
      attempt: async (execution) => {
        attempts++;
        await execution.onActivity?.(
          JSON.stringify({
            method: "item/agentMessage/delta",
            params: { delta: "Reviewing feedback" },
          }),
        );
        assert.equal(execution.feedback?.item.id, item.id);
        assert.equal(execution.branch, job.branch);
        if (outcome === "failure") throw new Error("Agent failed");
        if (outcome === "cancel") await store.control(project.id, "demo-user", "cancel");
        if (outcome === "lease")
          await store.pool.query(
            "UPDATE pr_feedback SET lease_expires_at=clock_timestamp()-interval '1 second'",
          );
        if (outcome === "stale") current = { ...pr, headSha: "b".repeat(40) };
        if (outcome === "edited")
          context = [{ ...item, revision: "v2", body: "Changed feedback", bot: false }];
        if (outcome === "deleted") context = [];
        const patch = action === "update" ? Buffer.from("patch") : Buffer.alloc(0);
        return {
          baseCommit: pr.headSha,
          patch,
          feedbackDecision:
            action === "ignore"
              ? { action, reason: "Already addressed" }
              : { action, reply: "Explanation" },
          verification: {
            version: 3,
            repoUrl: "https://github.com/demo/example.git",
            baseCommit: pr.headSha,
            patchSha256: createHash("sha256").update(patch).digest("hex"),
            goalCompleted: true,
            sandboxDeleted: true,
            ...(action === "update" && outcome !== "unverified"
              ? { localChecksPassed: true as const }
              : {}),
          },
        };
      },
      publish: async (_execution, _changes, lease) => {
        await lease();
        pushes++;
        current = { ...pr, headSha: "c".repeat(40) };
        assert.equal(await store.reconcilePullRequestHead(job.id, current), false);
        assert.equal((await store.getProject(project.id))?.state, "awaiting_review");
        return current;
      },
      replyToFeedback: async (_execution, _body, lease) => {
        await lease();
        if (outcome === "reply-failed") throw new Error("Ambiguous response");
        replies++;
      },
    };
    if (outcome === "crash" || outcome === "dedup") {
      const claims = await Promise.all([
        store.startFeedback(job.id, context, "one"),
        store.startFeedback(job.id, context, "two"),
      ]);
      assert.equal(claims.filter(Boolean).length, 1);
      assert.equal(await store.startCiRepair(job.id, pr.headSha, "ci"), null);
      if (outcome === "crash") {
        await store.pool.query(
          "UPDATE pr_feedback SET lease_expires_at=clock_timestamp()-interval '1 second'",
        );
        await store.recoverFeedback();
        assert.equal(await store.startFeedback(job.id, context, "three"), null);
        assert.equal(
          (await store.pool.query("SELECT state FROM pr_feedback")).rows[0].state,
          "failed",
        );
      }
      return;
    }
    if (outcome === "ci-failed") {
      const repair = await store.startCiRepair(job.id, pr.headSha, "ci");
      assert.ok(repair);
      await store.finishCiRepair(repair, "ci", false, "Unconfirmed cleanup");
    }
    if (outcome === "ci-busy") assert.ok(await store.startCiRepair(job.id, pr.headSha, "ci"));
    if (outcome === "paused") await store.control(project.id, "demo-user", "pause");
    if (outcome === "closed") current = { ...pr, state: "closed" };
    await store.requestFeedbackReview("other/repo");
    assert.equal(await runFeedbackOnce(store, adapters, "worker"), false);
    await store.requestFeedbackReview("demo/example");
    await runFeedbackOnce(store, adapters, "worker");
    assert.equal(
      attempts,
      ["ci-busy", "ci-failed", "paused", "closed", "bot"].includes(outcome) ? 0 : 1,
    );
    if (attempts)
      assert.ok(
        (
          await store.pool.query("SELECT 1 FROM project_events WHERE project_id=$1 AND type='agent'", [
            project.id,
          ])
        ).rowCount,
      );
    assert.equal(pushes, ["update", "reply-failed"].includes(outcome) ? 1 : 0);
    assert.equal(replies, ["reply", "update"].includes(outcome) ? 1 : 0);
    if (pushes)
      assert.equal((await store.getProject(project.id))?.pullRequests[0]?.headSha, current.headSha);
    if (outcome !== "edited") {
      await store.requestFeedbackReview();
      await runFeedbackOnce(store, adapters, "duplicate");
      assert.ok(
        attempts <= 1,
        "redelivery or restart must not repeat a completed or uncertain action",
      );
    } else {
      await store.requestFeedbackReview();
      await runFeedbackOnce(store, adapters, "edited");
      assert.equal(attempts, 2, "edited feedback receives a fresh decision");
      assert.equal(replies, 1);
    }
  });
}

test("feedback execution is disabled without live capabilities", async () => {
  assert.equal(await runFeedbackOnce({} as Store, createDemoAdapters(), "worker"), false);
});
