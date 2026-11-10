// Executed only inside the disposable sandbox. No GitHub write credentials are present.
import { readFile, writeFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runCodexAttempt } from "./codex-process.js";

const execute = promisify(execFile);
try {
  const input = JSON.parse(await readFile("/work/input.json", "utf8"));
  const cwd = "/work/repo";
  await runCodexAttempt("codex", ["app-server"], {
    cwd,
    model: input.model,
    disposableEnvironment: true,
    turnTimeoutMs: 20 * 60_000,
    project: `${input.prompt}\n\nFollow the repository instructions and lockfile. Implement the smallest appropriate change and run relevant checks. Do not push or open a PR. When finished, write /work/result.json with exactly these JSON fields: outcome ("changes" or "no_changes"), title (one line), summary (Markdown explaining the result), verification (actual commands and results, including failures and unavailable checks). Use repository-relative file paths in backticks in the summary; never link to sandbox filesystem paths. Only use no_changes when no change is warranted; never hide an unsuccessful implementation as no_changes.`,
  });
  const resultPath = "/work/result.json";
  if ((await stat(resultPath)).size > 100_000) throw new Error("Agent result too large");
  const result = JSON.parse(await readFile(resultPath, "utf8"));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  await execute("git", ["-c", "core.hooksPath=/dev/null", "add", "--all"], {
    cwd,
    env,
    timeout: 30_000,
  });
  const { stdout: patch } = await execute(
    "git",
    ["diff", "--cached", "--binary", "--no-ext-diff", input.baseSha, "--"],
    {
      cwd,
      env,
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  await writeFile(
    "/work/artifact.json",
    JSON.stringify({ repositoryId: input.repositoryId, baseSha: input.baseSha, patch, result }),
  );
} catch (error) {
  // Detailed agent output stays in the sandbox. The service records the current stage.
  process.stderr.write("Coding session or result capture failed\n");
  if (error instanceof AggregateError) {
    for (const cause of error.errors)
      if (cause instanceof Error) process.stderr.write(`${cause.message.slice(0, 500)}\n`);
  }
  process.exitCode = 1;
}
