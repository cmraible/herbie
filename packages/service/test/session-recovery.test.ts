import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { SessionDetached, AgentAttemptError } from "@herbie/loop/agent-attempt";
import { Store } from "../src/store.js";
import { createDemoAdapters } from "../src/demo.js";
import { runWorkerOnce } from "../src/worker.js";

for (const boundary of ["running", "completed", "cancelled"] as const) {
  test(`replacement resumes the same ${boundary} session without a second paid attempt`, async (t) => {
    const database = process.env.HERBIE_TEST_DATABASE_URL;
    if (!database) return t.skip("Set HERBIE_TEST_DATABASE_URL");
    const schema = `resume_${randomUUID().replaceAll("-", "")}`;
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
      { repository: "demo/example", prompt: "Continue through deployment" },
      "demo",
      randomUUID(),
    );
    const demo = createDemoAdapters();
    let calls = 0;
    let sessionId: string | undefined;
    const adapters = {
      ...demo,
      durableSessions: true,
      async attempt(
        execution: Parameters<typeof demo.attempt>[0],
        report: Parameters<typeof demo.attempt>[1],
      ) {
        calls++;
        assert.ok(execution.durable);
        if (!sessionId) sessionId = execution.agentSessionId;
        assert.equal(execution.agentSessionId, sessionId);
        if (!execution.signal?.aborted) await execution.onActivity?.('{"method":"test"}', 18);
        if (calls === 1) {
          await execution.durable.save({
            ...execution.durable.checkpoint,
            environmentId: "original-environment",
            phase: "running",
          });
          if (boundary === "completed") {
            const changes = await demo.attempt(execution, report);
            await store.finishAgentSession(sessionId!, "completed", "confirmed", changes);
          }
          throw new SessionDetached("Process disappeared");
        }
        assert.equal(execution.durable.checkpoint.environmentId, "original-environment");
        assert.equal(execution.durable.checkpoint.transcriptOffset, 18);
        if (boundary === "cancelled") {
          assert.equal(execution.signal?.aborted, true);
          const error = new AgentAttemptError([], "Cancelled");
          error.cleanup = "confirmed";
          throw error;
        }
        return demo.attempt(execution, report);
      },
    };
    await runWorkerOnce(store, adapters, "old");
    assert.equal((await store.getProject(project.id))?.state, "running");
    if (boundary === "cancelled") await store.control(project.id, "demo-user", "cancel");
    await store.releaseSessionObservers();
    await store.recoverExpired();
    await store.recoverAgentSessions();
    assert.equal(
      (await store.getProject(project.id))?.state,
      boundary === "cancelled" ? "cancelled" : "running",
    );
    const recovered = await store.claimSessionRecovery("new");
    assert.ok(recovered);
    await assert.rejects(
      store.checkpointAgentSession(sessionId!, "old", {
        version: 1,
        name: "herbie-attempt-old",
        phase: "running",
        deadline: Date.now(),
      }),
      /observer changed/,
    );
    await runWorkerOnce(store, adapters, "new", undefined, { recovered });
    const after = await store.getProject(project.id);
    assert.equal(after?.state, boundary === "cancelled" ? "cancelled" : "awaiting_review");
    if (boundary === "cancelled") assert.equal(after?.cleanupStatus, "complete");
    assert.equal(after?.attemptCount, 1);
    assert.equal(after?.attempts?.[0]?.sessions?.length, 1);
    assert.equal(
      after?.attempts?.[0]?.sessions?.[0]?.state,
      boundary === "cancelled" ? "cancelled" : "completed",
    );
    assert.equal(calls, boundary === "completed" ? 1 : 2);
    assert.equal(
      (await store.events(project.id)).filter((event) => event.type === "agent").length,
      1,
    );
    assert.equal(await store.claimSessionRecovery("other"), null);
  });
}

