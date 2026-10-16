import assert from "node:assert/strict";
import test from "node:test";
import {
  diagnosticRecord,
  failureDiagnosticRecord,
  registerDiagnosticSecret,
  redactDiagnostic,
  logFailure,
} from "../src/diagnostic-log.js";

test("nested errors keep useful stacks and command metadata while redacting credentials", () => {
  const token = "opaque-fixture-credential-42";
  registerDiagnosticSecret(token);
  const cause = Object.assign(new Error("clone rejected " + token), {
    stderr: "fatal: remote refused sample branch",
    stdout: "",
    signal: "SIGKILL",
    exitCode: 128,
    headers: { authorization: "Bearer secret-header" },
    env: { OPENAI_API_KEY: "secret-env" },
  });
  const error = new AggregateError(
    [new Error("attempt setup failed", { cause })],
    "operation failed",
  );
  const record = diagnosticRecord(
    error,
    {
      component: "attempt",
      projectId: "fixture-project",
      jobId: "fixture-job",
      stage: "repository_clone",
    },
    "fixture-reference",
  );
  const text = JSON.stringify(record);
  assert.match(text, /clone rejected/);
  assert.match(text, /remote refused sample branch/);
  assert.match(text, /SIGKILL/);
  assert.match(text, /128/);
  assert.match(text, /stack/);
  assert.match(text, /fixture-reference/);
  for (const secret of [token, "secret-header", "secret-env"]) assert.ok(!text.includes(secret));
});

test("redacts bearer, GitHub tokens, PEM, credential assignments, and URL credentials/query", () => {
  const values = [
    "ghs_fixture.jwt-signature",
    "github_pat_fixturecredential",
    "sk-fixture-openai-secret",
    "eyJhbGciOiJ4In0.eyJzdWIiOiIxIn0.signature",
    "auth-fixture-secret",
    "json-secret",
    "env-secret",
    "database-password",
    "query-secret",
    "pem-secret",
  ];
  const input = `Bearer auth-fixture-secret ghs_fixture.jwt-signature github_pat_fixturecredential sk-fixture-openai-secret eyJhbGciOiJ4In0.eyJzdWIiOiIxIn0.signature {"access_token":"json-secret"} OPENAI_API_KEY=env-secret postgres://user:database-password@example.invalid/db?password=query-secret\n-----BEGIN PRIVATE KEY-----\npem-secret\n-----END PRIVATE KEY-----`;
  const redacted = redactDiagnostic(input);
  for (const value of values)
    assert.ok(!redacted.includes(value), `redaction missed synthetic fixture: ${value}`);
});

test("handles non-Error throws, cycles, accessors, and bounded oversized output", () => {
  const thrown: Record<string, unknown> = {
    reason: "upstream refused",
    stderr: "x".repeat(100_000),
    token: "hidden-fixture",
    status: 503,
  };
  thrown.self = thrown;
  Object.defineProperty(thrown, "getter", {
    enumerable: true,
    get() {
      throw new Error("Do not invoke");
    },
  });
  const record = diagnosticRecord(thrown, { component: "fixture" });
  const text = JSON.stringify(record);
  assert.match(text, /upstream refused/);
  assert.match(text, /503/);
  assert.match(text, /circular/);
  assert.match(text, /accessor omitted/);
  assert.match(text, /truncated/);
  assert.ok(!text.includes("hidden-fixture"));
  assert.ok(Buffer.byteLength(text) < 32_768);
  assert.match(
    JSON.stringify(diagnosticRecord("plain thrown failure", { component: "fixture" })),
    /plain thrown failure/,
  );
});

test("logger returns a correlation ID even when stderr writing fails", (t) => {
  t.mock.method(console, "error", () => {
    throw new Error("stderr unavailable");
  });
  assert.match(logFailure(new Error("fixture"), { component: "fixture" }), /^[0-9a-f-]{36}$/);
});

test("known environment credentials and binary output are redacted without logging saved artifacts", (t) => {
  const previous = process.env.HERBIE_DIAGNOSTIC_TEST_SECRET;
  process.env.HERBIE_DIAGNOSTIC_TEST_SECRET = "binary-opaque-sensitive-value";
  t.after(() => {
    if (previous === undefined) delete process.env.HERBIE_DIAGNOSTIC_TEST_SECRET;
    else process.env.HERBIE_DIAGNOSTIC_TEST_SECRET = previous;
  });
  const record = diagnosticRecord(
    {
      stderr: Buffer.from("failure binary-opaque-sensitive-value"),
      changes: { patch: Buffer.from("do-not-log-patch") },
    },
    { component: "fixture" },
  );
  const text = JSON.stringify(record);
  assert.match(text, /failure/);
  assert.ok(!text.includes("binary-opaque-sensitive-value"));
  assert.ok(!text.includes("do-not-log-patch"));
  assert.match(text, /REDACTED/);
});

test("persisted command output preserves its redacted failure tail and stays bounded", () => {
  const secret = "opaque-persisted-fixture-secret";
  registerDiagnosticSecret(secret);
  const error = Object.assign(new Error("setup failed"), {
    stdout:
      "install progress\n".repeat(10_000) +
      `\ncurl: ${secret} failed\nherbie-runtime-failure step=node_installation exit=28`,
    stderr: Buffer.from("details\n".repeat(1000) + "final stderr failure"),
  });
  const record = failureDiagnosticRecord(
    new AggregateError([new Error("wrapper", { cause: error })], "attempt failed"),
    { component: "attempt", stage: "runtime_preparation" },
    "fixture-reference",
  );
  const encoded = JSON.stringify(record);
  assert.match(encoded, /step=node_installation exit=28/);
  assert.match(encoded, /final stderr failure/);
  assert.ok(!encoded.includes(secret));
  assert.ok(Buffer.byteLength(encoded) < 32_768);
});
test("diagnostic serialization failure leaves a safe reference instead of failing persistence", () => {
  const error = new Error("fixture");
  Object.defineProperty(error, "name", {
    get() {
      throw new Error("unreadable error");
    },
  });
  assert.deepEqual(failureDiagnosticRecord(error, { component: "attempt" }, "fixture-reference"), {
    event: "herbie_failure",
    errorId: "fixture-reference",
    diagnosticUnavailable: true,
  });
});
