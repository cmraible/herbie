import { executeDurably } from "./durable-execution.js";
import { randomUUID } from "node:crypto";
import { DaytonaNotFoundError } from "@daytona/sdk";
import type {
  CreateSandboxFromImageParams,
  CreateSandboxFromSnapshotParams,
  Sandbox,
} from "@daytona/sdk";
import type { Readable } from "node:stream";
import type { Environment, EnvironmentProvider } from "./environment.js";
import { runAgentAttempt, type AttemptRequest } from "./agent-attempt.js";
import { installEnvironmentRuntime, configureEnvironmentRuntime } from "./environment-runtime.js";
import { AttemptCommandError } from "./attempt-diagnostics.js";
export {
  AGENT_RUNTIME_FILES as DAYTONA_RUNTIME_FILES,
  AgentAttemptError as DaytonaAttemptError,
  type AgentAttemptChanges as DaytonaAttemptChanges,
  type AgentAttemptArtifact as DaytonaAttemptArtifact,
  parseFeedbackDecision,
} from "./agent-attempt.js";
type AttemptSandbox = Pick<Sandbox, "id" | "delete"> &
  Partial<Pick<Sandbox, "cpu" | "memory" | "disk">> & {
    git: Pick<Sandbox["git"], "clone">;
    fs: {
      createFolder: Sandbox["fs"]["createFolder"];
      uploadFile(file: Buffer, path: string, timeout: number): Promise<void>;
      downloadFileStream(
        path: string,
        options: { timeout: number; signal: AbortSignal },
      ): Promise<Readable>;
    };
    process: Pick<Sandbox["process"], "executeCommand"> &
      Partial<
        Pick<
          Sandbox["process"],
          "createSession" | "executeSessionCommand" | "getSessionCommandLogs" | "deleteSession"
        >
      >;
  };
type CreateSandbox = (
  params: CreateSandboxFromSnapshotParams | CreateSandboxFromImageParams,
  options: { timeout: number },
) => Promise<AttemptSandbox>;
type DaytonaOptions = Pick<CreateSandboxFromSnapshotParams, "secrets" | "outboundProxyUrl"> & {
  snapshot?: string;
  domainAllowList?: string;
};
export function createDaytonaProvider(
  create: CreateSandbox,
  config: DaytonaOptions,
  connect?: (id: string) => Promise<AttemptSandbox>,
): EnvironmentProvider {
  const wrap = (
    sandbox: AttemptSandbox,
    resources?: { cpu: number; memory: number; disk: number },
  ): Environment => ({
    id: sandbox.id,
    ...(sandbox.process.createSession
      ? {
          async streamCommand(
            command: string,
            onStdout: (chunk: string) => Promise<void>,
            signal: AbortSignal,
          ) {
            const session = `herbie-transcript-${randomUUID()}`;
            const stop = new AbortController();
            const connection = AbortSignal.any([signal, stop.signal, AbortSignal.timeout(75_000)]);
            let pending = Promise.resolve();
            let callbackError: unknown;
            let accepting = true;
            let abort = () => {};
            try {
              connection.throwIfAborted();
              await sandbox.process.createSession!(session);
              connection.throwIfAborted();
              const result = await sandbox.process.executeSessionCommand!(session, {
                command,
                runAsync: true,
              });
              if (!result.cmdId) throw new Error("Transcript reader was not acknowledged");
              connection.throwIfAborted();
              await Promise.race([
                sandbox.process.getSessionCommandLogs!(
                  session,
                  result.cmdId,
                  (chunk) => {
                    if (!accepting) return;
                    pending = pending.then(async () => {
                      if (!callbackError) {
                        try {
                          connection.throwIfAborted();
                          await onStdout(chunk);
                        } catch (error) {
                          callbackError = error;
                          stop.abort(error);
                        }
                      }
                    });
                  },
                  () => {},
                ),
                new Promise<never>((_, reject) => {
                  abort = () => reject(connection.reason);
                  connection.addEventListener("abort", abort, { once: true });
                  if (connection.aborted) abort();
                }),
              ]);
            } finally {
              accepting = false;
              connection.removeEventListener("abort", abort);
              // Only the read-only helper belongs to this session, never the agent.
              try {
                await sandbox.process.deleteSession!(session);
              } finally {
                await pending;
              }
            }
            if (callbackError) throw callbackError;
          },
        }
      : {}),
    async prepare(durable) {
      if (resources)
        for (const key of ["cpu", "memory", "disk"] as const)
          if (sandbox[key] !== resources[key])
            throw new Error(
              `Daytona did not allocate the requested ${key}: expected ${resources[key]}, received ${sandbox[key]}`,
            );
      const command = `(\n${(config.snapshot ? "" : installEnvironmentRuntime) + configureEnvironmentRuntime}\n) 2>&1`;
      const result = durable
        ? await executeDurably(
            wrap(sandbox),
            durable.directory,
            command,
            durable.deadline,
            durable.signal,
          )
        : await sandbox.process.executeCommand(
            command,
            undefined,
            undefined,
            config.snapshot ? 60 : 300,
          );
      if (result.exitCode !== 0) throw new AttemptCommandError(result.exitCode, result.result);
    },
    mkdir: (path) => sandbox.fs.createFolder(path, "700"),
    writeFile: (contents, path) => sandbox.fs.uploadFile(contents, path, 30),
    readFile: (path, options) =>
      sandbox.fs.downloadFileStream(path, {
        timeout: options.timeoutMs / 1000,
        signal: options.signal,
      }),
    async clone(url, path, branch, commit) {
      await sandbox.git.clone(url, path, branch, commit);
    },
    exec: (command, options) =>
      sandbox.process.executeCommand(command, options.cwd, undefined, options.timeoutMs / 1000),
    destroy: () => sandbox.delete(60, true),
  });
  const reconnect = async (
    id: string,
    resources?: { cpu: number; memory: number; disk: number },
  ) => {
    try {
      return wrap(await connect!(id), resources);
    } catch (error) {
      if (error instanceof DaytonaNotFoundError) return null;
      throw error;
    }
  };
  return {
    name: "daytona",
    ...(connect ? { find: reconnect, connect: reconnect } : {}),
    async create({ name, resources, timeoutMs }) {
      if (config.snapshot && resources)
        throw new Error(
          "Custom resources require an image-based environment; snapshot resizing is unavailable.",
        );
      if (
        (config.snapshot !== undefined && !config.snapshot.trim()) ||
        (config.domainAllowList !== undefined && !config.domainAllowList.trim())
      )
        throw new Error("Snapshot or domain allowlist must not be empty");
      const sandbox = await create(
        {
          name,
          ...(config.snapshot
            ? { snapshot: config.snapshot }
            : { image: "ubuntu:22.04", resources: resources ?? { cpu: 2, memory: 4, disk: 10 } }),
          ...(config.domainAllowList ? { domainAllowList: config.domainAllowList } : {}),
          secrets: config.secrets,
          outboundProxyUrl: config.outboundProxyUrl,
          ttlMinutes: timeoutMs / 60_000,
        },
        { timeout: 120 },
      );
      return wrap(sandbox, resources);
    },
  };
}
export async function runDaytonaAttempt(
  create: CreateSandbox,
  request: AttemptRequest & DaytonaOptions,
  report: (message: string) => void | Promise<void>,
  runtimeDirectory = new URL(".", import.meta.url),
) {
  if (request.snapshot && request.resources)
    throw new Error(
      "Custom resources require an image-based environment; snapshot resizing is unavailable.",
    );
  return runAgentAttempt(createDaytonaProvider(create, request), request, report, runtimeDirectory);
}
