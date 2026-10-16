import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createGithub } from "../src/github.js";

test("CI context uses current PR head and merge checks, waits for pending checks, and ignores closed PRs", async (t) => {
  let state = "open",
    pending = false,
    conclusion = "failure",
    statusPending = false;
  let draft = true,
    noChecks = false,
    graphError = false,
    writes = 0;
  let mergeable: boolean | null = true;
  let headChecks = false,
    mergeChecks = true;
  let headPending = false;
  let headConclusion = "success";
  let requiredWorkflow = false;
  let suitePending = false;
  let suiteFailure = false;
  let requiredContext = "verify";
  let requiredApp = 1;
  let protectedContext: string | null = null;
  let limited = false;
  let secondaryLimit = false;
  const paths: string[] = [];
  const server = createServer(async (req, res) => {
    const path = req.url!;
    paths.push(path);
    if (secondaryLimit) {
      res.writeHead(403, { "x-ratelimit-remaining": "100" });
      res.end(JSON.stringify({ message: "You have exceeded a secondary rate limit." }));
      return;
    }
    if (limited) {
      res.writeHead(403, {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 300),
      });
      res.end("{}");
      return;
    }
    let data: unknown;
    if (path === "/repos/owner/repo/pulls/1")
      data = {
        state,
        draft,
        node_id: "PR_fixture",
        html_url: "https://github.com/owner/repo/pull/1",
        head: { sha: "a".repeat(40), ref: "herbie/fix", repo: { full_name: "owner/repo" } },
        base: { ref: "main" },
        mergeable,
        merge_commit_sha: "b".repeat(40),
      };
    else if (path.includes("/check-suites?"))
      data = {
        check_suites: [
          {
            id: 10,
            app: { slug: "unused-or-starting-app" },
            latest_check_runs_count: suitePending ? 1 : 0,
            status: suiteFailure ? "completed" : "queued",
            conclusion: suiteFailure ? "startup_failure" : null,
          },
        ],
      };
    else if (path.includes("/check-runs?"))
      data = {
        check_runs:
          !noChecks &&
          ((path.includes("b".repeat(40)) && mergeChecks) ||
            (path.includes("a".repeat(40)) && headChecks))
            ? [
                {
                  id: 7,
                  app: { id: 1 },
                  name: "verify",
                  status: path.includes("a".repeat(40))
                    ? headPending
                      ? "in_progress"
                      : "completed"
                    : pending
                      ? "in_progress"
                      : "completed",
                  conclusion: path.includes("a".repeat(40)) ? headConclusion : conclusion,
                  details_url: "https://github.com/owner/repo/actions/runs/8/job/9",
                  output: { title: null, summary: "assertion failed", text: null },
                },
              ]
            : [],
      };
    else if (path.startsWith("/repos/owner/repo/rules/branches/main"))
      data = [
        ...(requiredWorkflow
          ? [
              {
                type: "workflows",
                parameters: {
                  workflows: [{ path: ".github/workflows/required.yml", repository_id: 5 }],
                },
              },
            ]
          : []),
        {
          type: "required_status_checks",
          parameters: {
            required_status_checks: [{ context: requiredContext, integration_id: requiredApp }],
          },
        },
      ];
    else if (path.includes("/annotations"))
      data = [{ path: "test.ts", start_line: 3, message: "Expected 2, got 1" }];
    else if (path.includes("/actions/jobs/9"))
      data = { name: "verify", steps: [{ name: "pnpm test", conclusion: "failure" }] };
    else if (path.includes("/status?"))
      data = {
        state: statusPending ? "pending" : "success",
        total_count: statusPending ? 1 : 0,
        statuses: statusPending
          ? [{ context: "external-ci", state: "pending", description: null, target_url: null }]
          : [],
      };
    else if (path === "/graphql") {
      let body = "";
      for await (const chunk of req) body += chunk;
      if (JSON.parse(body).query.startsWith("query")) {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            data: {
              repository: {
                ref: {
                  branchProtectionRule:
                    protectedContext === null
                      ? null
                      : { requiredStatusChecks: [{ context: protectedContext, app: null }] },
                },
              },
            },
          }),
        );
        return;
      }
      assert.deepEqual(JSON.parse(body).variables, { id: "PR_fixture" });
      writes++;
      if (graphError) data = { errors: [{ message: "Rejected" }], data: null };
      else {
        draft = false;
        data = {
          data: {
            markPullRequestReadyForReview: { pullRequest: { id: "PR_fixture", isDraft: false } },
          },
        };
      }
    } else {
      res.statusCode = 404;
      data = {};
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(data));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const github = createGithub(
    {
      appId: "1",
      clientId: "x",
      clientSecret: "x",
      privateKey: "unused",
      callbackUrl: "https://example.com/callback",
      webhookSecret: "secret",
    },
    { api: url, oauth: url },
  );
  const get = () => github.ciStatus("token", "owner/repo", 1, "herbie/fix");
  const failure = await get();
  assert.ok(failure?.state === "failed");
  assert.equal(failure?.head, "a".repeat(40));
  assert.match(failure!.details, /Expected 2, got 1/);
  assert.match(failure!.details, /pnpm test/);
  assert.ok(paths.some((path) => path.includes("b".repeat(40))));
  pending = true;
  assert.equal(await get(), null);
  pending = false;
  statusPending = true;
  assert.equal(await get(), null);
  statusPending = false;
  conclusion = "success";
  suitePending = true;
  assert.equal(
    await get(),
    null,
    "an unfinished active suite blocks promotion before all its jobs appear",
  );
  suitePending = false;
  assert.equal((await get())?.state, "passed");
  requiredContext = "not-created-yet";
  assert.equal(
    await get(),
    null,
    "missing required workflow blocks readiness even with passing visible checks",
  );
  requiredContext = "verify";
  requiredApp = 2;
  assert.equal(await get(), null, "a check from the wrong integration cannot satisfy the rule");
  requiredApp = 1;
  protectedContext = "legacy-required";
  assert.equal(await get(), null, "classic branch protection is also enforced");
  protectedContext = null;
  requiredWorkflow = true;
  assert.equal(
    await get(),
    null,
    "required-workflow rules cannot be satisfied by unrelated passing checks",
  );
  requiredWorkflow = false;
  headChecks = true;
  headConclusion = "failure";
  assert.equal(
    (await get())?.state,
    "passed",
    "successful merge checks replace stale failing head checks",
  );
  headPending = true;
  assert.equal(
    (await get())?.state,
    "passed",
    "successful merge checks replace pending head checks",
  );
  headPending = false;
  headConclusion = "success";
  const ready = (head = "a".repeat(40), beforeWrite = async () => {}) =>
    github.markReady("token", "owner/repo", 1, "herbie/fix", head, beforeWrite);
  headChecks = true;
  pending = true;
  mergeable = null;
  assert.equal(await get(), null);
  assert.equal(await ready(), false);
  mergeable = true;
  pending = false;
  mergeChecks = false;
  assert.equal(
    (await get())?.state,
    "passed",
    "head checks satisfy required CI when the synthetic merge ref has no checks",
  );
  mergeChecks = true;
  headChecks = false;
  noChecks = true;
  assert.equal(await get(), null);
  assert.equal(await ready(), false);
  suiteFailure = true;
  const startup = await get();
  assert.equal(startup?.state, "failed", "suite-only startup failures trigger repair");
  assert.ok(startup?.state === "failed" && startup.details.includes("startup_failure"));
  suiteFailure = false;
  noChecks = false;
  conclusion = "cancelled";
  assert.equal(await ready(), false);
  conclusion = "success";
  pending = true;
  assert.equal(await ready(), false);
  pending = false;
  assert.equal(await ready("c".repeat(40)), false);
  await assert.rejects(
    ready("a".repeat(40), async () => {
      throw new Error("Project paused");
    }),
    /Project paused/,
  );
  assert.equal(writes, 0);
  graphError = true;
  await assert.rejects(ready(), /did not confirm/);
  graphError = false;
  assert.equal(await ready(), true);
  assert.equal(writes, 2);
  assert.equal(await ready(), true);
  assert.equal(writes, 2, "already-ready PR is not mutated again");
  pending = true;
  assert.equal(await github.readinessState("token", "owner/repo", 1), "ready");
  state = "closed";
  assert.equal(await github.readinessState("token", "owner/repo", 1), "ready");
  pending = false;
  draft = true;
  state = "closed";
  assert.equal(await ready(), false);
  conclusion = "failure";
  assert.equal(await get(), null);
  draft = true;
  assert.equal(await github.readinessState("token", "owner/repo", 1), "closed");
  state = "open";
  assert.equal(await github.readinessState("token", "owner/repo", 1), "draft");
  limited = true;
  await assert.rejects(get());
  const count = paths.length;
  await assert.rejects(get(), /cooldown/);
  assert.equal(paths.length, count, "rate limit reset suppresses requests even with fresh tokens");
  await assert.rejects(github.readinessState("new-token", "owner/repo", 1), /cooldown/);
  assert.equal(paths.length, count);
  limited = false;
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 301_000);
  assert.equal(await github.readinessState("new-token", "owner/repo", 1), "draft");
  secondaryLimit = true;
  await assert.rejects(get());
  const secondaryCount = paths.length;
  await assert.rejects(get(), /cooldown/);
  assert.equal(paths.length, secondaryCount);
  secondaryLimit = false;
  t.mock.method(Date, "now", () => now + 362_000);
  assert.equal(await github.readinessState("new-token", "owner/repo", 1), "draft");
});

