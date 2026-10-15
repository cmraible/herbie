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
  let headChecks = false;
  const paths: string[] = [];
  const server = createServer(async (req, res) => {
    const path = req.url!;
    paths.push(path);
    let data: unknown;
    if (path === "/repos/owner/repo/pulls/1")
      data = {
        state,
        draft,
        node_id: "PR_fixture",
        html_url: "https://github.com/owner/repo/pull/1",
        head: { sha: "a".repeat(40), ref: "herbie/fix", repo: { full_name: "owner/repo" } },
        mergeable,
        merge_commit_sha: "b".repeat(40),
      };
    else if (path.includes("/check-runs?"))
      data = {
        check_runs:
          !noChecks && (path.includes("b".repeat(40)) || headChecks)
            ? [
                {
                  id: 7,
                  name: "verify",
                  status: pending ? "in_progress" : "completed",
                  conclusion,
                  details_url: "https://github.com/owner/repo/actions/runs/8/job/9",
                  output: { title: null, summary: "assertion failed", text: null },
                },
              ]
            : [],
      };
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
  assert.equal((await get())?.state, "passed");
  const ready = (head = "a".repeat(40), beforeWrite = async () => {}) =>
    github.markReady("token", "owner/repo", 1, "herbie/fix", head, beforeWrite);
  headChecks = true;
  pending = true;
  mergeable = null;
  assert.equal(await get(), null);
  assert.equal(await ready(), false);
  mergeable = true;
  pending = false;
  headChecks = false;
  noChecks = true;
  assert.equal(await get(), null);
  assert.equal(await ready(), false);
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
      throw new Error("Goal paused");
    }),
    /Goal paused/,
  );
  assert.equal(writes, 0);
  graphError = true;
  await assert.rejects(ready(), /did not confirm/);
  graphError = false;
  assert.equal(await ready(), true);
  assert.equal(writes, 2);
  assert.equal(await ready(), true);
  assert.equal(writes, 2, "already-ready PR is not mutated again");
  draft = true;
  state = "closed";
  assert.equal(await ready(), false);
  conclusion = "failure";
  assert.equal(await get(), null);
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
