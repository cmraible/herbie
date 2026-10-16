import assert from "node:assert/strict";
import { test } from "node:test";
import { watchDeployment } from "./deploy-watch.mjs";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const expected = "a".repeat(40);
const older = "b".repeat(40);
const newer = "c".repeat(40);
function fixture({ versions = [{ commitSha: expected }], comparisons = ["behind"] } = {}) {
  let time = Date.parse("2026-10-16T00:00:00Z");
  let reads = 0;
  let compares = 0;
  const requests = [],
    comparisonsMade = [],
    events = [];
  const next = (values, index) => {
    const value = values[Math.min(index, values.length - 1)];
    if (value instanceof Error) throw value;
    return value;
  };
  const dependencies = {
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
    emit: (value) => events.push(value),
    read: async (...args) => {
      requests.push(args);
      return next(versions, reads++);
    },
    compareCommits: async (...args) => {
      comparisonsMade.push(args);
      return next(comparisons, compares++);
    },
  };
  return {
    requests,
    comparisonsMade,
    events,
    run: (overrides) =>
      watchDeployment(
        { repo: "cmraible/herbie", commit: expected, timeout: 4, interval: 1, ...overrides },
        dependencies,
      ),
  };
}

test("confirms the exact merge without needing GitHub credentials", async () => {
  const f = fixture();
  const outcome = await f.run({ startedAt: "2026-10-15T23:59:00Z" });
  assert.equal(outcome.status, "deployed");
  assert.equal(outcome.deployed, expected);
  assert.equal(outcome.verifiedAt, "2026-10-16T00:00:00.000Z");
  assert.equal(outcome.durationSeconds, 60);
  assert.equal(f.comparisonsMade.length, 0);
});

test("verifies a newer deployment by comparing merge SHA to deployed SHA", async () => {
  const f = fixture({ versions: [{ commitSha: newer }], comparisons: ["ahead"] });
  assert.equal((await f.run()).status, "deployed");
  assert.deepEqual(f.comparisonsMade[0].slice(0, 3), ["cmraible/herbie", expected, newer]);
});

test("polls stale versions quietly and caches immutable ancestry results", async () => {
  const f = fixture({
    versions: [{ commitSha: older }, { commitSha: older }, { commitSha: expected }],
  });
  const outcome = await f.run();
  assert.equal(outcome.status, "deployed");
  assert.equal(outcome.durationSeconds, null);
  assert.equal(f.comparisonsMade.length, 1);
  assert.equal(f.events.length, 1);
  assert.notEqual(f.requests[0][0], f.requests[1][0]);
  assert.ok(f.requests.every(([, timeout]) => timeout > 0 && timeout <= 4_000));
});

test("retries endpoint, malformed JSON, and GitHub comparison failures", async () => {
  const f = fixture({
    versions: [
      new Error("HTTP 503"),
      new SyntaxError("Malformed JSON"),
      { commitSha: newer },
      { commitSha: newer },
    ],
    comparisons: [new Error("GitHub unavailable"), "ahead"],
  });
  assert.equal((await f.run()).status, "deployed");
  assert.equal(f.comparisonsMade.length, 2);
  assert.match(f.events[0].error, /HTTP 503/);
  assert.match(f.events[2].error, /GitHub unavailable/);
});

test("invalid version responses and unrelated commits never confirm deployment", async () => {
  for (const version of [
    null,
    {},
    { version: expected },
    { commitSha: "main" },
    { commitSha: [expected] },
  ]) {
    const f = fixture({ versions: [version] });
    const result = await f.run();
    assert.equal(result.status, "deployment_timeout");
    assert.match(result.error, /commitSha/);
    assert.equal(f.comparisonsMade.length, 0);
  }
  for (const comparison of ["behind", "diverged", "unknown"]) {
    const f = fixture({ versions: [{ commitSha: newer }], comparisons: [comparison] });
    assert.equal((await f.run()).status, "deployment_timeout");
  }
});

test("timeouts retain the last observed SHA and request error", async () => {
  const f = fixture({ versions: [{ commitSha: older }, new Error("Connection timed out")] });
  const result = await f.run();
  assert.equal(result.status, "deployment_timeout");
  assert.equal(result.deployed, older);
  assert.equal(result.error, "Connection timed out");
});

test("rejects invalid arguments before contacting the endpoint", async () => {
  for (const invalid of [
    { repo: "--help" },
    { commit: "main" },
    { timeout: 0 },
    { interval: Infinity },
    { startedAt: "tomorrow" },
    { startedAt: "2099-01-01Z" },
    { url: "file:///tmp/version" },
  ]) {
    const f = fixture();
    await assert.rejects(f.run(invalid));
    assert.equal(f.requests.length, 0);
  }
});

test("CLI retries HTTP and JSON errors with uncached requests and correct exit status", async (t) => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url, headers: request.headers });
    if (request.url.startsWith("/timeout")) return response.end("{}");
    if (requests.length === 1) {
      response.writeHead(503);
      return response.end("Unavailable");
    }
    if (requests.length === 2) return response.end("malformed");
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ commitSha: expected }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const run = (path, timeout) =>
    promisify(execFile)(
      process.execPath,
      [
        new URL("deploy-watch.mjs", import.meta.url).pathname,
        "--repo",
        "cmraible/herbie",
        "--commit",
        expected,
        "--url",
        base + path,
        "--interval",
        "1",
        "--timeout",
        timeout,
      ],
      { timeout: 8_000 },
    );
  const { stdout } = await run("/version", "5");
  assert.equal(JSON.parse(stdout.trim().split("\n").at(-1)).status, "deployed");
  assert.equal(requests.length, 3);
  assert.equal(new Set(requests.map((request) => request.url)).size, 3);
  assert.ok(
    requests.every(
      (request) =>
        request.headers["cache-control"] === "no-cache" && request.headers.pragma === "no-cache",
    ),
  );
  await assert.rejects(run("/timeout", "0.1"), (error) => {
    assert.equal(error.code, 1);
    assert.equal(JSON.parse(error.stdout.trim().split("\n").at(-1)).status, "deployment_timeout");
    return true;
  });
});
