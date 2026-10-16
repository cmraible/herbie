import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";

const usage = "Usage: pnpm start --repo <path> --project <project>";

function main(): void {
  const { values } = parseArgs({
    options: {
      repo: { type: "string" },
      project: { type: "string" },
      help: { type: "boolean" },
    },
  });

  if (values.help) {
    console.log(usage);
    return;
  }

  if (!values.repo?.trim() || !values.project?.trim()) {
    throw new Error("Both --repo and --project must be nonempty.");
  }

  if (!statSync(values.repo).isDirectory()) {
    throw new Error("--repo must point to a directory.");
  }

  console.log(`Repository: ${values.repo}`);
  console.log(`Project: ${values.project}`);
  runCodex(values.repo, values.project);
}

function runCodex(repo: string, project: string): void {
  const prompt = [
    "Make one small improvement aligned with the project below.",
    "Read the repository instructions, implement the change, and run proportionate tests.",
    "Keep the code minimal and readable. Summarize the change and verification.",
    "Leave changes local. Do not commit, push, create a pull request, or merge.",
    "",
    `Project: ${project}`,
  ].join("\n");

  const result = spawnSync(
    "codex",
    ["exec", "--cd", repo, "--sandbox", "workspace-write", prompt],
    {
      stdio: "inherit",
    },
  );

  if (result.error) {
    throw new Error(
      `Could not start Codex. Check that codex is installed on PATH: ${result.error.message}`,
    );
  }
  if (result.signal) {
    console.error(`Codex stopped by ${result.signal}.`);
  }
  process.exitCode = result.status ?? 1;
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(usage);
  process.exitCode = 1;
}
