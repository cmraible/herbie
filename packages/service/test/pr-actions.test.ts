import assert from "node:assert/strict";
import test from "node:test";
import type { Project } from "@herbie/contracts";
import type { Store } from "../src/store.js";
import { createDemoAdapters } from "../src/demo.js";
import { createApiServer } from "../src/http.js";
import { testAuth, testSessionToken } from "./test-auth.js";

test("PR actions enforce session, origin, project ownership, membership, and valid input", async (t) => {
  const id = "00000000-0000-4000-8000-000000000001";
  let visible = true;
  const calls: unknown[][] = [];
  const pr = { number: 8, state: "open" };
  const store = {
    async getProject(projectId: string, userId: string) {
      assert.equal(projectId, id);
      assert.equal(userId, "demo-user");
      return visible ? ({ repository: "alice/project", pullRequests: [pr] } as Project) : null;
    },
  } as Store;
  const server = createApiServer({
    store,
    auth: testAuth(),
    publicUrl: "http://localhost:8787",
    adapters: {
      ...createDemoAdapters(),
      async pullRequestAction(...args) {
        calls.push(args);
      },
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const body = { headSha: "1".repeat(40), mergeMethod: "squash" };
  const send = (number = 8, input = body, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${address.port}/api/projects/${id}/pull-requests/${number}/merge`, {
      method: "POST",
      headers: {
        cookie: `herbie_session=${testSessionToken}`,
        origin: "http://localhost:8787",
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(input),
    });
  assert.equal((await send(8, body, { cookie: "" })).status, 401);
  assert.equal((await send(8, body, { origin: "http://other.example" })).status, 403);
  visible = false;
  assert.equal((await send()).status, 404);
  visible = true;
  assert.equal((await send(9)).status, 404);
  assert.equal((await send(8, { ...body, headSha: "invalid" })).status, 400);
  pr.state = "closed";
  assert.equal((await send()).status, 409);
  assert.equal(calls.length, 0);
  pr.state = "open";
  assert.equal((await send()).status, 200);
  assert.deepEqual(calls, [["demo-user", "alice/project", 8, "merge", body.headSha, "squash"]]);
});
