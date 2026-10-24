import assert from "node:assert/strict";
import test from "node:test";
import { createApiServer } from "../src/http.js";
import { createDemoAdapters } from "../src/demo.js";
import type { Store } from "../src/store.js";
import { testAuth } from "./test-auth.js";

for (const enabled of [true, false]) {
  test(`feedback webhooks require signatures and PR context (execution=${enabled})`, async (t) => {
    const repositories: string[] = [];
    const store = {
      reviewJobs: async () => [],
      requestFeedbackReview: async (repository: string) => {
        repositories.push(repository);
      },
    } as unknown as Store;
    const server = createApiServer({
      store,
      auth: testAuth(),
      adapters: { ...createDemoAdapters(), mode: "live" },
      publicUrl: "http://localhost:8787",
      executionEnabled: enabled,
      verifyWebhook: (_body, signature) => signature === "valid",
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const send = (event: string, pr = true, signature = "valid") =>
      fetch(`http://127.0.0.1:${address.port}/api/webhooks/github`, {
        method: "POST",
        headers: { "x-github-event": event, "x-hub-signature-256": signature },
        body: JSON.stringify({
          repository: { full_name: "owner/repo" },
          issue: pr ? { pull_request: { url: "unused" } } : {},
          action: "created",
        }),
      });
    for (const event of ["issue_comment", "pull_request_review_comment", "pull_request_review"]) {
      assert.equal((await send(event, true, "invalid")).status, 401);
      assert.equal((await send(event)).status, 200);
    }
    assert.equal((await send("issue_comment", false)).status, 200);
    assert.deepEqual(repositories, enabled ? ["owner/repo", "owner/repo", "owner/repo"] : []);
  });
}
