import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { registerDiagnosticSecret, sandboxFailureOutput } from "./diagnostic-log.js";

// Runs as root before the agent starts. The input lives in a root-only directory
// outside the attempt directory, which is later handed over to the agent.
try {
  const inputPath = process.argv[2];
  const contents = await readFile(inputPath, "utf8");
  // Remove the credential even when validation or Git subsequently fails.
  await rm(inputPath);
  const input = JSON.parse(contents);
  registerDiagnosticSecret(input.token);
  const repo = new URL(input.repoUrl);
  if (
    repo.origin !== "https://github.com" ||
    repo.username ||
    repo.password ||
    repo.search ||
    repo.hash ||
    !/^\/[\w.-]+\/[\w.-]+\.git$/.test(repo.pathname) ||
    typeof input.token !== "string" ||
    !/^[A-Za-z0-9._~+/-]+=*$/.test(input.token) ||
    typeof input.cwd !== "string" ||
    (input.branch !== undefined && typeof input.branch !== "string") ||
    (input.commit !== undefined && !/^[a-f0-9]{7,64}$/.test(input.commit))
  )
    throw new Error("Invalid authenticated checkout input");

  // Per-process configuration keeps credentials out of argv, origin, and .git/config.
  // Ignore ambient helpers, hooks, URL rewrites and tracing while credentials exist.
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^GIT_|^SSH_ASKPASS$/.test(key)),
  );
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "4",
    GIT_CONFIG_KEY_0: `http.${repo.href}.extraHeader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${input.token}`).toString("base64")}`,
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: "",
    GIT_CONFIG_KEY_2: "core.hooksPath",
    GIT_CONFIG_VALUE_2: "/dev/null",
    GIT_CONFIG_KEY_3: "http.followRedirects",
    GIT_CONFIG_VALUE_3: "false",
  });
  const git = (...args: string[]) =>
    promisify(execFile)("git", args, {
      env,
      timeout: 120_000,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
    });
  await git(
    "clone",
    "--no-checkout",
    "--template=",
    ...(input.branch ? ["--branch", input.branch] : []),
    "--",
    repo.href,
    input.cwd,
  );
  // Checkout can run repository filters; drop the token before touching the worktree.
  env.GIT_CONFIG_VALUE_0 = "";
  await git(
    "-C",
    input.cwd,
    "checkout",
    "--force",
    ...(input.commit ? ["--detach", input.commit] : []),
    "--",
  );
} catch (error) {
  process.stdout.write(sandboxFailureOutput(error, "sandbox-repository-checkout"));
  process.exitCode = 1;
}
