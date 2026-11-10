import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
const exec = promisify(execFile);
const image = process.argv[2] ?? "prompt-to-pr:local";
const name = `prompt-to-pr-smoke-${randomUUID()}`;
const env = Object.entries({
  DATABASE_URL: "postgresql://postgres:local-test-only@db:5432/postgres",
  AUTH_SECRET: "container-smoke-test-secret-not-for-production",
  PUBLIC_URL: "http://localhost:8787",
  GITHUB_APP_ID: "1",
  GITHUB_APP_SLUG: "test",
  GITHUB_CLIENT_ID: "test",
  GITHUB_CLIENT_SECRET: "test",
  GITHUB_PRIVATE_KEY: "test",
  ALLOWED_GITHUB_IDS: "123",
}).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
try {
  await exec("docker", ["network", "create", name]);
  await exec("docker", [
    "run",
    "--rm",
    "-d",
    "--name",
    `${name}-db`,
    "--network",
    name,
    "--network-alias",
    "db",
    "-e",
    "POSTGRES_PASSWORD=local-test-only",
    "postgres:17",
  ]);
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await exec("docker", ["exec", `${name}-db`, "pg_isready", "-U", "postgres"]);
      ready = true;
      break;
    } catch {
      await delay(500);
    }
  }
  assert.ok(ready, "Postgres did not start");
  for (let attempt = 0; attempt < 2; attempt++)
    await exec("docker", ["run", "--rm", "--network", name, ...env, image, "migrate"]);
  console.log("Container migrations passed twice");
  await exec("docker", [
    "run",
    "--rm",
    "-d",
    "--name",
    `${name}-api`,
    "--network",
    name,
    "--read-only",
    "--tmpfs",
    "/tmp",
    "-p",
    "127.0.0.1::8787",
    ...env,
    image,
    "api",
  ]);
  const { stdout } = await exec("docker", ["port", `${name}-api`, "8787/tcp"]);
  const origin = `http://${stdout.trim()}`;
  ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      if ((await fetch(`${origin}/api/health`)).ok) {
        ready = true;
        break;
      }
    } catch {}
    await delay(500);
  }
  assert.ok(ready, "API did not become healthy");
  assert.equal((await fetch(`${origin}/api/live`)).status, 200);
  assert.equal((await fetch(`${origin}/api/v1/runs`)).status, 401);
  const html = await (await fetch(origin)).text();
  assert.match(html, /Prompt to PR/);
  const asset = html.match(/src="([^"]+\.js)"/)[1];
  assert.equal((await fetch(`${origin}${asset}`)).status, 200);
  console.log("Read-only container serves the API and web assets; unauthorized runs are rejected");
} finally {
  await exec("docker", ["rm", "-f", `${name}-api`, `${name}-db`]).catch(() => {});
  await exec("docker", ["network", "rm", name]).catch(() => {});
}
