import assert from "node:assert/strict";
import { test } from "node:test";
import { watchPullRequest } from "./ship-watch.mjs";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const head = "a".repeat(40);
const options = { repo: "cmraible/herbie", pr: 42, head, interval: 1, timeout: 3 };
const pull = {
  url: "https://github.com/cmraible/herbie/pull/42",
  state: "OPEN",
  isDraft: false,
  headRefOid: head,
  baseRefName: "main",
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
};
const gate = (bucket) => [
  { name: "All tests passed", bucket, state: bucket, link: "https://example.test/check" },
];

function fixture({ pulls = [pull], checks = [gate("pass")], mergeError } = {}) {
  let time = 0;
  let reads = 0;
  let checkReads = 0;
  const commands = [];
  const events = [];
  const dependencies = {
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
    emit: (event) => events.push(event),
    gh: async (args) => {
      commands.push(args);
      if (args[1] === "view") return JSON.stringify(pulls[Math.min(reads++, pulls.length - 1)]);
      if (args[1] === "checks")
        return JSON.stringify(checks[Math.min(checkReads++, checks.length - 1)]);
      assert.equal(args[1], "merge");
      if (mergeError) throw new Error(mergeError);
      return "";
    },
  };
  return {
    commands,
    events,
    run: (overrides) => watchPullRequest({ ...options, ...overrides }, dependencies),
  };
}

test("waits for CI, requests one guarded merge, and waits for actual merge confirmation", async () => {
  const merged = {
    ...pull,
    state: "MERGED",
    mergedAt: "2026-10-16T01:02:00Z",
    mergeCommit: { oid: "b".repeat(40) },
  };
  const f = fixture({ pulls: [pull, pull, pull, merged], checks: [gate("pending"), gate("pass")] });
  const outcome = await f.run({ startedAt: "2026-10-16T01:00:00Z" });
  assert.equal(outcome.status, "merged");
  assert.equal(outcome.durationSeconds, 120);
  assert.equal(outcome.mergeCommit, merged.mergeCommit.oid);
  assert.deepEqual(
    f.commands.filter((args) => args[1] === "merge"),
    [["pr", "merge", "42", "--repo", "cmraible/herbie", "--squash", "--match-head-commit", head]],
  );
  assert.deepEqual(
    f.events.map((event) => event.status),
    ["checks_pending", "merge_pending"],
  );
});

test("never merges when the gate is missing, skipped, or another requirement is pending", async () => {
  for (const checks of [
    [],
    [{ name: "Other check", bucket: "pass" }],
    gate("skipping"),
    [...gate("pass"), { name: "Approval check", bucket: "pending" }],
  ]) {
    const f = fixture({ checks: [checks] });
    assert.equal((await f.run()).status, "timeout");
    assert.equal(
      f.commands.some((args) => args[1] === "merge"),
      false,
    );
    assert.equal(f.events.length, 1);
  }
});

test("returns failed check evidence and never merges failed or cancelled checks", async () => {
  for (const bucket of ["fail", "cancel"]) {
    const f = fixture({ checks: [gate(bucket)] });
    const outcome = await f.run();
    assert.equal(outcome.status, "checks_failed");
    assert.deepEqual(outcome.checks, gate(bucket));
    assert.equal(
      f.commands.some((args) => args[1] === "merge"),
      false,
    );
  }
});

test("stops before writing on changed heads, closed PRs, drafts, and conflicts", async () => {
  for (const [change, status] of [
    [{ headRefOid: "c".repeat(40) }, "head_changed"],
    [{ state: "CLOSED" }, "closed"],
    [{ isDraft: true }, "draft"],
    [{ mergeable: "CONFLICTING" }, "conflict"],
  ]) {
    const f = fixture({ pulls: [{ ...pull, ...change }] });
    assert.equal((await f.run()).status, status);
    assert.equal(f.commands.length, 1);
  }
});

