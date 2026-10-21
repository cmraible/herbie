import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createApiServer } from "../src/http.js";
import { createDemoAdapters } from "../src/demo.js";
import type { Store } from "../src/store.js";
import { testAuth, testSessionToken } from "./test-auth.js";

test("project creation and resource edits require a matching completed environment build", async (t) => {
  const origin = "http://localhost:8787";
  const id = randomUUID();
  const resources = { cpu: 4, memory: 8, disk: 10 };
  let project:
    | { id: string; repository: string; resources: typeof resources | null; state: string }
    | undefined;
  let writes = 0;
  let builds = 0;
  let fail = false;
  let finish!: () => void;
  let gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const store = {
    getProject: async () => project,
    createProject: async (
      _owner: string,
      input: typeof resources & { repository: string; resources: typeof resources | null },
    ) => {
      writes++;
      project = { id, repository: input.repository, resources: input.resources, state: "queued" };
      return { created: true, project };
    },
    updateProject: async (
      _id: string,
      _owner: string,
      input: { resources?: typeof resources | null },
    ) => {
      writes++;
      project = { ...project!, ...input };
      return project;
    },
  } as unknown as Store;
  const auth = testAuth();
  const originalSession = auth.session;
  auth.session = async (token) =>
    token === "other-token"
      ? { user: { id: "other", login: "other" }, mode: "live" }
      : originalSession(token);
  const server = createApiServer({
    store,
    auth,
    publicUrl: origin,
    adapters: {
      ...createDemoAdapters(),
      environmentLimits: async () => ({ cpu: 8, memory: 16, disk: 30 }),
      prepareEnvironment: async () => {
        builds++;
        await gate;
        if (fail) throw new Error("private upstream build diagnostics");
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
  const base = `http://127.0.0.1:${address.port}`;
  const headers = {
    cookie: `herbie_session=${testSessionToken}`,
    origin,
    "content-type": "application/json",
    "idempotency-key": randomUUID(),
  };
  const send = (path: string, input: unknown, preparationId?: string) =>
    fetch(base + path, {
      method: "POST",
      headers: {
        ...headers,
        ...(preparationId ? { "x-herbie-environment-preparation": preparationId } : {}),
      },
      body: JSON.stringify(input),
    });
  const input = { repository: "demo/example", prompt: "Work", resources };
  const blocked = await send("/api/projects", input);
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).code, "environment_preparation_required");
  assert.equal(writes, 0);
  assert.equal(builds, 0);
  const denied = await send("/api/project-environments", { repository: "denied/repo", resources });
  assert.notEqual(denied.status, 202);
  assert.equal(builds, 0);
  const started = await send("/api/project-environments", {
    repository: input.repository,
    resources,
  });
  assert.equal(started.status, 202);
  const preparation = await started.json();
  assert.equal(preparation.state, "building");
  assert.equal(builds, 1);
  assert.equal(project, undefined);
  const repeated = await (
    await send("/api/project-environments", { repository: input.repository, resources })
  ).json();
  assert.equal(repeated.id, preparation.id);
  assert.equal(builds, 1);
  const poll = (preparationId: string) =>
    fetch(`${base}/api/project-environments/${preparationId}`, { headers });
  assert.equal((await send("/api/projects", input, preparation.id)).status, 409);
  assert.equal(
    (
      await fetch(`${base}/api/project-environments/${preparation.id}`, {
        headers: { cookie: "herbie_session=other-token" },
      })
    ).status,
    404,
  );
  finish();
  assert.equal((await (await poll(preparation.id)).json()).state, "ready");
  assert.equal(
    (
      await send(
        "/api/projects",
        { ...input, resources: { ...resources, memory: 7 } },
        preparation.id,
      )
    ).status,
    409,
  );
  assert.equal(writes, 0);
  assert.equal((await send("/api/projects", input, preparation.id)).status, 201);
  assert.equal(writes, 1);
  const larger = { ...resources, memory: 16 };
  assert.equal((await send(`/api/projects/${id}`, { resources: larger })).status, 409);
  assert.deepEqual(project!.resources, resources);
  assert.equal(writes, 1);
  assert.equal((await send(`/api/projects/${id}`, { resources })).status, 200);
  assert.equal(builds, 1);
  gate = Promise.resolve();
  fail = true;
  const failed = await (
    await send("/api/project-environments", { projectId: id, resources: larger })
  ).json();
  const failure = await (await poll(failed.id)).json();
  assert.deepEqual(failure, { id: failed.id, state: "failed" });
  assert.equal((await send(`/api/projects/${id}`, { resources: larger }, failed.id)).status, 409);
  assert.deepEqual(project!.resources, resources);
  fail = false;
  const retry = await (
    await send("/api/project-environments", { projectId: id, resources: larger })
  ).json();
  assert.notEqual(retry.id, failed.id);
  assert.equal((await (await poll(retry.id)).json()).state, "ready");
  assert.equal((await send(`/api/projects/${id}`, { resources: larger }, retry.id)).status, 200);
  assert.deepEqual(project!.resources, larger);
});

test("disabled execution blocks environment provisioning before calling the provider", async (t) => {
  const server = createApiServer({
    store: {} as Store,
    auth: testAuth(),
    adapters: {
      ...createDemoAdapters(),
      prepareEnvironment: async () => {
        throw new Error("Unexpected build");
      },
    },
    publicUrl: "http://localhost:8787",
    executionEnabled: false,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const response = await fetch(`http://127.0.0.1:${address.port}/api/project-environments`, {
    method: "POST",
    headers: {
      cookie: `herbie_session=${testSessionToken}`,
      origin: "http://localhost:8787",
      "content-type": "application/json",
    },
    body: JSON.stringify({ repository: "demo/example", resources: null }),
  });
  assert.equal(response.status, 503);
});
