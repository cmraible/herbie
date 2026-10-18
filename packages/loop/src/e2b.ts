import { Sandbox, Secret, CommandExitError, type SandboxOpts } from "e2b";
import { Readable } from "node:stream";
import type { EnvironmentProvider } from "./environment.js";
import { configureEnvironmentRuntime } from "./environment-runtime.js";
import { AttemptCommandError } from "./attempt-diagnostics.js";

export interface E2BConfig {
  apiKey: string;
  template: string;
  openaiSecretName: string;
}
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

type E2BSandbox = Pick<Sandbox, "sandboxId" | "kill"> & {
  commands: Pick<Sandbox["commands"], "run">;
  files: Pick<Sandbox["files"], "read" | "write">;
};
export function createE2BProvider(
  config: E2BConfig,
  create: (options: SandboxOpts) => Promise<E2BSandbox> = (options) => Sandbox.create(options),
): EnvironmentProvider {
  return {
    name: "e2b",
    async create({ name, resources, timeoutMs }) {
      if (resources)
        throw new Error(
          "E2B resources are set by the configured template; custom resources are unavailable.",
        );
      const sandbox = await create({
        apiKey: config.apiKey,
        template: config.template,
        timeoutMs,
        requestTimeoutMs: 120_000,
        metadata: { name },
        // The real credential is injected outside the guest by E2B's egress proxy.
        envs: { OPENAI_API_KEY: "herbie-egress-placeholder" },
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
      const exec = async (command: string, options: { cwd?: string; timeoutMs: number }) => {
        try {
          const result = await sandbox.commands.run(command, {
            ...options,
            user: "root",
            requestTimeoutMs: 30_000,
          });
          return { exitCode: result.exitCode, result: result.stdout + result.stderr };
        } catch (error) {
          if (error instanceof CommandExitError)
            return { exitCode: error.exitCode, result: error.stdout + error.stderr };
          throw error;
        }
      };
      const checked = async (command: string, timeoutMs = 60_000) => {
        const result = await exec(command, { timeoutMs });
        if (result.exitCode !== 0) throw new AttemptCommandError(result.exitCode, result.result);
      };
      return {
        id: sandbox.sandboxId,
        prepare: () => checked(configureEnvironmentRuntime),
        mkdir: (path) => checked(`mkdir -m 700 -- ${quote(path)}`),
        async writeFile(contents, path) {
          await sandbox.files.write(path, Uint8Array.from(contents).buffer, {
            user: "root",
            requestTimeoutMs: 30_000,
          });
        },
        async readFile(path, options) {
          const stream = await sandbox.files.read(path, {
            format: "stream",
            user: "root",
            requestTimeoutMs: options.timeoutMs,
            signal: options.signal,
          });
          return Readable.from(
            (async function* () {
              const reader = stream.getReader();
              try {
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  yield Buffer.from(value);
                }
              } finally {
                await reader.cancel();
                reader.releaseLock();
              }
            })(),
          );
        },
        async clone(url, path, branch, commit) {
          await checked(
            `git clone ${branch ? `--branch ${quote(branch)} ` : ""}-- ${quote(url)} ${quote(path)}`,
            120_000,
          );
          if (commit) await checked(`git -C ${quote(path)} checkout --detach ${quote(commit)}`);
        },
        exec,
        // false means already absent, which also confirms cleanup.
        async destroy() {
          await sandbox.kill({ requestTimeoutMs: 60_000 });
        },
      };
    },
  };
}
