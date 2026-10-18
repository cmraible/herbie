import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { Store } from "../src/store.js";
import { createDemoAdapters } from "../src/demo.js";
import { createApiServer } from "../src/http.js";
import { projectSchema } from "@herbie/contracts";
import { testAuth, testSessionToken } from "./test-auth.js";

test("HTTP project contracts, sessions, idempotency and origin checks", async (t) => {
  const responseSchema = projectSchema;
  const database = process.env.HERBIE_TEST_DATABASE_URL;
  if (!database) return t.skip("Set HERBIE_TEST_DATABASE_URL for real PostgreSQL integration");
  const schema = `http_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: database });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: database, options: `-c search_path=${schema}` });
  const store = new Store(pool);
  await store.migrate();
  const auth = testAuth();
  const server = createApiServer({
    store,
    auth,
    adapters: {
      ...createDemoAdapters(),
      environmentLimits: async () => ({ cpu: 4, memory: 8, disk: 10 }),
    },
    publicUrl: "http://localhost:8787",
  });
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(`${base}/api/projects`)).status, 401);
  const cookie = `herbie_session=${testSessionToken}`;
  const input = {
    repository: "demo/example",
    name: "Addition fix",
    prompt: "Make addition correct",
    targetWip: 2,
    resources: { cpu: 4, memory: 8, disk: 10 },
  };
  const key = randomUUID();

  const headers = {
    "content-type": "application/json",
    cookie,
    "idempotency-key": key,
  };
  assert.equal(
    (
      await fetch(`${base}/api/projects`, {
        method: "POST",
        headers,
        body: JSON.stringify(input),
      })
    ).status,
    403,
  );
  const request = () =>
    fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { ...headers, origin: "http://localhost:8787" },
      body: JSON.stringify(input),
    });
  const first = await request();
  assert.equal(first.status, 201);
  const project = responseSchema.parse(await first.json());
  const replay = await request();
  assert.equal(replay.status, 200);
  assert.equal(responseSchema.parse(await replay.json()).id, project.id);
  assert.equal(project.name, "Addition fix");
  assert.deepEqual(project.resources, { cpu: 4, memory: 8, disk: 10 });
  const overLimit = await fetch(`${base}/api/projects/${project.id}`, {
    method: "POST",
    headers: { ...headers, origin: "http://localhost:8787" },
    body: JSON.stringify({ resources: { cpu: 4, memory: 9, disk: 10 } }),
  });
  assert.equal(overLimit.status, 400);
  assert.deepEqual((await store.getProject(project.id))?.resources, project.resources);
  const status = responseSchema.parse(
    await (await fetch(`${base}/api/projects/${project.id}`, { headers })).json(),
  );
  assert.deepEqual(status, project);
  const projects = responseSchema
    .array()
    .parse(await (await fetch(`${base}/api/projects`, { headers })).json());
  assert.deepEqual(projects, [project]);
  {
    assert.equal(projectSchema.parse(project).targetWip, 2);
    assert.deepEqual(projectSchema.parse(project).pullRequests, []);
  }
  const rename = (name: string, extraHeaders = {}) =>
    fetch(`${base}/api/projects/${project.id}/name`, {
      method: "POST",
      headers: { ...headers, origin: "http://localhost:8787", ...extraHeaders },
      body: JSON.stringify({ name }),
    });
  assert.equal((await rename("Blocked", { origin: "http://other.example" })).status, 403);
  assert.equal((await rename("   ")).status, 400);
  const renamed = responseSchema.parse(await (await rename("Better addition")).json());
  assert.equal(renamed.name, "Better addition");
  assert.equal(renamed.prompt, input.prompt);
  assert.equal(responseSchema.parse(await (await request()).json()).name, "Better addition");
  const editPrompt = (prompt: string, extraHeaders = {}) =>
    fetch(`${base}/api/projects/${project.id}/prompt`, {
      method: "POST",
      headers: { ...headers, origin: "http://localhost:8787", ...extraHeaders },
      body: JSON.stringify({ prompt }),
    });
  assert.equal((await editPrompt("Blocked", { origin: "http://other.example" })).status, 403);
  assert.equal((await editPrompt("   ")).status, 400);
  assert.equal((await editPrompt("x".repeat(8001))).status, 400);
  const edited = responseSchema.parse(
    await (await editPrompt("  Also cover subtraction  ")).json(),
  );
  assert.equal(edited.prompt, "Also cover subtraction");
  assert.equal(edited.name, "Better addition");
  assert.equal(responseSchema.parse(await (await request()).json()).prompt, edited.prompt);
  const update = (input: unknown) =>
    fetch(`${base}/api/projects/${project.id}`, {
      method: "POST",
      headers: { ...headers, origin: "http://localhost:8787" },
      body: JSON.stringify(input),
    });
  assert.equal((await update({ name: "Changed", prompt: "New", targetWip: 0 })).status, 400);
  assert.equal((await update({ repository: "other/repo" })).status, 400);
  const updated = responseSchema.parse(
    await (
      await update({ name: "Updated project", prompt: "Updated prompt", targetWip: 3 })
    ).json(),
  );
  assert.equal(updated.name, "Updated project");
  assert.equal(updated.prompt, "Updated prompt");
  assert.equal(projectSchema.parse(updated).targetWip, 3);
  assert.equal(responseSchema.parse(await (await request()).json()).prompt, "Updated prompt");
  const paused = await fetch(`${base}/api/projects/${project.id}/pause`, {
    method: "POST",
    headers: { cookie, origin: "http://localhost:8787" },
  });
  assert.equal(responseSchema.parse(await paused.json()).state, "paused");
  const cancel = () =>
    fetch(`${base}/api/projects/${project.id}/cancel`, {
      method: "POST",
      headers: { cookie, origin: "http://localhost:8787" },
    });
  assert.equal(responseSchema.parse(await (await cancel()).json()).state, "cancelled");
  assert.equal(responseSchema.parse(await (await cancel()).json()).state, "cancelled");
  assert.equal(
    (await fetch(`${base}/api/projects/${randomUUID()}`, { headers: { cookie } })).status,
    404,
  );
});
