import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import pg from "pg";
import { WebSocket } from "ws";
import { streamMessageSchema } from "@herbie/contracts";
import type { z } from "zod";
import { Store } from "../src/store.js";
import { createApiServer } from "../src/http.js";
import { createDemoAdapters } from "../src/demo.js";
import { testAuth, testSessionToken } from "./test-auth.js";

type Message = z.infer<typeof streamMessageSchema>;
function inbox(socket: WebSocket) {
  const messages: Message[] = [];
  socket.on("message", (data) =>
    messages.push(streamMessageSchema.parse(JSON.parse(String(data)))),
  );
  return async (predicate: (message: Message) => boolean) => {
    for (let i = 0; i < 200; i++) {
      const index = messages.findIndex(predicate);
      if (index >= 0) return messages.splice(index, 1)[0]!;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail("Expected stream message was not delivered");
  };
}

test("authenticated stream delivers committed worker and webhook changes, isolates owners, and recovers history", async (t) => {
  const database = process.env.HERBIE_TEST_DATABASE_URL;
  if (!database) return t.skip("Set HERBIE_TEST_DATABASE_URL for PostgreSQL integration");
  const schema = `stream_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: database });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const config = {
    connectionString: database,
    options: `-c search_path=${schema}`,
    application_name: schema,
  };
  const pool = new pg.Pool(config);
  const workerPool = new pg.Pool(config);
  const store = new Store(pool);
  const worker = new Store(workerPool);
  await store.migrate();
  const { project } = await store.createProject(
    "demo-user",
    { repository: "demo/example", prompt: "Push updates" },
    "demo",
    randomUUID(),
  );
  const other = await store.createProject(
    "other-user",
    { repository: "demo/example", prompt: "Private" },
    "demo",
    randomUUID(),
  );
  const auth = testAuth();
  let revoked = false;
  const server = createApiServer({
    store,
    auth: { ...auth, session: (token) => (revoked ? Promise.resolve(null) : auth.session(token)) },
    adapters: {
      ...createDemoAdapters(),
      async reconcile(execution) {
        return { ...execution.project.pullRequests[0]!, state: "merged" };
      },
    },
    publicUrl: "http://localhost:8787",
    verifyWebhook: (_body, signature) => signature === "valid-test-signature",
  });
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
    await workerPool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { origin: "http://localhost:8787", cookie: `herbie_session=${testSessionToken}` };
  const connect = (id = project.id) => new WebSocket(`${base}/api/stream?project=${id}`, { headers });
  for (const [path, supplied, status] of [
    ["/api/stream", { ...headers, origin: "https://evil.example" }, 403],
    ["/api/stream", { origin: headers.origin }, 401],
    [`/api/stream?project=${other.project.id}`, headers, 404],
  ] as const) {
    const denied = new WebSocket(`${base}${path}`, { headers: supplied });
    denied.on("error", () => {});
    const [, response] = await once(denied, "unexpected-response");
    assert.equal(response.statusCode, status);
    denied.terminate();
  }
  const socket = connect();
  const next = inbox(socket);
  const initial = await next((m) => m.type === "projects");
  assert.equal(initial.type, "projects");
  if (initial.type === "projects")
    assert.deepEqual(
      initial.projects.map((g) => g.id),
      [project.id],
    );
  await worker.appendEvent(project.id, "attempt", "Worker progress");
  await next((m) => m.type === "events" && m.events.some((e) => e.message === "Worker progress"));
  const transcript = JSON.stringify({
    method: "item/commandExecution/outputDelta",
    params: { delta: "output ".repeat(1000) },
  });
  await worker.appendEvent(project.id, "agent", transcript, project.attempts![0]!.id);
  await next(
    (m) =>
      m.type === "events" &&
      m.events.some(
        (e) =>
          e.type === "agent" && e.message === transcript && e.attemptId === project.attempts![0]!.id,
      ),
  );
  const transaction = await workerPool.connect();
  try {
    await transaction.query("BEGIN");
    await transaction.query(
      "INSERT INTO project_events(project_id,type,message) VALUES ($1,'attempt','Late commit')",
      [project.id],
    );
    await worker.appendEvent(project.id, "attempt", "Earlier commit");
    await next((m) => m.type === "events" && m.events.some((e) => e.message === "Earlier commit"));
    await transaction.query("COMMIT");
    await next((m) => m.type === "events" && m.events.some((e) => e.message === "Late commit"));
  } finally {
    transaction.release();
  }
  await worker.renameProject(project.id, "demo-user", "Renamed elsewhere");
  await next((m) => m.type === "projects" && m.projects[0]?.name === "Renamed elsewhere");

  const pr = {
    number: 42,
    branch: "herbie/test",
    state: "open",
    url: "https://github.com/demo/example/pull/42",
  };
  await workerPool.query(
    "UPDATE jobs SET stage='awaiting_review',branch=$2,pull_request=$3 WHERE project_id=$1",
    [project.id, pr.branch, pr],
  );
  await next((m) => m.type === "projects" && m.projects[0]?.pullRequests[0]?.state === "open");
  assert.equal(
    (
      await fetch(`${base}/api/webhooks/github`, {
        method: "POST",
        headers: {
          "x-hub-signature-256": "valid-test-signature",
          "x-github-event": "pull_request",
        },
        body: "{}",
      })
    ).status,
    200,
  );
  await next((m) => m.type === "projects" && m.projects[0]?.pullRequests[0]?.state === "merged");

  const disconnected = once(socket, "close");
  await workerPool.query(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name=$1 AND query='LISTEN herbie_changes'",
    [schema],
  );
  await disconnected;
  await workerPool.query(
    "INSERT INTO project_events(project_id,type,message) SELECT $1,'attempt','Offline ' || n FROM generate_series(1,1005) n",
    [project.id],
  );
  const reconnected = connect();
  const recovered = inbox(reconnected);
  await recovered((m) => m.type === "events" && m.events.some((e) => e.message === "Offline 1005"));
  await recovered(
    (m) =>
      m.type === "events" && m.events.some((e) => e.type === "agent" && e.message === transcript),
  );
  revoked = true;
  const closed = once(reconnected, "close");
  await worker.appendEvent(project.id, "attempt", "After logout");
  const [code] = await closed;
  assert.equal(code, 1008);
});
