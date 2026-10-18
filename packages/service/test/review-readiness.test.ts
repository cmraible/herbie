import assert from "node:assert/strict";
import test from "node:test";
import { projectSchema } from "@herbie/contracts";
import { createLiveAdapters } from "../src/live.js";
import type { Github } from "../src/github.js";
import type { CiStatus, PullRequest } from "../src/adapters.js";

const head = "a".repeat(40);
for (const outcome of [
  "draft",
  "pending",
  "failed",
  "passed",
  "changed",
  "redrafted",
  "unavailable",
] as const) {
  test(`review readiness reconciliation: ${outcome}`, async () => {
    const pr: PullRequest = {
      number: 1,
      url: "https://github.com/owner/repo/pull/1",
      branch: "herbie/run",
      state: "open",
      draft: outcome === "draft",
      headSha: head,
      checksPassed: true,
    };
    const github = {
      installationToken: async () => "fixture",
      findPullRequest: async () => ({ ...pr }),
      ciStatus: async (): Promise<CiStatus | null> => {
        assert.notEqual(outcome, "draft", "draft PRs do not need a checks lookup");
        if (outcome === "unavailable") throw new Error("GitHub unavailable");
        if (outcome === "pending") return null;
        if (outcome === "failed")
          return { state: "failed", head, pullRequest: pr, details: "failed" };
        return {
          state: "passed",
          draft: outcome === "redrafted",
          head: outcome === "changed" ? "b".repeat(40) : head,
          pullRequest: pr,
        };
      },
    } as unknown as Github;
    const adapters = createLiveAdapters(undefined, github, { userToken: async () => "unused" });
    const project = projectSchema.parse({
      id: "00000000-0000-4000-8000-000000000001",
      ownerId: "owner",
      repository: "owner/repo",
      name: "Fix",
      prompt: "Fix",
      mode: "live",
      state: "awaiting_review",
      attemptCount: 1,
      createdAt: "2026-10-15",
      updatedAt: "2026-10-15",
      stopRequested: null,
      pullRequest: pr,
      pullRequests: [pr],
      error: null,
    });
    const current = await adapters.reconcile({
      project,
      branch: pr.branch,
      attemptId: project.id,
      repository: { repository: project.repository, installationId: 1, defaultBranch: "main" },
    });
    assert.equal(current?.checksPassed, outcome === "passed");
  });
}

test("a failed review request stays pending and reconciliation retries it before confirmation", async () => {
  const { runCiRepairOnce } = await import("../src/ci-repair.js");
  const { reconcileReviews } = await import("../src/worker.js");
  const { createDemoAdapters } = await import("../src/demo.js");
  const project = projectSchema.parse({
    id: "00000000-0000-4000-8000-000000000001",
    ownerId: "7",
    repository: "demo/example",
    name: "Fix",
    prompt: "Fix",
    mode: "live",
    state: "awaiting_review",
    attemptCount: 1,
    createdAt: "2026-10-15",
    updatedAt: "2026-10-15",
    stopRequested: null,
    pullRequest: null,
    error: null,
    pullRequests: [
      {
        number: 1,
        url: "https://github.com/demo/example/pull/1",
        branch: "herbie/run",
        state: "open",
      },
    ],
  });
  const pr = project.pullRequests[0]!;
  const job = { id: project.id, attemptId: project.id, project, branch: pr.branch };
  let pending = false;
  let ready = false;
  let requests = 0;
  let confirmations = 0;
  const store = {
    recoverCiRepairs: async () => {},
    recoverAgentSessions: async () => {},
    takeCiReview: async () => job,
    discardWaitingCi: async () => {},
    beginReadiness: async () => {
      pending = true;
    },
    confirmReadiness: async () => {
      assert.equal(requests, 2);
      pending = false;
      confirmations++;
    },
    reviewJobs: async (_mode: string, readiness: boolean) => (readiness && pending ? [job] : []),
  } as unknown as import("../src/store.js").Store;
  const adapters: import("../src/adapters.js").Adapters = {
    ...createDemoAdapters(),
    mode: "live",
    ciStatus: async () => ({ state: "passed", draft: true, head, pullRequest: pr }),
    markReady: async (_execution, _head, beforeWrite) => {
      await beforeWrite();
      ready = true;
      return true;
    },
    requestReview: async () => {
      assert.ok(ready);
      assert.ok(pending);
      requests++;
      if (requests === 1) throw new Error("Temporary review request failure");
    },
    readinessState: async () => "ready",
  };
  await runCiRepairOnce(store, adapters, "worker");
  assert.equal(pending, true);
  assert.equal(confirmations, 0);
  await reconcileReviews(store, adapters);
  assert.equal(pending, false);
  assert.equal(confirmations, 1);
  await reconcileReviews(store, adapters);
  assert.equal(requests, 2);
});