test("signed CI webhooks enqueue repository reviews without executing agents", async (t) => {
  const { createApiServer } = await import("../src/http.js");
  const { createDemoAdapters } = await import("../src/demo.js");
  type Options = Parameters<typeof createApiServer>[0];
  const queued: string[] = [];
  const server = createApiServer({
    store: {
      requestCiReview: async (repo: string) => {
        queued.push(repo);
      },
    } as unknown as Options["store"],
    auth: {} as Options["auth"],
    adapters: { ...createDemoAdapters(), mode: "live" },
    publicUrl: "https://example.com",
    verifyWebhook: (_body, signature) => signature === "verified",
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const send = (event: string, signature: string) =>
    fetch(`http://127.0.0.1:${address.port}/api/webhooks/github`, {
      method: "POST",
      headers: { "x-github-event": event, "x-hub-signature-256": signature },
      body: JSON.stringify({ repository: { full_name: "owner/repo" } }),
    });
  assert.equal((await send("check_run", "forged")).status, 401);
  assert.deepEqual(queued, []);
  for (const event of ["check_run", "check_suite", "status"])
    assert.equal((await send(event, "verified")).status, 200);
  assert.deepEqual(queued, ["owner/repo", "owner/repo", "owner/repo"]);
  await send("push", "verified");
  assert.equal(queued.length, 3);
});
