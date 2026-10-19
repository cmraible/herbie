import type { Readable } from "node:stream";

export interface Environment {
  id: string;
  // Only observes a read-only helper; disconnecting must not stop agent execution.
  streamCommand?(
    command: string,
    onStdout: (chunk: string) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void>;
  prepare(durable?: { directory: string; deadline: number; signal?: AbortSignal }): Promise<void>;
  mkdir(path: string): Promise<void>;
  writeFile(contents: Buffer, path: string): Promise<void>;
  readFile(path: string, options: { timeoutMs: number; signal: AbortSignal }): Promise<Readable>;
  clone(url: string, path: string, branch?: string, commit?: string): Promise<void>;
  exec(
    command: string,
    options: { cwd?: string; timeoutMs: number },
  ): Promise<{ exitCode: number; result: string }>;
  // Resolve only when termination is confirmed. Must tolerate repeated calls.
  destroy(): Promise<void>;
}
export interface EnvironmentProvider {
  name: string;
  find?(
    name: string,
    resources?: { cpu: number; memory: number; disk: number },
  ): Promise<Environment | null>;
  connect?(
    id: string,
    resources?: { cpu: number; memory: number; disk: number },
  ): Promise<Environment | null>;
  create(options: {
    name: string;
    resources?: { cpu: number; memory: number; disk: number };
    timeoutMs: number;
  }): Promise<Environment>;
}
