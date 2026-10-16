import assert from "node:assert/strict";
import test from "node:test";
import { createModelLister } from "../src/models.js";
import { createApiServer } from "../src/http.js";
import { Store } from "../src/store.js";
import { createDemoAdapters } from "../src/demo.js";
import { testAuth, testSessionToken } from "./test-auth.js";

test("model discovery authenticates, filters suggestions, and shares cached requests", async () => {
  let calls = 0;
  const list = createModelLister("fixture-key", async (url, options) => {
    calls++;
    assert.equal(url, "https://api.openai.com/v1/models");
    assert.equal(new Headers(options?.headers).get("authorization"), "Bearer fixture-key");
    return Response.json({
      data: [
        { id: "gpt-6-luna" },
        { id: "gpt-5-mini" },
        { id: "gpt-6-luna" },
        ...[
          "gpt-4o",
          "text-embedding-3-small",
          "gpt-5-chat-latest",
          "gpt-6-audio",
          "gpt-5-pro",
        ].map((id) => ({ id })),
        { id: "gpt-5-old", shutdown_date: "2000-01-01" },
      ],
    });
  });
  const expected = ["gpt-5-mini", "gpt-6-luna"];
  assert.deepEqual(await Promise.all([list(), list()]), [expected, expected]);
  assert.deepEqual(await list(), expected);
  assert.equal(calls, 1);
});

test("discovery failures do not poison the cache or expose upstream error bodies", async () => {
  let calls = 0;
  const list = createModelLister("fixture-key", async () => {
    if (++calls === 1) return new Response("private upstream details", { status: 403 });
    return Response.json({ data: [{ id: "gpt-6-luna" }] });
  });
  await assert.rejects(list(), /^Error: Model discovery failed$/);
  assert.deepEqual(await list(), ["gpt-6-luna"]);
});

for (const outcome of ["success", "failure", "unconfigured"] as const) {
  test(`model endpoint requires authentication and handles ${outcome}`, async (t) => {
    let calls = 0;
    const store = new Store({} as ConstructorParameters<typeof Store>[0]);
    const server = createApiServer({
      store,
      auth: testAuth(),
      adapters: createDemoAdapters(),
      publicUrl: "http://localhost:8787",
      listModels:
        outcome === "unconfigured"
          ? undefined
          : async () => {
              calls++;
              if (outcome === "failure") throw new Error("secret upstream response");
              return ["gpt-6-luna"];
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
    const url = `http://127.0.0.1:${address.port}/api/models`;
    assert.equal((await fetch(url)).status, 401);
    assert.equal(calls, 0);
    const response = await fetch(url, { headers: { authorization: `Bearer ${testSessionToken}` } });
    assert.equal(response.status, outcome === "success" ? 200 : outcome === "failure" ? 502 : 503);
    const body = await response.json();
    if (outcome === "success") assert.deepEqual(body, ["gpt-6-luna"]);
    else assert.ok(!JSON.stringify(body).includes("secret upstream"));
  });
}
