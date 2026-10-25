import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { projectSchema } from "@herbie/contracts";
import { createApiServer } from "../src/http.js";
import { createDemoAdapters } from "../src/demo.js";
import type { Store } from "../src/store.js";
import { testAuth } from "./test-auth.js";

async function until(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await delay(10);
  }
  assert.ok(predicate(), "webhook reconciliation did not finish");
}

for (const enabled of [true, false]) {
  test(`review and CI webhooks reconcile merges immediately (execution=${enabled})`, async (t) => {
    const pr = {
      number: 1,
      url: "https://github.com/org/repo/pull/1",
      branch: "herbie/run",
      state: "open" as const,
      draft: false,
      headSha: "a".repeat(40),
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
    let reads = 0;
    let merges = 0;
    let approved = false;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.after(release);
    const store = {
      requestCiReview: async () => {},
      requestFeedbackReview: async () => {},
      reviewJobs: async (
        _mode: unknown,
        _pending: unknown,
        repository: string,
        number?: number,
      ) => {
        assert.equal(repository, "org/repo");
        assert.ok(number === undefined || number === 1);
        return [job];
      },
      reconcilePullRequestHead: async () => false,
      reconcile: async (_id: string, state: string) => {
        assert.equal(state, "merged");
        merges++;
      },
    } as unknown as Store;
    const server = createApiServer({
      store,
      auth: testAuth(),
      publicUrl: "http://localhost:8787",
      executionEnabled: enabled,
      verifyWebhook: (_body, signature) => signature === "valid",
      adapters: {
        ...createDemoAdapters(),
        mode: "live",
        reconciliationRepository: async () => ({
          repository: "org/repo",
          defaultBranch: "main",
          installationId: 1,
        }),
        reconcile: async () => {
          reads++;
          await gate;
          return pr;
        },
        mergeApproved: async () => approved,
      },
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const send = (event: string, signature = "valid", repository = "org/repo") =>
      fetch(`http://127.0.0.1:${address.port}/api/webhooks/github`, {
        method: "POST",
        signal: AbortSignal.timeout(2000),
        headers: { "x-github-event": event, "x-hub-signature-256": signature },
        body: JSON.stringify({
          repository: { full_name: repository },
          review: { state: "approved" },
          pull_request: { number: 1 },
        }),
      });
    assert.equal((await send("pull_request_review", "forged")).status, 401);
    assert.equal((await send("pull_request_review", "valid", "invalid")).status, 200);
    assert.equal(reads, 0);
    // The response must finish even while authoritative GitHub reads are blocked.
    assert.equal((await send("pull_request_review")).status, 200);
    if (enabled) await until(() => reads === 1);
    for (const event of ["pull_request_review", "pull_request_review"]) {
      assert.equal((await send(event)).status, 200);
    }
    assert.equal(reads, enabled ? 1 : 0);
    release();
    if (enabled) await until(() => reads === 2);
    // Payload claims approval, but the authoritative adapter still rejects it.
    assert.equal(merges, 0);
    approved = true;
    for (const event of ["pull_request_review", "check_run", "check_suite", "status"]) {
      const before = merges;
      assert.equal((await send(event)).status, 200);
      if (enabled) await until(() => merges > before);
    }
    assert.equal(merges, enabled ? 4 : 0);
  });
}

for (const event of ["pull_request_review", "pull_request"]) {
  test(`${event} targets its PR without waiting for another PR`, async (t) => {
    const reads: number[] = [];
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.after(release);
    const server = createApiServer({
      store: {
        requestCiReview: async () => {},
        requestFeedbackReview: async () => {},
        reviewJobs: async (
          _mode: unknown,
          _pending: unknown,
          repository: string,
          number: number,
        ) => {
          assert.equal(repository, "org/repo");
          assert.ok(number === 1 || number === 2, "must not reconcile the whole repository");
          reads.push(number);
          if (number === 1) await gate;
          return [];
        },
      } as unknown as Store,
      auth: testAuth(),
      publicUrl: "http://localhost:8787",
      executionEnabled: true,
      verifyWebhook: () => true,
      adapters: { ...createDemoAdapters(), mode: "live" },
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const send = (number: unknown) =>
      fetch(`http://127.0.0.1:${address.port}/api/webhooks/github`, {
        method: "POST",
        signal: AbortSignal.timeout(2000),
        headers: { "x-github-event": event, "x-hub-signature-256": "valid" },
        body: JSON.stringify({ repository: { full_name: "org/repo" }, pull_request: { number } }),
      });
    for (const invalid of [undefined, 0, -1, "1", 1.5]) {
      assert.equal((await send(invalid)).status, 200);
    }
    assert.equal(reads.length, 0);
    assert.equal((await send(1)).status, 200);
    await until(() => reads.includes(1));
    assert.equal((await send(2)).status, 200);
    await until(() => reads.includes(2));
    assert.deepEqual(reads, [1, 2]);
    release();
  });
}
