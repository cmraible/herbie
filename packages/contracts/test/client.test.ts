import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { ApiError, createClient } from "../src/client.js";

const savedProject = {
  id: "271de1c7-b32c-43b7-a61f-f0a2a1d53c0d",
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
};

for (const operation of ["create", "update"] as const)
  test(`${operation} polls environment preparation and preserves the save request until readiness`, async () => {
    const preparationId = "64f70c15-692b-4d40-8249-c5a3344a377e";
    const resources = { cpu: 3, memory: 7, disk: 15 };
    const saves: { body: unknown; key?: string; preparation?: string }[] = [];
    const phases: string[] = [];
    let polled = false;
    await withServer(
      (request, response) => {
        let raw = "";
        request.on("data", (chunk) => {
          raw += chunk;
        });
        request.on("end", () => {
          let result: unknown;
          if (request.url === "/api/project-environments") {
            assert.deepEqual(
              JSON.parse(raw),
              operation === "create"
                ? { repository: "demo/example", resources, setupScript: "" }
                : { projectId: savedProject.id, resources },
            );
            result = { id: preparationId, state: "building" };
          } else if (request.url === `/api/project-environments/${preparationId}`) {
            polled = true;
            result = { id: preparationId, state: "ready" };
          } else {
            saves.push({
              body: JSON.parse(raw),
              key: request.headers["idempotency-key"] as string | undefined,
              preparation: request.headers["x-herbie-environment-preparation"] as
                | string
                | undefined,
            });
            if (!request.headers["x-herbie-environment-preparation"]) {
              response.statusCode = 409;
              result = { error: "Prepare first", code: "environment_preparation_required" };
            } else {
              assert.equal(polled, true);
              result = { ...savedProject, resources };
            }
          }
          response.end(JSON.stringify(result));
        });
      },
      async (client) => {
        const progress = (phase: string) => {
          phases.push(phase);
        };
        const project =
          operation === "create"
            ? await client.start(
                { repository: "demo/example", prompt: "Work", resources },
                savedProject.id,
                progress,
              )
            : await client.update(savedProject.id, { resources }, progress);
        assert.deepEqual(project.resources, resources);
      },
    );
    assert.deepEqual(phases, ["preparing", "saving"]);
    assert.equal(saves.length, 2);
    assert.deepEqual(saves[0]!.body, saves[1]!.body);
    assert.equal(saves[0]!.key, saves[1]!.key);
    assert.equal(saves[1]!.preparation, preparationId);
  });

test("a failed environment build never retries the project write", async () => {
  let writes = 0;
  await withServer(
    (request, response) => {
      if (request.url === "/api/projects") {
        writes++;
        response.statusCode = 409;
        response.end(
          JSON.stringify({ error: "Prepare first", code: "environment_preparation_required" }),
        );
      } else {
        response.end(JSON.stringify({ id: savedProject.id, state: "failed" }));
      }
    },
    async (client) => {
      await assert.rejects(
        client.start({ repository: "demo/example", prompt: "Work" }, savedProject.id),
        /project has not been saved/,
      );
    },
  );
  assert.equal(writes, 1);
});

test("script-only edits preserve omitted resources during preparation", async () => {
  const setupScript = "echo configured\n";
  await withServer(
    (request, response) => {
      let raw = "";
      request.on("data", (chunk) => {
        raw += chunk;
      });
      request.on("end", () => {
        if (request.url === "/api/project-environments") {
          assert.deepEqual(JSON.parse(raw), { projectId: savedProject.id, setupScript });
          response.end(JSON.stringify({ id: savedProject.id, state: "ready" }));
        } else if (!request.headers["x-herbie-environment-preparation"]) {
          response.statusCode = 409;
          response.end(
            JSON.stringify({ error: "Prepare first", code: "environment_preparation_required" }),
          );
        } else {
          assert.deepEqual(JSON.parse(raw), { setupScript });
          response.end(
            JSON.stringify({
              ...savedProject,
              setupScript,
              resources: { cpu: 4, memory: 8, disk: 10 },
            }),
          );
        }
      });
    },
    async (client) => {
      const project = await client.update(savedProject.id, { setupScript });
      assert.equal(project.setupScript, setupScript);
      assert.deepEqual(project.resources, { cpu: 4, memory: 8, disk: 10 });
    },
  );
});

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
        client.projects(),
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
        client.projects(),
        (error) =>
          error instanceof ApiError &&
          error.status === 502 &&
          !error.message.includes("private diagnostics"),
      );
    },
  );
});

for (const targetWip of [undefined, 1, 2])
  test(`project creation sends the WIP target (targetWip: ${targetWip})`, async () => {
    const bodies: unknown[] = [];
    const id = "271de1c7-b32c-43b7-a61f-f0a2a1d53c0d";
    await withServer(
      (request, response) => {
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
        await client.start({ repository: "demo/example", prompt: "Work", targetWip }, id);
        assert.deepEqual(bodies, [
          { repository: "demo/example", prompt: "Work", targetWip: targetWip ?? 1 },
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

test("repository discovery retains the update prompt alongside usable repositories", async () => {
  const repositories = [{ fullName: "alice/project", defaultBranch: "main", installationId: 11 }];
  await withServer(
    (request, response) => {
      assert.equal(request.headers["x-herbie-repository-version"], "2");
      response.end(JSON.stringify({ repositories, permissionsRequired: true }));
    },
    async (client) => {
      assert.deepEqual(await client.discoverRepositories(), {
        repositories,
        permissionsRequired: true,
      });
      assert.deepEqual(await client.repositories(), repositories);
    },
  );
});
