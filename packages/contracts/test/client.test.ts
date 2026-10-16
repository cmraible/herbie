import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { ApiError, createClient } from "../src/client.js";

async function withServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  check: (client: ReturnType<typeof createClient>) => Promise<void>,
) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No TCP address");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await check(createClient({ baseUrl, origin: baseUrl }));
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("an invalid service response cannot masquerade as a valid session", async () => {
  await withServer(
    (_request, response) => {
      response.end(JSON.stringify({ user: { id: "u", login: "octocat" }, mode: "pretend-live" }));
    },
    async (client) => {
      await assert.rejects(client.session());
    },
  );
});

test("HTTP failures preserve status and actionable service messages", async () => {
  await withServer(
    (_request, response) => {
      response.writeHead(409, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Request conflict" }));
    },
    async (client) => {
      await assert.rejects(
        client.goals(),
        (error) =>
          error instanceof ApiError && error.status === 409 && error.message === "Request conflict",
      );
    },
  );
});

test("a non-JSON service failure retains HTTP status without exposing its body", async () => {
  await withServer(
    (_request, response) => {
      response.writeHead(502, { "content-type": "text/html" });
      response.end("<html>upstream private diagnostics</html>");
    },
    async (client) => {
      await assert.rejects(
        client.goals(),
        (error) =>
          error instanceof ApiError &&
          error.status === 502 &&
          !error.message.includes("private diagnostics"),
      );
    },
  );
});

for (const maxWip of [undefined, 1, 2])
  test(`goal creation preserves rollout compatibility (maxWip: ${maxWip})`, async () => {
    const bodies: unknown[] = [];
    const id = "271de1c7-b32c-43b7-a61f-f0a2a1d53c0d";
    await withServer(
      (request, response) => {
        assert.equal(request.headers["x-herbie-goal-version"], "2");
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => {
          body += chunk;
        });
        request.on("end", () => {
          bodies.push(JSON.parse(body));
          response.end(
            JSON.stringify({
              id,
              ownerId: "owner",
              repository: "demo/example",
              name: "Work",
              prompt: "Work",
              state: "queued",
              attemptCount: 0,
              createdAt: "2026-10-15T00:00:00Z",
              updatedAt: "2026-10-15T00:00:00Z",
              mode: "demo",
              stopRequested: null,
              pullRequest: null,
              error: null,
            }),
          );
        });
      },
      async (client) => {
        await client.start({ repository: "demo/example", prompt: "Work", maxWip }, id);
        assert.deepEqual(bodies, [
          { repository: "demo/example", prompt: "Work", ...(maxWip === 2 ? { maxWip: 2 } : {}) },
        ]);
      },
    );
  });

test("repository permission failures preserve the code for the in-app update prompt", async () => {
  await withServer(
    (_request, response) => {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: "Update installation permissions",
          code: "github_permissions_required",
        }),
      );
    },
    async (client) => {
      await assert.rejects(
        client.repositories(),
        (error) =>
          error instanceof ApiError &&
          error.code === "github_permissions_required" &&
          error.status === 403,
      );
    },
  );
});