test("waits for unknown mergeability and notices a head change while waiting", async () => {
  const f = fixture({
    pulls: [
      { ...pull, mergeable: "UNKNOWN" },
      { ...pull, headRefOid: "c".repeat(40) },
    ],
  });
  assert.equal((await f.run()).status, "head_changed");
  assert.equal(
    f.commands.some((args) => args[1] === "merge"),
    false,
  );
});

test("reports a queued merge as pending, never as success", async () => {
  const f = fixture();
  const outcome = await f.run();
  assert.equal(outcome.status, "timeout");
  assert.equal(outcome.mergeRequested, true);
  assert.equal(f.commands.filter((args) => args[1] === "merge").length, 1);
});

test("surfaces rejected merges without retrying or bypassing protections", async () => {
  const f = fixture({ mergeError: "Required approval missing" });
  await assert.rejects(f.run(), /Required approval missing/);
  assert.equal(f.commands.filter((args) => args[1] === "merge").length, 1);
});

test("resuming an already merged PR needs no merge request", async () => {
  const f = fixture({
    pulls: [
      {
        ...pull,
        state: "MERGED",
        mergedAt: "2026-10-16T01:02:00Z",
        mergeCommit: { oid: "b".repeat(40) },
      },
    ],
  });
  const outcome = await f.run();
  assert.equal(outcome.status, "merged");
  assert.equal(outcome.durationSeconds, null);
  assert.equal(f.commands.length, 1);
});

test("rejects unsafe or incomplete arguments before contacting GitHub", async () => {
  for (const invalid of [
    { repo: "--help" },
    { pr: "main" },
    { head: "main" },
    { startedAt: "yesterday" },
    { timeout: 0 },
    { interval: Infinity },
  ]) {
    const f = fixture();
    await assert.rejects(f.run(invalid));
    assert.equal(f.commands.length, 0);
  }
});

test("CLI handles pending/failing gh exit codes and preserves API errors", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "herbie-ship-watch-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    join(dir, "gh"),
    `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const [, , , command] = process.argv;
appendFileSync(process.env.TRACE, command + '\\n');
const scenario = process.env.SCENARIO;
if (command === 'checks' && scenario === 'api-error') {
  console.error('Authentication failed'); process.exit(1);
}
if (command === 'checks' && scenario === 'unregistered') {
  console.error("no required checks reported on the 'codex/deterministic-ship-watcher' branch"); process.exit(1);
}
if (command === 'view') {
  const pull = ${JSON.stringify(pull)};
  console.log(JSON.stringify(pull));
} else if (command === 'checks') {
  console.log(JSON.stringify(${JSON.stringify(gate("pending"))}.map(check => ({ ...check, bucket: scenario === 'failed' ? 'fail' : 'pending' }))));
  process.exit(scenario === 'failed' ? 1 : 8);
} else { throw new Error('Unexpected write: ' + command); }
`,
    { mode: 0o755 },
  );
  for (const [scenario, status] of [
    ["pending", "timeout"],
    ["failed", "checks_failed"],
    ["api-error", "error"],
    ["unregistered", "timeout"],
  ]) {
    const trace = join(dir, scenario);
    const output = spawnSync(
      process.execPath,
      [
        new URL("ship-watch.mjs", import.meta.url).pathname,
        "--repo",
        options.repo,
        "--pr",
        "42",
        "--head",
        head,
        "--timeout",
        "0.05",
        "--interval",
        "1",
      ],
      {
        encoding: "utf8",
        timeout: 5_000,
        env: { ...process.env, PATH: dir, TRACE: trace, SCENARIO: scenario },
      },
    );
    assert.equal(output.status, 1, output.stderr);
    const outcome = JSON.parse(output.stdout.trim().split("\n").at(-1));
    assert.equal(outcome.status, status, output.stdout);
    if (scenario === "api-error") assert.equal(outcome.message, "Authentication failed");
    assert.equal(readFileSync(trace, "utf8").includes("merge"), false);
  }
});
