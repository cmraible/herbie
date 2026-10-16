import assert from "node:assert/strict";
import test from "node:test";
import { createLiveAdapters } from "../src/live.js";
import type { Github } from "../src/github.js";
import type { Execution } from "../src/adapters.js";

for (const result of ["absent", "pull_request_exists", "branch_exists"] as const)
  test("cancellation checks exact remote state with read-only credentials: " + result, async () => {
    const calls: string[] = [];
    const repository = "fixture-owner/fixture-project",
      branch = "herbie/exact-attempt";
    const access = { repository, defaultBranch: "main", installationId: 11 };
    const github = {
      async authorize(token: string, repo: string) {
        assert.equal(token, "fixture-user");
        assert.equal(repo, repository);
        return access;
      },
      async installationToken(id: number, repo: string, permission: string) {
        assert.equal(id, 11);
        assert.equal(repo, repository);
        assert.equal(permission, "read");
        calls.push("read-token");
        return "fixture-installation";
      },
      async findPullRequest(token: string, repo: string, head: string) {
        assert.equal(token, "fixture-installation");
        assert.equal(repo, repository);
        assert.equal(head, branch);
        calls.push("pr");
        return result === "pull_request_exists" ? {} : null;
      },
      async branchCommit(token: string, repo: string, head: string) {
        assert.equal(token, "fixture-installation");
        assert.equal(repo, repository);
        assert.equal(head, branch);
        calls.push("branch");
        return result === "branch_exists" ? "a".repeat(40) : null;
      },
    } as unknown as Github;
    const adapter = createLiveAdapters(undefined, github, {
      async userToken(id) {
        assert.equal(id, "7");
        return "fixture-user";
      },
    });
    const execution = {
      project: { ownerId: "7", repository },
      repository: access,
      attemptId: "fixture",
      branch,
    } as Execution;
    assert.equal(await adapter.checkUnpublished!(execution), result);
    assert.deepEqual(
      calls,
      result === "pull_request_exists" ? ["read-token", "pr"] : ["read-token", "pr", "branch"],
    );
  });
