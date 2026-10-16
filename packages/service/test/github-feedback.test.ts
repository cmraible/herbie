import assert from "node:assert/strict";
import test from "node:test";
import { githubFeedback } from "../src/github-feedback.js";

test("reads feedback, retains bot context, skips draft reviews, and distinguishes edits from line movement", async () => {
  let body = "Please fix this";
  let line = 5;
  const base = {
    id: 1,
    body,
    html_url: "https://github.com/owner/repo/pull/1#discussion_r1",
    user: { type: "User", login: "reviewer" },
  };
  const paths: string[] = [];
  const api = githubFeedback(async (path) => {
    paths.push(path);
    if (path.includes("/issues/"))
      return [
        { ...base, body },
        { ...base, id: 2, user: { type: "Bot", login: "herbie[bot]" } },
      ];
    if (path.includes("/reviews?"))
      return [
        { ...base, id: 3, state: "CHANGES_REQUESTED", body: "" },
        { ...base, id: 4, state: "PENDING" },
        { ...base, id: 5, state: "DISMISSED" },
      ];
    if (path.endsWith("page=1"))
      return Array.from({ length: 100 }, (_, i) => ({
        ...base,
        id: 10 + i,
        in_reply_to_id: 9,
        path: "src/index.ts",
        line,
        diff_hunk: "@@ -1 +1 @@",
      }));
    return [];
  });
  const items = await api.feedback("token", "owner/repo", 1);
  assert.equal(items.length, 103);
  assert.equal(items[1]?.bot, true);
  assert.equal(items[2]?.replyTo, 9);
  assert.equal(items[2]?.path, "src/index.ts");
  assert.equal(items.at(-1)?.state, "CHANGES_REQUESTED");
  assert.ok(paths.some((path) => path.endsWith("comments?per_page=100&page=2")));
  line = 6;
  assert.equal((await api.feedback("token", "owner/repo", 1))[2]?.revision, items[2]?.revision);
  body = "Actually, fix that";
  assert.notEqual((await api.feedback("token", "owner/repo", 1))[0]?.revision, items[0]?.revision);
});

test("replies in inline threads and links general feedback, checking ownership before writes", async () => {
  const writes: { path: string; body: unknown }[] = [];
  let owned = false;
  const api = githubFeedback(async (path, _token, body) => {
    assert.ok(owned);
    writes.push({ path, body });
    return {};
  });
  const item = {
    kind: "inline" as const,
    id: 2,
    replyTo: 1,
    author: "reviewer",
    revision: "v1",
    body: "Fix",
    url: "https://github.com/owner/repo/pull/1#discussion_r2",
  };
  await api.replyToFeedback("token", "owner/repo", 1, item, "Fixed", async () => {
    owned = true;
  });
  assert.equal(writes[0]?.path, "/repos/owner/repo/pulls/1/comments/1/replies");
  await api.replyToFeedback(
    "token",
    "owner/repo",
    1,
    { ...item, kind: "review" },
    "Explained",
    async () => {},
  );
  assert.equal(writes[1]?.path, "/repos/owner/repo/issues/1/comments");
  assert.match(JSON.stringify(writes[1]?.body), /discussion_r2/);
  await assert.rejects(
    api.replyToFeedback("token", "owner/repo", 1, item, "No", async () => {
      throw new Error("lease lost");
    }),
  );
  assert.equal(writes.length, 2);
});
