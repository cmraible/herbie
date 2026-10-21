import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createGithub } from "../src/github.js";

for (const reviewerLogin of [undefined, "Custom-Reviewer"]) {
  for (const scenario of [
    "new",
    "requested",
    "reviewed",
    "author",
    "draft",
    "closed",
    "retry",
  ] as const) {
    test(`request review (${reviewerLogin ?? "owner"}): ${scenario}`, async (t) => {
      let writes = 0;
      let requested = scenario === "requested";
      const owner = reviewerLogin
        ? { id: 8, login: "custom-reviewer" }
        : { id: 7, login: "renamed-owner" };
      const server = createServer(async (req, res) => {
        let result: unknown;
        if (req.url === "/repos/org/repo/pulls/1") {
          result = {
            state: scenario === "closed" ? "closed" : "open",
            draft: scenario === "draft",
            user: scenario === "author" ? owner : { id: 99, login: "herbie[bot]" },
            requested_reviewers: requested ? [owner] : [],
          };
        } else if (req.url === "/repos/org/repo/pulls/1/reviews?per_page=100&page=1") {
          result = scenario === "reviewed" ? [{ user: owner, state: "APPROVED" }] : [];
        } else if (req.url === (reviewerLogin ? "/users/custom-reviewer" : "/user/7"))
          result = owner;
        else if (req.url === "/repos/org/repo/pulls/1/requested_reviewers") {
          assert.equal(req.method, "POST");
          let body = "";
          for await (const chunk of req) body += chunk;
          assert.deepEqual(JSON.parse(body), { reviewers: [owner.login] });
          writes++;
          requested = true;
          if (scenario === "retry" && writes === 1) {
            res.writeHead(500);
            res.end("{}");
            return;
          }
          result = { requested_reviewers: [owner] };
        } else {
          res.statusCode = 404;
          result = {};
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(result));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const api = `http://127.0.0.1:${address.port}`;
      const github = createGithub(
        {
          appId: "1",
          clientId: "fixture",
          clientSecret: "fixture",
          privateKey: "unused",
          callbackUrl: "https://example.com/callback",
          webhookSecret: "fixture",
        },
        { api, oauth: api },
      );
      const request = () =>
        github.requestReview(
          "fixture",
          "org/repo",
          1,
          "7",
          reviewerLogin ? [reviewerLogin] : undefined,
        );
      if (scenario === "draft") await assert.rejects(request(), /draft/);
      else {
        if (scenario === "retry") await assert.rejects(request());
        await request();
        await request();
      }
      assert.equal(writes, scenario === "new" || scenario === "retry" ? 1 : 0);
    });
  }
}

test("multiple reviewers skip authors, existing requests and completed reviews independently", async (t) => {
  const users = ["author", "requested", "reviewed", "alice", "bob"].map((login, id) => ({
    id,
    login,
  }));
  const requested = [users[1]!];
  let writes = 0;
  const server = createServer(async (req, res) => {
    let result: unknown;
    if (req.url === "/repos/org/repo/pulls/1") {
      result = { state: "open", draft: false, user: users[0], requested_reviewers: requested };
    } else if (req.url?.includes("/reviews?")) {
      result = [{ user: users[2], state: "APPROVED" }];
    } else if (req.url?.startsWith("/users/")) {
      result = users.find((user) => req.url === `/users/${user.login}`);
    } else if (req.url?.endsWith("/requested_reviewers")) {
      let body = "";
      for await (const chunk of req) body += chunk;
      assert.deepEqual(JSON.parse(body), { reviewers: ["alice", "bob"] });
      writes++;
      requested.push(users[3]!, users[4]!);
      result = {};
    } else {
      res.statusCode = 404;
      result = {};
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(result));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const api = `http://127.0.0.1:${address.port}`;
  const github = createGithub(
    {
      appId: "1",
      clientId: "fixture",
      clientSecret: "fixture",
      privateKey: "unused",
      callbackUrl: "https://example.com/callback",
      webhookSecret: "fixture",
    },
    { api, oauth: api },
  );
  const reviewers = ["author", "requested", "reviewed", "Alice", "alice", "bob"];
  await github.requestReview("fixture", "org/repo", 1, "7", reviewers);
  await github.requestReview("fixture", "org/repo", 1, "7", reviewers);
  assert.equal(writes, 1);
});