for (const kind of ["ci_repair", "pr_feedback"] as const) {
  test(`replacement resumes ${kind} with original input and no duplicate agent session`, async (t) => {
    const database = process.env.HERBIE_TEST_DATABASE_URL;
    if (!database) return t.skip("Set HERBIE_TEST_DATABASE_URL");
    const schema = `resume_${randomUUID().replaceAll("-", "")}`;
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
      { repository: "demo/example", prompt: "Original prompt" },
      "demo",
      randomUUID(),
    );
    const demo = createDemoAdapters();
    await runWorkerOnce(store, demo, "initial");
    await store.pool.query("UPDATE projects SET mode='live' WHERE id=$1", [project.id]);
    const [job] = await store.reviewJobs("live");
    const pr = { ...job!.project.pullRequests[0]!, headSha: "a".repeat(40) };
    const item = {
      kind: "comment" as const,
      id: 1,
      revision: "v1",
      author: "reviewer",
      body: "Original feedback",
      url: pr.url,
    };
    let calls = 0;
    let session: string | undefined;
    let publications = 0;
    const patch = Buffer.from("patch");
    const { createHash } = await import("node:crypto");
    const adapters = {
      ...demo,
      mode: "live" as const,
      durableSessions: true,
      reconcile: async () => pr,
      ciStatus: async () => ({
        state: "failed" as const,
        head: pr.headSha,
        pullRequest: pr,
        details: "Original failure",
      }),
      feedback: async () => [item],
      replyToFeedback: async () => {
        publications++;
      },
      publish: async () => {
        publications++;
        return { ...pr, headSha: "b".repeat(40) };
      },
      async attempt(execution: Parameters<typeof demo.attempt>[0]) {
        calls++;
        if (!session) session = execution.agentSessionId;
        assert.equal(execution.agentSessionId, session);
        assert.equal(execution.project.prompt, "Original prompt");
        if (calls === 1) {
          await execution.durable!.save({
            ...execution.durable!.checkpoint,
            environmentId: "original",
            phase: "running",
          });
          throw new SessionDetached("Deployment");
        }
        assert.equal(execution.durable?.checkpoint.environmentId, "original");
        assert.equal(
          kind === "ci_repair" ? execution.ciRepair?.details : execution.feedback?.item.body,
          kind === "ci_repair" ? "Original failure" : "Original feedback",
        );
        return {
          baseCommit: pr.headSha,
          patch,
          ...(kind === "pr_feedback"
            ? { feedbackDecision: { action: "update" as const, reply: "Fixed" } }
            : {}),
          verification: {
            version: 3 as const,
            repoUrl: "https://github.com/demo/example.git",
            baseCommit: pr.headSha,
            patchSha256: createHash("sha256").update(patch).digest("hex"),
            goalCompleted: true as const,
            sandboxDeleted: true as const,
            localChecksPassed: true as const,
          },
        };
      },
    };
    const { runCiRepairOnce } = await import("../src/ci-repair.js");
    const { runFeedbackOnce } = await import("../src/pr-feedback.js");
    const run = kind === "ci_repair" ? runCiRepairOnce : runFeedbackOnce;
    if (kind === "ci_repair") await store.requestCiReview();
    else await store.requestFeedbackReview();
    await run(store, adapters, "old");
    await store.releaseSessionObservers();
    await store.recoverCiRepairs();
    await store.recoverFeedback();
    await store.recoverAgentSessions();
    const recovered = await store.claimSessionRecovery("new");
    assert.equal(recovered?.kind, kind);
    assert.ok(recovered);
    await run(store, adapters, "new", { recovered });
    assert.equal(calls, 2);
    assert.equal(publications, kind === "ci_repair" ? 1 : 2);
    assert.equal(
      (await store.getProject(project.id))?.attempts?.[0]?.sessions?.filter((s) => s.kind === kind)
        .length,
      1,
    );
    assert.equal(await store.claimSessionRecovery("next"), null);
  });
}
