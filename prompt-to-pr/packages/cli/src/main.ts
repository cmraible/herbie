#!/usr/bin/env node
import { parseArgs } from "node:util";
import { mkdir, readFile, writeFile, rm, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createClient, type Run } from "@prompt-to-pr/contracts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    server: { type: "string" },
    repo: { type: "string" },
    prompt: { type: "string" },
    wait: { type: "boolean" },
    json: { type: "boolean" },
    "idempotency-key": { type: "string" },
  },
});
const server = new URL(values.server ?? process.env.PROMPT_TO_PR_URL ?? "http://localhost:8787")
  .origin;
if (!server.startsWith("https:") && !["localhost", "127.0.0.1"].includes(new URL(server).hostname))
  throw new Error("Remote servers require HTTPS");
const directory = join(homedir(), ".config", "prompt-to-pr");
const path = join(directory, `${Buffer.from(server).toString("base64url")}.json`);
let token: string | undefined;
try {
  token = JSON.parse(await readFile(path, "utf8")).token;
} catch {}
const client = createClient(server, () => token);
const print = (value: unknown) =>
  console.log(typeof value === "string" && !values.json ? value : JSON.stringify(value, null, 2));
const status = (run: Run) =>
  print(
    values.json
      ? run
      : `${run.id}  ${run.status} (${run.stage})${run.pullRequest ? `\n${run.pullRequest.url}` : ""}${run.error ? `\n${run.error.message}` : ""}${run.summary ? `\n${run.summary}` : ""}`,
  );

try {
  const [command, action, id] = positionals;
  if (command === "login") {
    // Do not send an existing session when requesting a device code.
    const unauthenticated = createClient(server);
    const code = await unauthenticated.request<{
      device_code: string;
      user_code: string;
      verification_uri: string;
      expires_in: number;
      interval: number;
    }>("/api/auth/device/code", {
      method: "POST",
      body: JSON.stringify({ client_id: "prompt-to-pr-cli" }),
    });
    console.error(`Open ${code.verification_uri}\nEnter this code: ${code.user_code}`);
    const expires = Date.now() + code.expires_in * 1000;
    let interval = code.interval * 1000;
    while (Date.now() < expires) {
      await delay(interval);
      const response = await fetch(new URL("/api/auth/device/token", server), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: code.device_code,
          client_id: "prompt-to-pr-cli",
        }),
      });
      const body = await response.json();
      if (response.ok) {
        token = body.access_token;
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(path, JSON.stringify({ token }), { mode: 0o600 });
        await chmod(path, 0o600);
        print("Signed in");
        break;
      }
      if (body.error === "slow_down") interval += 5000;
      else if (body.error !== "authorization_pending")
        throw new Error("Login denied or expired; try again");
    }
    if (Date.now() >= expires) throw new Error("Login expired; try again");
  } else if (command === "logout") {
    if (token) await client.request("/api/auth/sign-out", { method: "POST", body: "{}" });
    await rm(path, { force: true });
    print("Signed out");
  } else if (command === "repos") {
    let cursor: string | null = "";
    const items = [];
    do {
      const page = await client.repositories(cursor);
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    print(values.json ? items : items.map((repo) => repo.fullName).join("\n"));
  } else if (command === "runs") {
    let cursor: string | null = "";
    const items = [];
    do {
      const page = await client.runs(cursor);
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    if (values.json) print(items);
    else items.forEach(status);
  } else if (command === "run" && action === "status" && id) {
    status(await client.run(id));
  } else if (command === "run" && !action && values.repo && values.prompt) {
    let cursor: string | null = "";
    let repository;
    do {
      const page = await client.repositories(cursor);
      repository = page.items.find(
        (repo) => repo.fullName.toLowerCase() === values.repo!.toLowerCase(),
      );
      cursor = page.nextCursor;
    } while (!repository && cursor);
    if (!repository)
      throw new Error("Repository is unavailable; connect the GitHub App and check push access");
    const key = values["idempotency-key"] ?? randomUUID();
    console.error(`Submission key: ${key} (reuse with --idempotency-key if the response is lost)`);
    let run = await client.createRun({ repositoryId: repository.id, prompt: values.prompt }, key);
    if (!values.wait) status(run);
    else {
      console.error(`Waiting for run ${run.id}`);
      while (["queued", "running"].includes(run.status)) {
        await delay(2500);
        run = await client.run(run.id);
      }
      status(run);
      if (["failed", "needs_attention"].includes(run.status)) process.exitCode = 1;
    }
  } else
    print(
      "Usage: prompt-to-pr [--server URL] login | logout | repos | runs | run --repo owner/name --prompt 'task' [--wait] | run status ID [--json]",
    );
} catch (error) {
  console.error(error instanceof Error ? error.message : "Command failed");
  process.exitCode = 1;
}
