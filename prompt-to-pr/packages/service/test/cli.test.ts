import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

test("CLI discovers paginated repositories, submits idempotently, waits, and emits JSON", async () => {
  const repository = { id: 2, fullName: "owner/repo", defaultBranch: "main" };
  const run = {
    id: "00000000-0000-4000-8000-000000000001",
    repository,
    prompt: "Fix typo",
    status: "queued",
    stage: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    pullRequest: null,
    error: null,
    summary: null,
  };
  let submitted = false;
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://localhost");
    requests.push(url.pathname + url.search);
    response.setHeader("content-type", "application/json");
    if (url.pathname.endsWith("/repositories")) {
      response.end(
        JSON.stringify(
          url.searchParams.get("cursor")
            ? { items: [repository], nextCursor: null }
            : {
                items: [{ id: 1, fullName: "owner/other", defaultBranch: "main" }],
                nextCursor: "1",
              },
        ),
      );
    } else if (request.method === "POST") {
      let body = "";
      for await (const chunk of request) body += chunk;
      assert.equal(request.headers["idempotency-key"], "00000000-0000-4000-8000-000000000002");
      assert.deepEqual(JSON.parse(body), { repositoryId: 2, prompt: "Fix typo" });
      submitted = true;
      response.statusCode = 202;
      response.end(JSON.stringify(run));
    } else
      response.end(
        JSON.stringify({
          ...run,
          status: "succeeded",
          stage: "publishing",
          pullRequest: { number: 1, url: "https://github.com/owner/repo/pull/1" },
        }),
      );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        fileURLToPath(new URL("../../cli/dist/main.js", import.meta.url)),
        "--server",
        `http://127.0.0.1:${address.port}`,
        "run",
        "--repo",
        "owner/repo",
        "--prompt",
        "Fix typo",
        "--wait",
        "--json",
        "--idempotency-key",
        "00000000-0000-4000-8000-000000000002",
      ],
      { timeout: 15000 },
    );
    assert.ok(submitted);
    assert.equal(JSON.parse(stdout).pullRequest.number, 1);
    assert.ok(requests.includes("/api/v1/repositories?cursor=1"));
    assert.ok(requests.includes(`/api/v1/runs/${run.id}`));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
