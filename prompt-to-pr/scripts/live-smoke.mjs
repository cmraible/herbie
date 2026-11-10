// Explicit operator smoke test. Uses real paid execution and creates one draft PR.
// Run only against an authorized repository. Every attempt receives a new persistent identity.
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { GitHub } from "../packages/service/dist/github.js";
import { createExecutor } from "../packages/service/dist/execution.js";
import { publish } from "../packages/service/dist/publication.js";
const repository = process.argv[2];
const repositoryId = Number(process.argv[3]);
if (
  !/^[\w.-]+\/[\w.-]+$/.test(repository ?? "") ||
  !Number.isSafeInteger(repositoryId) ||
  repositoryId < 1
)
  throw new Error("Usage: live-smoke.mjs owner/repo numeric-repository-id");
const github = new GitHub(
  process.env.GITHUB_APP_ID,
  process.env.GITHUB_PRIVATE_KEY.replaceAll("\\n", "\n"),
);
const id = randomUUID();
await mkdir(".smoke", { recursive: true, mode: 0o700 });
const path = `.smoke/${id}.json`;
const state = {
  id,
  repository,
  repositoryId,
  createdAt: new Date().toISOString(),
  stage: "accepted",
  cleanupComplete: false,
};
await writeFile(path, JSON.stringify(state), { flag: "wx", mode: 0o600 });
const save = async (patch) => {
  Object.assign(state, patch);
  await writeFile(path, JSON.stringify(state, null, 2), { mode: 0o600 });
};
console.log(`Smoke run ${id}`);
try {
  const installation = await github.appInstallation(repository);
  const readToken = await github.installationToken(installation.id, repositoryId, false);
  const repo = await github.request(`/repos/${repository}`, readToken);
  if (repo.id !== repositoryId) throw new Error("Repository ID mismatch");
  const baseSha = await github.head(repository, repo.default_branch, readToken);
  await save({ baseSha, baseBranch: repo.default_branch });
  const execute = createExecutor({
    apiKey: process.env.E2B_API_KEY,
    template: process.env.E2B_TEMPLATE,
    openaiSecretName: process.env.E2B_OPENAI_SECRET,
  });
  const artifact = await execute(
    {
      id,
      repositoryId,
      repository,
      baseSha,
      model: process.env.AGENT_MODEL ?? "gpt-6-luna",
      prompt:
        "Add docs/prompt-to-pr-smoke-test.md with two short paragraphs explaining that this draft PR verifies a prompt-to-PR bot can make a documentation change for human review. Keep it factual and do not claim any tests passed without running them. Do not modify other files. Run git diff --check and report its result. This is an intentionally small smoke test, not a product feature.",
    },
    readToken,
    {
      stage: async (stage) => {
        await save({ stage });
        console.log(stage);
      },
      sandbox: async (sandboxId) => {
        await save({ sandboxId });
        console.log(`Sandbox ${sandboxId}`);
      },
      artifact: (artifact) => save({ artifact, stage: "cleanup" }),
      cleaned: () => save({ cleanupComplete: true }),
    },
  );
  if (artifact.result.outcome !== "changes") throw new Error("Smoke test did not produce a change");
  await save({ stage: "publishing" });
  const token = await github.installationToken(installation.id, repositoryId, true);
  const pr = await publish(
    {
      repositoryId,
      repository,
      baseBranch: repo.default_branch,
      branch: `bot/run-${id}`,
      createdAt: state.createdAt,
      artifact,
    },
    token,
    github,
    (sha) => save({ expectedSha: sha }),
    async () => {
      if (!state.cleanupComplete) throw new Error("Cleanup unconfirmed");
    },
  );
  await save({ stage: "succeeded", pullRequest: pr });
  console.log(JSON.stringify({ id, url: pr.url, cleanupComplete: state.cleanupComplete }));
} catch (error) {
  await save({
    stage: "failed",
    error: { code: error?.code ?? "smoke_failed", message: error?.constructor?.name ?? "Error" },
  });
  console.error(`Smoke run stopped; inspect ${path}. It will not retry automatically.`);
  process.exitCode = 1;
}
