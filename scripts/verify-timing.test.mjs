import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import BrowserTimings, { packageTimings } from "./verify-timing.mjs";

function artifacts(t) {
  const directory = mkdtempSync(join(tmpdir(), "herbie-timing-"));
  const previous = process.env.HERBIE_CI_ARTIFACT_DIR;
  process.env.HERBIE_CI_ARTIFACT_DIR = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.HERBIE_CI_ARTIFACT_DIR;
    else process.env.HERBIE_CI_ARTIFACT_DIR = previous;
  });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function read(directory, id) {
  return JSON.parse(readFileSync(join(directory, "timings", id + ".json"), "utf8"));
}

test("timed shell functions retain errexit, stderr, and their original exit code", (t) => {
  const directory = artifacts(t);
  const result = spawnSync(
    "bash",
    [
      "-c",
      `
    set -Eeuo pipefail
    artifact_dir=$1
    source scripts/verify-timing.sh
    started=$(jq -nr now)
    trap 'status=$?; timing_report "$status" "$started"; exit "$status"' EXIT
    broken() { echo output; echo failure >&2; bash -c 'exit 7'; touch "$artifact_dir/unreachable"; }
    time_step '' branch time_step branch broken broken
  `,
      "bash",
      directory,
    ],
    { encoding: "utf8", cwd: resolve(import.meta.dirname, "..") },
  );
  assert.equal(result.status, 7);
  assert.match(result.stdout, /^output\n/);
  assert.match(result.stdout, /branch: .*s \[FAIL \(exit 7\)\]/);
  assert.match(result.stdout, /  broken: .*s \[FAIL \(exit 7\)\]/);
  assert.equal(result.stderr, "failure\n");
  assert.equal(existsSync(join(directory, "unreachable")), false);
  const timing = read(directory, "branch.broken");
  assert.equal(timing.status, 7);
  assert.ok(timing.seconds >= 0);
});

test("parallel branch durations are recorded by each branch, independently of wait order", (t) => {
  const directory = artifacts(t);
  const result = spawnSync(
    "bash",
    [
      "-c",
      `
    set -Eeuo pipefail
    artifact_dir=$1
    source scripts/verify-timing.sh
    started=$(jq -nr now)
    time_step '' slow sleep 0.2 & slow=$!
    time_step '' fast true & fast=$!
    wait "$slow"
    wait "$fast"
    timing_report 0 "$started"
  `,
      "bash",
      directory,
    ],
    { encoding: "utf8", cwd: resolve(import.meta.dirname, "..") },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.ok(read(directory, "slow").seconds > read(directory, "fast").seconds);
  assert.match(result.stdout, /slow: .*s \[PASS\]/);
  assert.match(result.stdout, /fast: .*s \[PASS\]/);
  assert.equal(JSON.parse(readFileSync(join(directory, "timings.json"))).timings.length, 2);
});

test("package events measure overlapping commands and retain failure and test counts", (t) => {
  const directory = artifacts(t);
  const timings = packageTimings("workspace_checks.unit-tests", () => {});
  const event = (packageName, fields) =>
    timings.event({
      name: "pnpm:lifecycle",
      wd: `/app/packages/${packageName}`,
      stage: "test",
      ...fields,
    });
  event("loop", { time: 1000, script: "tsx --test" });
  event("web", { time: 1100, script: "tsx --test" });
  event("web", { time: 1200, line: "ℹ tests 10" });
  event("web", { time: 1300, exitCode: 0 });
  event("loop", { time: 2000, exitCode: 1 });
  assert.equal(read(directory, "workspace_checks.unit-tests.loop-test").seconds, 1);
  assert.equal(read(directory, "workspace_checks.unit-tests.loop-test").status, 1);
  assert.equal(read(directory, "workspace_checks.unit-tests.web-test").tests, 10);
});

test("browser suites use elapsed time, retain retries, and identify skipped specs", (t) => {
  const directory = artifacts(t);
  const reporter = new BrowserTimings();
  const browserTest = {
    id: "test",
    location: { file: "/app/e2e/retry.spec.ts" },
    expectedStatus: "passed",
  };
  reporter.onTestBegin(browserTest);
  reporter.onTestEnd(browserTest, { status: "failed" });
  reporter.onTestEnd(browserTest, { status: "passed" });
  reporter.onTestEnd(
    { ...browserTest, location: { file: "/app/e2e/fixtures.spec.ts" } },
    { status: "skipped" },
  );
  reporter.onEnd();
  assert.equal(read(directory, "workspace_checks.browser-e2e.retry.spec.ts").status, 0);
  assert.equal(read(directory, "workspace_checks.browser-e2e.retry.spec.ts").tests, 1);
  assert.equal(read(directory, "workspace_checks.browser-e2e.fixtures.spec.ts").skipped, 1);
});
