import { Sandbox, Secret, CommandExitError } from "e2b";
import { readFile } from "node:fs/promises";
import { artifactSchema, AttentionRequired, type Artifact } from "./artifact.js";
import { ExecutionError, redactDiagnostic } from "./diagnostic.js";

const bootstrap = `set -eu
node --version
git --version
codex --version
id agent >/dev/null 2>&1 || useradd -m -s /bin/bash agent
mkdir -p /opt/runner /work /home/agent/.codex
cat > /home/agent/.codex/config.toml <<'CONFIG'
model_provider = "prompt_to_pr"
model_reasoning_effort = "low"
web_search = "disabled"
[model_providers.prompt_to_pr]
name = "Prompt to PR"
base_url = "https://api.openai.com/v1"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
CONFIG
chown -R agent:agent /home/agent/.codex
chmod 700 /home/agent/.codex
`;

export type ExecutionInput = {
  id: string;
  repositoryId: number;
  repository: string;
  baseSha: string;
  prompt: string;
  model: string;
};
export type ExecutionCheckpoints = {
  stage(stage: string): Promise<void>;
  sandbox(id: string): Promise<void>;
  artifact(artifact: Artifact): Promise<void>;
  cleaned(): Promise<void>;
};

export function createExecutor(config: {
  apiKey: string;
  template: string;
  openaiSecretName: string;
}) {
  return async (
    input: ExecutionInput,
    checkoutToken: string,
    checkpoints: ExecutionCheckpoints,
  ): Promise<Artifact> => {
    await checkpoints.stage("launching");
    let sandbox;
    try {
      sandbox = await Sandbox.create({
        apiKey: config.apiKey,
        template: config.template,
        timeoutMs: 30 * 60_000,
        requestTimeoutMs: 120_000,
        metadata: { name: `prompt-to-pr-${input.id}`, runId: input.id },
        envs: { OPENAI_API_KEY: "prompt-to-pr-egress-placeholder" },
        network: {
          allowPublicTraffic: false,
          rules: {
            "api.openai.com": [
              {
                transform: {
                  headers: { Authorization: `Bearer ${Secret.fill(config.openaiSecretName)}` },
                },
              },
            ],
          },
        },
      });
    } catch {
      throw new AttentionRequired(
        "launch_uncertain",
        "Sandbox creation was not confirmed; inspect the sandbox named for this run before retrying",
      );
    }
    let captured: Artifact | undefined;
    let failure: unknown;
    try {
      await checkpoints.sandbox(sandbox.sandboxId);
      await checkpoints.stage("preparing");
      const command = async (text: string, timeout: number) => {
        try {
          await sandbox.commands.run(text, {
            user: "root",
            timeoutMs: timeout * 1000,
            requestTimeoutMs: 30_000,
          });
        } catch (error) {
          if (error instanceof CommandExitError)
            throw new ExecutionError({
              exitCode: error.exitCode,
              output: redactDiagnostic(error.stdout + error.stderr, [checkoutToken, config.apiKey]),
            });
          throw new Error("Sandbox command did not complete");
        }
      };
      const upload = (data: Buffer, path: string) =>
        sandbox.files.write(path, Uint8Array.from(data).buffer, {
          user: "root",
          requestTimeoutMs: 30_000,
        });
      await command(bootstrap, 120);
      for (const file of [
        "checkout",
        "runner",
        "codex-process",
        "codex-initialize",
        "codex-thread",
        "codex-turn",
      ])
        await upload(
          await readFile(new URL(`./agent/${file}.js`, import.meta.url)),
          `/opt/runner/${file}.js`,
        );
      await upload(Buffer.from('{"type":"module"}'), "/opt/runner/package.json");
      await upload(
        Buffer.from(
          JSON.stringify({
            repository: input.repository,
            baseSha: input.baseSha,
            token: checkoutToken,
          }),
        ),
        "/root/checkout.json",
      );
      await command("chmod 600 /root/checkout.json && node /opt/runner/checkout.js", 180);
      await upload(Buffer.from(JSON.stringify(input)), "/work/input.json");
      await command("chown -R agent:agent /work", 30);
      await checkpoints.stage("coding");
      await command("runuser -u agent -- env HOME=/home/agent node /opt/runner/runner.js", 1250);
      const stream = await sandbox.files.read("/work/artifact.json", {
        format: "stream",
        user: "root",
        requestTimeoutMs: 30_000,
        signal: AbortSignal.timeout(30_000),
      });
      const reader = stream.getReader();
      const chunks: Buffer[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          size += chunk.length;
          if (size > 32 * 1024 * 1024) throw new Error("Result exceeded size limit");
          chunks.push(Buffer.from(chunk));
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
      const artifact = artifactSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (artifact.repositoryId !== input.repositoryId || artifact.baseSha !== input.baseSha)
        throw new Error("Agent artifact does not match run");
      await checkpoints.artifact(artifact);
      captured = artifact;
    } catch (error) {
      failure = error;
    }
    {
      // Cleanup must run even when the database/lease is unavailable.
      try {
        await sandbox.kill({ requestTimeoutMs: 60_000 });
      } catch {
        throw new AttentionRequired(
          "cleanup_uncertain",
          "Sandbox deletion is unconfirmed; publication is blocked",
        );
      }
      await checkpoints.cleaned();
    }
    if (failure) throw failure;
    if (!captured) throw new Error("Execution produced no artifact");
    return captured;
  };
}
