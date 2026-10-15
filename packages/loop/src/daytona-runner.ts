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
  const titleFile = new URL("./pr-title.txt", import.meta.url);
  const descriptionFile = new URL("./pr-description.md", import.meta.url);
  const verifyLocally = "verifyLocally" in input && input.verifyLocally === true;
  const verificationFile = new URL("./verify.sh", import.meta.url);
  const verificationInstructions = verifyLocally
    ? `
This is a CI repair. Reproduce the failing checks, make the smallest fix, and run the relevant verification locally. Do not disable checks, weaken tests, or claim success when verification is unavailable.
Write the exact verification commands to ${fileURLToPath(verificationFile)} outside the repository. Use a bash script that exits nonzero on any failure; the runner will execute it after you exit, from the repository root, with a ten-minute deadline. Include the failing checks and relevant regression coverage. Verification must not modify repository files; run generators and auto-fixers before verification. Do not push or open another PR. Then exit.`
    : "";
  const goal = `${input.goal}
${verificationInstructions}

After implementing and verifying your change, write the pull request description as Markdown to ${fileURLToPath(descriptionFile)} (outside the repository).
Write a concise, single-line pull request title (at most 256 characters) to ${fileURLToPath(titleFile)}. Name the specific change made in this attempt, rather than repeating the overall goal.
Explain the specific change you actually made, why you chose it, and how it helps the goal. Include the verification performed and any relevant limitations. Write for the user reviewing this PR; do not just repeat the goal or describe other attempts. Keep it concise.`;
  await runCodexAttempt("codex", ["app-server"], {
    cwd,
    goal,
    turnTimeoutMs: 20 * 60_000,
    disposableDaytona: true,
  });
  let verifiedTree: string | undefined;
  if (verifyLocally) {
    await git("add", "--all");
    verifiedTree = (await git("write-tree")).trim();
    if (!(await readFile(verificationFile, "utf8")).trim())
      throw new Error("Missing local verification commands");
    await promisify(execFile)("bash", ["-euo", "pipefail", fileURLToPath(verificationFile)], {
      cwd,
      timeout: 10 * 60_000,
      killSignal: "SIGKILL",
      maxBuffer: 8 * 1024 * 1024,
    });
    await git("add", "--all");
    if ((await git("write-tree")).trim() !== verifiedTree)
      throw new Error("Verification modified repository files; the repair is not verified");
  }
  const pullRequestTitle = (await readFile(titleFile, "utf8")).trim();
  if (!pullRequestTitle || pullRequestTitle.length > 256 || /[\r\n]/.test(pullRequestTitle))
    throw new Error("Invalid pull request title");
  const pullRequestBody = (await readFile(descriptionFile, "utf8")).trim();
  if (!pullRequestBody || pullRequestBody.length > 60_000)
    throw new Error("Invalid pull request description");
  // This checkout is disposable. Stage its final state to include new, non-ignored files.
  if (!verifiedTree) await git("add", "--all");
  const patchFile = new URL("./changes.patch", import.meta.url);
  await git(
    "diff",
    ...(verifiedTree ? [] : ["--cached"]),
    "--binary",
    "--full-index",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    `--output=${fileURLToPath(patchFile)}`,
    baseCommit,
    ...(verifiedTree ? [verifiedTree] : []),
    "--",
  );
  await writeFile(
    new URL("./changes.json", import.meta.url),
    JSON.stringify({
      baseCommit,
      ...(verifyLocally ? { localChecksPassed: true } : {}),
      pullRequestBody,
      pullRequestTitle,
      patchBase64: (await readFile(patchFile)).toString("base64"),
    }),
  );
  process.stdout.write("herbie-attempt-completed\n");
} catch (error) {
  process.stdout.write(sandboxFailureOutput(error, "sandbox-codex-runner"));
  process.exitCode = 1;
}
