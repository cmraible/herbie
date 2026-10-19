import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  existsSync,
  writeFileSync,
} from "node:fs";
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

for (const failure of ["none", "image", "database"]) {
  test(`verification overlaps image and database startup and reaps both (${failure})`, (t) => {
    const directory = artifacts(t);
    mkdirSync(join(directory, "scripts"));
    mkdirSync(join(directory, "bin"));
    for (const script of ["verify.sh", "verify-timing.sh"]) {
      copyFileSync(join(import.meta.dirname, script), join(directory, "scripts", script));
    }
    writeFileSync(join(directory, "scripts", "test-image-promotion.sh"), "exit 0\n");
    writeFileSync(
      join(directory, "bin", "docker"),
      `#!/usr/bin/env bash
set -eu
await_file() {
  for ((i=0;i<100;i++)); do
    if test -f "$1"; then return 0; fi
    sleep 0.01
  done
  echo "Did not overlap startup: $1" >&2
  exit 9
}
case "$1 \${2-}" in
  'info '|'buildx version') ;;
  'build -f')
    touch image-started
    await_file database-started
    if [[ "$VERIFY_FAILURE" == image ]]; then exit 7; fi
    while [[ "$1" != --iidfile ]]; do shift; done
    echo fixture-image > "$2"
    touch image-ready
    ;;
  'run -d')
    touch database-started
    await_file image-started
    sleep 0.1
    touch database-finished
    if [[ "$VERIFY_FAILURE" == database ]]; then exit 8; fi
    ;;
  'exec '*) touch database-ready ;;
  'run --rm')
    test -f image-ready && test -f database-ready
    touch tests-started
    ;;
  'rm -f')
    test -f database-finished
    touch cleaned-up
    ;;
  *) echo "Unexpected docker command: $*" >&2; exit 10 ;;
esac
`,
      { mode: 0o755 },
    );
    const result = spawnSync("bash", [join(directory, "scripts", "verify.sh")], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${directory}/bin:${process.env.PATH}`,
        VERIFY_FAILURE: failure,
      },
      timeout: 10_000,
    });
    assert.equal(result.status, failure === "none" ? 0 : 1, result.stdout + result.stderr);
    assert.equal(existsSync(join(directory, "tests-started")), failure === "none");
    assert.ok(existsSync(join(directory, "cleaned-up")), "cleanup must wait for database startup");
    assert.match(result.stdout + result.stderr, /postgres-startup: .*s/);
    assert.match(result.stdout + result.stderr, /verification-image: .*s/);
    if (failure !== "none") {
      const stage = failure === "image" ? "verification-image" : "postgres-startup";
      const status = failure === "image" ? 7 : 8;
      assert.ok((result.stdout + result.stderr).includes(`${stage}:`));
      assert.ok((result.stdout + result.stderr).includes(`[FAIL (exit ${status})]`));
    }
  });
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
