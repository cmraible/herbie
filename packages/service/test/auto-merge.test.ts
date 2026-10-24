import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { projectSchema } from "@herbie/contracts";
import { createGithub } from "../src/github.js";
import { createDemoAdapters } from "../src/demo.js";
import { reconcileReviews } from "../src/worker.js";
import type { Store } from "../src/store.js";

const head = "a".repeat(40);
const oldHead = "b".repeat(40);

for (const scenario of [
  "approved",
  "merge_only",
  "rebase_only",
  "no_merge_method",
  "unapproved",
  "outdated",
  "changes_requested",
  "draft",
  "changed_head",
] as const) {
  test(`merge approved owner PR: ${scenario}`, async (t) => {
    let merges = 0;
    const expectedMethod =
      scenario === "merge_only" ? "merge" : scenario === "rebase_only" ? "rebase" : "squash";
    const shouldMerge = ["approved", "merge_only", "rebase_only"].includes(scenario);
    const server = createServer(async (req, res) => {
      let result: unknown;
      const path = req.url;
      if (path === "/repos/org/repo/pulls/1/merge") {
        assert.equal(req.method, "PUT");
        let body = "";
        for await (const chunk of req) body += chunk;
        assert.deepEqual(JSON.parse(body), { sha: head, merge_method: expectedMethod });
        merges++;
        result = { merged: true };
      } else if (path === "/repos/org/repo") {
        result = {
          allow_squash_merge: !["merge_only", "rebase_only", "no_merge_method"].includes(scenario),
          allow_merge_commit: scenario === "merge_only",
          allow_rebase_merge: scenario === "rebase_only",
        };
      } else if (path === "/repos/org/repo/pulls/1") {
        result = {
          number: 1,
          html_url: "https://github.com/org/repo/pull/1",
          state: "open",
          merged_at: null,
          draft: scenario === "draft",
          mergeable: true,
          merge_commit_sha: null,
          head: {
            ref: "herbie/run",
            sha: scenario === "changed_head" ? oldHead : head,
            repo: { full_name: "org/repo" },
          },
          base: { ref: "main", sha: oldHead },
        };
      } else if (path === "/repos/org/repo/pulls/1/reviews?per_page=100&page=1") {
        result =
          scenario === "unapproved"
            ? []
            : [
                {
                  user: { id: 7 },
                  state: "APPROVED",
                  commit_id: scenario === "outdated" ? oldHead : head,
                },
                ...(scenario === "changes_requested"
                  ? [{ user: { id: 7 }, state: "CHANGES_REQUESTED", commit_id: head }]
                  : []),
              ];
      } else if (path === `/repos/org/repo/commits/${head}/check-suites?per_page=100&page=1`) {
        result = { check_suites: [] };
      } else if (
        path === `/repos/org/repo/commits/${head}/check-runs?filter=latest&per_page=100&page=1`
      ) {
        result = { check_runs: [] };
      } else if (path === `/repos/org/repo/commits/${head}/status?per_page=100`) {
        result = {
          state: "success",
          total_count: 1,
          statuses: [{ context: "CI", state: "success", description: null, target_url: null }],
        };
      } else if (path === "/graphql") {
        result = { data: { repository: { ref: { branchProtectionRule: null } } } };
      } else if (path === "/repos/org/repo/rules/branches/main?per_page=100&page=1") {
        result = [];
      } else {
        res.statusCode = 404;
        result = {};
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(result));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const api = `http://127.0.0.1:${address.port}`;
    const github = createGithub(
      {
        appId: "1",
        clientId: "fixture",
        clientSecret: "fixture",
        privateKey: "unused",
        callbackUrl: "https://example.com/callback",
        webhookSecret: "fixture",
      },
      { api, oauth: api },
    );
    const merged = await github.mergeApproved("fixture", "org/repo", 1, "herbie/run", head, "7");
    assert.equal(merged, shouldMerge);
    assert.equal(merges, shouldMerge ? 1 : 0);
  });
}

test("review reconciliation merges a tracked PR only after readiness and an owner approval", async () => {
  const pr = {
    number: 1,
    url: "https://github.com/org/repo/pull/1",
    branch: "herbie/run",
    state: "open" as const,
    draft: false,
    headSha: head,
    checksPassed: true,
  };
  const project = projectSchema.parse({
    id: "00000000-0000-4000-8000-000000000001",
    ownerId: "7",
    repository: "org/repo",
    name: "Fix",
    prompt: "Fix",
    mode: "live",
    state: "awaiting_review",
    stopRequested: null,
    error: null,
    attemptCount: 1,
    createdAt: "2026-10-15",
    updatedAt: "2026-10-15",
    pullRequest: pr,
    pullRequests: [pr],
  });
  const job = {
    id: "job",
    branch: pr.branch,
    attemptId: "attempt",
    stage: "awaiting_review",
    project,
  };
  let allowed = false;
  let reconciled = false;
  const store = {
    reviewJobs: async () => [job],
    reconcilePullRequestHead: async () => false,
    reconcile: async (_id: string, outcome: string) => {
      assert.equal(outcome, "merged");
      reconciled = true;
    },
  } as unknown as Store;
  const adapters = {
    ...createDemoAdapters(),
    mode: "live" as const,
    reconciliationRepository: async () => ({
      repository: "org/repo",
      defaultBranch: "main",
      installationId: 1,
    }),
    reconcile: async () => pr,
    mergeApproved: async () => allowed,
  };
  await reconcileReviews(store, adapters);
  assert.equal(reconciled, false);
  allowed = true;
  await reconcileReviews(store, adapters);
  assert.equal(reconciled, true);
});
