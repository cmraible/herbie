import assert from "node:assert/strict";
import test from "node:test";
import {
  diagnosticRecord,
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
  const error = new AggregateError([new Error("run setup failed", { cause })], "operation failed");
  const record = diagnosticRecord(
    error,
    {
      component: "run",
      projectId: "fixture-project",
      runId: "fixture-run",
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
