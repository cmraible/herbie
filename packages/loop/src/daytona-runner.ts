import { sandboxFailureOutput, registerDiagnosticSecret } from "./diagnostic-log.js";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { runCodexAttempt } from "./codex-process.js";

// Uploaded alongside the built attempt helpers; executed inside the disposable sandbox.
try {
  const input: unknown = JSON.parse(
    await readFile(new URL("./attempt.json", import.meta.url), "utf8"),
  );
  if (
    typeof input !== "object" ||
    input === null ||
    !("cwd" in input) ||
    typeof input.cwd !== "string" ||
    !("goal" in input) ||
    typeof input.goal !== "string"
  )
    throw new Error("Invalid attempt input");
  registerDiagnosticSecret(input.goal);
  const cwd = input.cwd;
  const git = async (...args: string[]) =>
    (await promisify(execFile)("git", args, { cwd, timeout: 30_000 })).stdout;
  const baseCommit = (await git("rev-parse", "HEAD")).trim();
  const descriptionFile = new URL("./pr-description.md", import.meta.url);
  const goal = `${input.goal}

After implementing and verifying your change, write the pull request description as Markdown to ${fileURLToPath(descriptionFile)} (outside the repository).
Explain the specific change you actually made, why you chose it, and how it helps the goal. Include the verification performed and any relevant limitations. Write for the user reviewing this PR; do not just repeat the goal or describe other attempts. Keep it concise.`;
  await runCodexAttempt("codex", ["app-server"], {
    cwd,
    goal,
    turnTimeoutMs: 20 * 60_000,
    disposableDaytona: true,
  });
  const pullRequestBody = (await readFile(descriptionFile, "utf8")).trim();
  if (!pullRequestBody || pullRequestBody.length > 60_000)
    throw new Error("Invalid pull request description");
  // This checkout is disposable. Stage its final state to include new, non-ignored files.
  await git("add", "--all");
  const patchFile = new URL("./changes.patch", import.meta.url);
  await git(
    "diff",
    "--cached",
    "--binary",
    "--full-index",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    `--output=${fileURLToPath(patchFile)}`,
    baseCommit,
    "--",
  );
  await writeFile(
    new URL("./changes.json", import.meta.url),
    JSON.stringify({
      baseCommit,
      pullRequestBody,
      patchBase64: (await readFile(patchFile)).toString("base64"),
    }),
  );
  process.stdout.write("herbie-attempt-completed\n");
} catch (error) {
  process.stdout.write(sandboxFailureOutput(error, "sandbox-codex-runner"));
  process.exitCode = 1;
}
