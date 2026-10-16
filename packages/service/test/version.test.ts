import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import test from "node:test";
import { Pool } from "pg";
import { Store } from "../src/store.js";
import { testAuth } from "./test-auth.js";
import { createDemoAdapters } from "../src/demo.js";
import { createApiServer } from "../src/http.js";
import { runningVersion } from "../src/version.js";

test("version falls back to the local Git checkout", () => {
  if (!existsSync(new URL("../../../.git", import.meta.url))) {
    assert.equal(runningVersion().commitSha, null);
    return;
  }
  assert.equal(
    runningVersion().commitSha,
    execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  );
});

test("version is public JSON and needs no database connection", async (t) => {
  const pool = new Pool({ connectionString: "postgres://localhost:1/unavailable" });
  const publicUrl = "http://127.0.0.1";
  const commitSha = "a".repeat(40);
  const server = createApiServer({
    store: new Store(pool),
    auth: testAuth(),
    adapters: createDemoAdapters(),
    publicUrl,
    deploymentId: commitSha,
    imageRevision: "b".repeat(40),
  });
  t.after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await pool.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const response = await fetch(`http://127.0.0.1:${address.port}/api/version`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { version: runningVersion().version, commitSha });
  assert.equal(runningVersion(undefined, commitSha).commitSha, commitSha);
});
