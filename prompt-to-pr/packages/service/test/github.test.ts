import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { GitHub } from "../src/github.js";
import { redactDiagnostic } from "../src/diagnostic.js";

test("safe GitHub reads retry transient errors; writes never blindly retry", async () => {
  let reads = 0;
  const fetch = mock.method(globalThis, "fetch", async () => {
    reads++;
    return reads === 1 ? new Response("unavailable", { status: 503 }) : Response.json({ ok: true });
  });
  try {
    assert.deepEqual(await new GitHub("test", "test").request("/test", "token"), { ok: true });
    assert.equal(reads, 2);
    fetch.mock.mockImplementation(async () => {
      throw new Error("lost response");
    });
    const before = fetch.mock.callCount();
    await assert.rejects(new GitHub("test", "test").request("/test", "token", "POST", {}));
    assert.equal(fetch.mock.callCount() - before, 1);
  } finally {
    fetch.mock.restore();
  }
});

test("private diagnostics redact known and recognizable credentials before truncation", () => {
  const secret = "sensitive-value";
  const value = redactDiagnostic(
    `${secret} ${Buffer.from(`x-access-token:${secret}`).toString("base64")} Authorization: Bearer abc123 ghp_abcdef https://name:password@github.com`,
    [secret],
  );
  for (const token of [secret, "abc123", "ghp_abcdef", "password"])
    assert.ok(!value.includes(token));
  assert.equal(redactDiagnostic("x".repeat(20000)).length, 8000);
});
