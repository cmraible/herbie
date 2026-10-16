import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.js";

async function fixture(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  defaultAuth = true,
) {
  const server = createServer((request, response) => {
    if (defaultAuth && request.url === "/api/auth/start" && request.method === "POST") {
      json(response, {
        url: "https://github.com/login/oauth/authorize",
        pollToken: "test-poll-token",
        userCode: "ABCD-EFGH",
      });
      return;
    }
    if (defaultAuth && request.url?.startsWith("/api/auth/poll?")) {
      json(response, { status: "complete", token: "private-session" });
      return;
    }
    if (defaultAuth && request.url === "/api/session") {
      json(response, session);
      return;
    }
    handler(request, response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing TCP address");
  const directory = await mkdtemp(join(tmpdir(), "herbie-cli-"));
  const output: string[] = [];
  const errors: string[] = [];
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    configPath: join(directory, "session.json"),
    output,
    errors,
    invoke(args: string[]) {
      return runCli(args, {
        configPath: join(directory, "session.json"),
        stdout: (value) => output.push(value),
        stderr: (value) => errors.push(value),
      });
    },
    async close() {
      server.close();
      await once(server, "close");
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function json(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}
const session = { user: { id: "user-1", login: "octocat" }, mode: "live" };

test("GitHub login persists a private bearer session and authenticates subsequent status calls", async () => {
  const app = await fixture((request, response) => {
    if (
      request.url === "/api/projects" &&
      request.headers.authorization === "Bearer private-session"
    ) {
      json(response, []);
      return;
    }
    json(response, { error: "Unauthorized" }, 401);
  });
  try {
    assert.equal(await app.invoke(["login", "--url", app.baseUrl]), 0);
    assert.equal((await stat(app.configPath)).mode & 0o777, 0o600);
    assert.match(await readFile(app.configPath, "utf8"), /private-session/);
    assert.equal(await app.invoke(["status"]), 0);
    assert.deepEqual(JSON.parse(app.output.at(-1) ?? ""), []);
    assert.ok(!app.output.join("").includes("private-session"));
  } finally {
    await app.close();
  }
});

const projectId = "271de1c7-b32c-43b7-a61f-f0a2a1d53c0d";
const requestId = "8e5e189f-b9cf-4f65-9c94-5d8d25b43b70";
const project = {
  id: projectId,
  ownerId: "user-1",
  repository: "octocat/demo",
  name: "Regression coverage",
  prompt: "Add a regression test",
  attemptCount: 0,
  state: "queued",
  createdAt: "2026-10-08T00:00:00Z",
  updatedAt: "2026-10-08T00:00:00Z",
  mode: "demo",
  stopRequested: null,
  pullRequest: null,
  error: null,
};

test("start sends a custom name and preserves the request ID on retry", async () => {
  const requests: { key: string | string[] | undefined; body: unknown }[] = [];
  const app = await fixture((request, response) => {
    if (request.url === "/api/projects" && request.method === "POST") {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        requests.push({ key: request.headers["idempotency-key"], body: JSON.parse(body) });
        json(response, project, requests.length === 1 ? 201 : 200);
      });
      return;
    }
    json(response, { error: "Not found" }, 404);
  });
  try {
    await app.invoke(["login", "--url", app.baseUrl]);
    const args = [
      "start",
      "--name",
      "Regression coverage",
      "--repo",
      "octocat/demo",
      "--prompt",
      "Add a regression test",
      "--max-wip",
      "2",
      "--request-id",
      requestId,
    ];
    assert.equal(await app.invoke(args), 0);
    assert.equal(await app.invoke(args), 0);
    assert.deepEqual(
      requests,
      [0, 1].map(() => ({
        key: requestId,
        body: {
          repository: "octocat/demo",
          name: "Regression coverage",
          prompt: "Add a regression test",
          maxWip: 2,
        },
      })),
    );
    assert.equal(JSON.parse(app.output.at(-1) ?? "").id, projectId);
  } finally {
    await app.close();
  }
});

test("failed and repeated controls report service truth; events support a cursor", async () => {
  const app = await fixture((request, response) => {
    if (request.url === `/api/projects/${projectId}/pause`) {
      json(response, { error: "Publication already started" }, 409);
      return;
    }
    if (request.url === `/api/projects/${projectId}/cancel`) {
      json(response, { ...project, state: "cancelled" });
      return;
    }
    if (request.url === `/api/projects/${projectId}/events?after=2`) {
      json(response, [
        {
          id: 3,
          projectId,
          type: "cancelled",
          message: "Project cancelled",
          createdAt: "2026-10-08T00:00:01Z",
        },
      ]);
      return;
    }
    json(response, { error: "Not found" }, 404);
  });
  try {
    await app.invoke(["login", "--url", app.baseUrl]);
    assert.equal(await app.invoke(["pause", projectId]), 1);
    assert.match(app.errors.at(-1) ?? "", /Publication already started/);
    assert.equal(await app.invoke(["cancel", projectId]), 0);
    assert.equal(await app.invoke(["cancel", projectId]), 0);
    assert.equal(JSON.parse(app.output.at(-1) ?? "").state, "cancelled");
    assert.equal(await app.invoke(["logs", projectId, "--after", "2"]), 0);
    assert.equal(JSON.parse(app.output.at(-1) ?? "")[0].message, "Project cancelled");
  } finally {
    await app.close();
  }
});

test("a saved bearer token is never sent to a different service", async () => {
  const app = await fixture((_request, response) =>
    json(response, { token: "private-session", session }),
  );
  try {
    await app.invoke(["login", "--url", app.baseUrl]);
    assert.equal(await app.invoke(["status", "--url", "https://elsewhere.example"]), 1);
    assert.match(app.errors.at(-1) ?? "", /differs from saved session/);
  } finally {
    await app.close();
  }
});

test("saved publication recovery sends authenticated POST and reports server refusals", async () => {
  let retryCount = 0;
  const app = await fixture((request, response) => {
    assert.equal(request.url, `/api/projects/${projectId}/retry-publication`);
    assert.equal(request.method, "POST");
    assert.equal(request.headers.authorization, "Bearer private-session");
    assert.equal(request.headers.origin, app.baseUrl);
    retryCount++;
    if (retryCount === 1) json(response, { ...project, mode: "live" });
    else
      json(
        response,
        {
          error:
            "The repository base changed; the saved artifact cannot be published without retesting.",
        },
        409,
      );
  });
  try {
    await app.invoke(["login", "--url", app.baseUrl]);
    assert.equal(await app.invoke(["retry-publication"]), 1);
    assert.equal(await app.invoke(["retry-publication", "invalid-id"]), 1);
    assert.equal(retryCount, 0);
    assert.equal(await app.invoke(["retry-publication", projectId]), 0);
    assert.equal(JSON.parse(app.output.at(-1) ?? "").state, "queued");
    assert.equal(await app.invoke(["retry-publication", projectId]), 1);
    assert.match(app.errors.at(-1) ?? "", /base changed/);
    assert.equal(retryCount, 2);
    assert.ok(!app.output.join("").includes("private-session"));
  } finally {
    await app.close();
  }
});

test("the CLI refuses misspelled options and the removed test command before creating a project", async () => {
  const app = await fixture((_request, response) =>
    json(response, { token: "private-session", session }),
  );
  try {
    await app.invoke(["login", "--url", app.baseUrl]);
    assert.equal(
      await app.invoke([
        "start",
        "--repo",
        "octocat/demo",
        "--prompt",
        "Fix it",
        "--test",
        "npm test",
      ]),
      1,
    );
    assert.match(app.errors.at(-1) ?? "", /Unknown option/);
    assert.equal(await app.invoke(["status", "--requestid", requestId]), 1);
    assert.match(app.errors.at(-1) ?? "", /Unknown option/);
  } finally {
    await app.close();
  }
});

test("an insecure session file is rejected before credentials are read", async () => {
  const app = await fixture((_request, response) =>
    json(response, { token: "private-session", session }),
  );
  try {
    await app.invoke(["login", "--url", app.baseUrl]);
    const { chmod } = await import("node:fs/promises");
    await chmod(app.configPath, 0o644);
    assert.equal(await app.invoke(["status"]), 1);
    assert.match(app.errors.at(-1) ?? "", /private.*0600/i);
  } finally {
    await app.close();
  }
});

test("logout clears a locally saved session that the service has already expired", async () => {
  const app = await fixture((request, response) => {
    json(response, { error: "Session expired" }, 401);
  });
  try {
    await app.invoke(["login", "--url", app.baseUrl]);
    assert.equal(await app.invoke(["logout"]), 0);
    await assert.rejects(stat(app.configPath), { code: "ENOENT" });
    assert.deepEqual(JSON.parse(app.output.at(-1) ?? ""), { ok: true });
  } finally {
    await app.close();
  }
});

test("logout clears local credentials during a network outage and reports unconfirmed remote sign-out", async () => {
  const app = await fixture((request) => {
    request.socket.destroy();
  });
  try {
    await app.invoke(["login", "--url", app.baseUrl]);
    assert.equal(await app.invoke(["logout"]), 1);
    await assert.rejects(stat(app.configPath), { code: "ENOENT" });
    assert.match(
      app.errors.at(-1) ?? "",
      /Local session removed.*remote sign-out could not be confirmed/,
    );
    assert.equal(await app.invoke(["status"]), 1);
    assert.match(app.errors.at(-1) ?? "", /No valid session/);
  } finally {
    await app.close();
  }
});

test("CLI login shows its service and approval code, saving no session until browser approval", async () => {
  const pending = Promise.withResolvers<void>();
  let approved = false;
  const app = await fixture((request, response) => {
    if (request.url === "/api/auth/start") {
      json(response, {
        url: "https://github.example/authorize?state=opaque-state",
        pollToken: "private-poll-token",
        userCode: "ABCD-EFGH",
      });
      return;
    }
    if (request.url === "/api/auth/poll?token=private-poll-token") {
      if (approved) json(response, { status: "complete", token: "approved-session" });
      else {
        json(response, { status: "pending" });
        pending.resolve();
      }
      return;
    }
    if (
      request.url === "/api/session" &&
      request.headers.authorization === "Bearer approved-session"
    ) {
      json(response, { ...session, mode: "live" });
      return;
    }
    json(response, { error: "Not found" }, 404);
  }, false);
  const login = app.invoke(["login", "--url", app.baseUrl]);
  try {
    await pending.promise;
    await assert.rejects(stat(app.configPath), { code: "ENOENT" });
    const instructions = app.errors.join("");
    assert.ok(instructions.includes(`Service: ${app.baseUrl}`));
    assert.match(instructions, /Approval code: ABCD-EFGH/);
    assert.match(
      instructions,
      /Only approve if you started this login on this computer\. Enter this code in the browser\. Never approve a code sent by someone else\./,
    );
    assert.ok(instructions.includes("https://github.example/authorize?state=opaque-state\n"));
    assert.ok(!instructions.includes("private-poll-token"));
    approved = true;
    assert.equal(await login, 0);
    assert.match(await readFile(app.configPath, "utf8"), /approved-session/);
    assert.equal((await stat(app.configPath)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(app.output.at(-1) ?? "").mode, "live");
  } finally {
    approved = true;
    await login;
    await app.close();
  }
});

test("rejecting pending CLI authorization stops polling without saving a session", async () => {
  const pending = Promise.withResolvers<void>();
  let reject = false;
  const app = await fixture((request, response) => {
    if (request.url === "/api/auth/start") {
      json(response, {
        url: "https://github.example/authorize?state=rejected-state",
        pollToken: "private-poll-token",
        userCode: "WXYZ-2345",
      });
      return;
    }
    if (request.url === "/api/auth/poll?token=private-poll-token") {
      json(response, { status: reject ? "rejected" : "pending" });
      pending.resolve();
      return;
    }
    json(response, { error: "No session should be issued" }, 401);
  }, false);
  const login = app.invoke(["login", "--url", app.baseUrl]);
  try {
    await pending.promise;
    await assert.rejects(stat(app.configPath), { code: "ENOENT" });
    reject = true;
    assert.equal(await login, 1);
    assert.match(app.errors.at(-1) ?? "", /CLI authorization rejected; no session saved/);
    await assert.rejects(stat(app.configPath), { code: "ENOENT" });
    assert.equal(app.output.length, 0);
  } finally {
    reject = true;
    await login;
    await app.close();
  }
});

test("CLI authorization without a user approval code is refused before polling", async () => {
  let polls = 0;
  const app = await fixture((request, response) => {
    if (request.url === "/api/auth/start") {
      json(response, {
        url: "https://github.example/authorize?state=legacy-state",
        pollToken: "private-poll-token",
      });
      return;
    }
    polls++;
    json(response, { status: "complete", token: "unapproved-session" });
  }, false);
  try {
    assert.equal(await app.invoke(["login", "--url", app.baseUrl]), 1);
    assert.match(app.errors.at(-1) ?? "", /did not provide a CLI approval code; no session saved/);
    assert.equal(polls, 0);
    await assert.rejects(stat(app.configPath), { code: "ENOENT" });
  } finally {
    await app.close();
  }
});

test("rename sends a validated name for the selected project", async () => {
  const names: unknown[] = [];
  const app = await fixture((request, response) => {
    if (request.url === `/api/projects/${projectId}/name` && request.method === "POST") {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        const input = JSON.parse(body);
        names.push(input);
        json(response, { ...project, ...input });
      });
      return;
    }
    json(response, { error: "Not found" }, 404);
  });
  try {
    await app.invoke(["login", "--url", app.baseUrl]);
    assert.equal(await app.invoke(["rename", projectId, "--name", "   "]), 1);
    assert.equal(await app.invoke(["rename", projectId, "--name", "  Better coverage  "]), 0);
    assert.deepEqual(names, [{ name: "Better coverage" }]);
    assert.equal(JSON.parse(app.output.at(-1) ?? "").name, "Better coverage");
  } finally {
    await app.close();
  }
});

test("edit sends a validated prompt for the selected project", async () => {
  const prompts: unknown[] = [];
  const app = await fixture((request, response) => {
    if (
      [`/api/projects/${projectId}/prompt`, `/api/projects/${projectId}`].includes(
        request.url ?? "",
      ) &&
      request.method === "POST"
    ) {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        const input = JSON.parse(body);
        prompts.push(input);
        json(response, { ...project, ...input });
      });
      return;
    }
    json(response, { error: "Not found" }, 404);
  });
  try {
    await app.invoke(["login", "--url", app.baseUrl]);
    assert.equal(await app.invoke(["edit", projectId, "--prompt", "   "]), 1);
    assert.equal(await app.invoke(["edit", projectId, "--prompt", "  Better coverage  "]), 0);
    assert.deepEqual(prompts, [{ prompt: "Better coverage" }]);
    assert.equal(JSON.parse(app.output.at(-1) ?? "").prompt, "Better coverage");
    assert.equal(await app.invoke(["edit", projectId, "--model", "   "]), 1);
    assert.equal(await app.invoke(["edit", projectId, "--model", "custom-model"]), 0);
    assert.deepEqual(prompts.at(-1), { model: "custom-model" });
    assert.equal(JSON.parse(app.output.at(-1) ?? "").model, "custom-model");
  } finally {
    await app.close();
  }
});
