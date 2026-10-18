import type { Readable } from "node:stream";

export interface Environment {
  id: string;
  prepare(): Promise<void>;
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
  create(options: {
    name: string;
    resources?: { cpu: number; memory: number; disk: number };
    timeoutMs: number;
  }): Promise<Environment>;
}
