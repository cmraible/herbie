import { executeDurably } from "./durable-execution.js";
import { Sandbox, Secret, CommandExitError, SandboxNotFoundError, type SandboxOpts } from "e2b";
import { Readable } from "node:stream";
import type { Environment, EnvironmentProvider } from "./environment.js";
import { configureEnvironmentRuntime } from "./environment-runtime.js";
import { AttemptCommandError } from "./attempt-diagnostics.js";
import { createE2BTemplateResolver } from "./e2b-templates.js";

export function createE2BEnvironmentPreparer(config: E2BConfig) {
  const resolve = createE2BTemplateResolver(config);
  return async (resources: { cpu: number; memory: number; disk: number } | null) => {
    await resolve(resources ?? { cpu: 2, memory: 4, disk: 10 });
  };
}

export interface E2BConfig {
  apiKey: string;
  template?: string;
  openaiSecretName: string;
}
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

type E2BSandbox = Pick<Sandbox, "sandboxId" | "kill" | "getInfo"> & {
  commands: Pick<Sandbox["commands"], "run">;
  files: Pick<Sandbox["files"], "read" | "write">;
};
export function createE2BProvider(
  config: E2BConfig,
  create: (options: SandboxOpts) => Promise<E2BSandbox> = (options) => Sandbox.create(options),
  connect: (id: string) => Promise<E2BSandbox> = (id) =>
    Sandbox.connect(id, { apiKey: config.apiKey }),
  resolveTemplate = createE2BTemplateResolver(config),
): EnvironmentProvider {
  const wrap = (
    sandbox: E2BSandbox,
    resources?: { cpu: number; memory: number; disk: number },
  ): Environment => {
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
      async streamCommand(command, onStdout, signal) {
        await sandbox.commands.run(command, {
          user: "root",
          onStdout,
          signal,
          timeoutMs: 70_000,
          requestTimeoutMs: 30_000,
        });
      },
      async prepare(durable) {
        if (resources) {
          const info = await sandbox.getInfo({ requestTimeoutMs: 30_000 });
          if (info.cpuCount !== resources.cpu || info.memoryMB !== resources.memory * 1024)
            throw new Error("E2B did not allocate the requested CPU and memory.");
          const disk = await exec("df -B1 --output=size / | tail -n 1", { timeoutMs: 30_000 });
          const bytes = Number(disk.result.trim());
          // E2B grows template disks on a best-effort basis and never shrinks them.
          if (disk.exitCode !== 0 || !Number.isFinite(bytes) || bytes < resources.disk * 1024 ** 3)
            throw new Error("E2B did not allocate the requested minimum disk capacity.");
        }
        if (!durable) return checked(configureEnvironmentRuntime);
        const result = await executeDurably(
          wrap(sandbox),
          durable.directory,
          configureEnvironmentRuntime,
          durable.deadline,
          durable.signal,
        );
        if (result.exitCode !== 0) throw new AttemptCommandError(result.exitCode, result.result);
      },
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
  };
  return {
    name: "e2b",
    async find(name, resources) {
      const matches = await Sandbox.list({
        apiKey: config.apiKey,
        query: { metadata: { name } },
      }).nextItems();
      if (matches.length > 1) throw new Error("Ambiguous session environment identity");
      return matches[0] ? wrap(await connect(matches[0].sandboxId), resources) : null;
    },
    connect: async (id, resources) => {
      try {
        return wrap(await connect(id), resources);
      } catch (error) {
        if (error instanceof SandboxNotFoundError) return null;
        throw error;
      }
    },
    async create({ name, resources, timeoutMs, signal }) {
      const sizing = resources ?? { cpu: 2, memory: 4, disk: 10 };
      const template = await resolveTemplate(sizing, signal);
      signal?.throwIfAborted();
      const sandbox = await create({
        apiKey: config.apiKey,
        template,
        signal,
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
      return wrap(sandbox, sizing);
    },
  };
}
