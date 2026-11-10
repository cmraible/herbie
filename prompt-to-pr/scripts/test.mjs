import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
const exec = promisify(execFile);
const name = `prompt-to-pr-test-${randomUUID()}`;
try {
  await exec("docker", [
    "run",
    "--rm",
    "-d",
    "--name",
    name,
    "-e",
    "POSTGRES_PASSWORD=local-test-only",
    "-e",
    "POSTGRES_DB=prompt_to_pr",
    "-p",
    "127.0.0.1::5432",
    "postgres:17",
  ]);
  const { stdout } = await exec("docker", ["port", name, "5432/tcp"]);
  const port = stdout.trim().split(":").at(-1);
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      await exec("docker", ["exec", name, "pg_isready", "-U", "postgres"]);
      ready = true;
      break;
    } catch {
      await delay(500);
    }
  }
  if (!ready) throw new Error("Test Postgres did not become ready");
  const child = spawn("pnpm", ["exec", "tsx", "--test", "packages/service/test/*.test.ts"], {
    stdio: "inherit",
    env: {
      ...process.env,
      TEST_DATABASE_URL: `postgresql://postgres:local-test-only@127.0.0.1:${port}/prompt_to_pr`,
    },
  });
  process.exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
} finally {
  await exec("docker", ["rm", "-f", name]).catch(() => {});
}
