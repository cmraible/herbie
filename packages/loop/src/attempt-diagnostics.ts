import { parseSandboxFailure } from "./diagnostic-log.js";

export type AttemptStage =
  | "sandbox_creation"
  | "runtime_preparation"
  | "runtime_upload"
  | "repository_clone"
  | "model_execution"
  | "artifact_download"
  | "sandbox_deletion";
export interface AttemptDiagnostic {
  stage: AttemptStage;
  cause:
    | "timeout"
    | "http_error"
    | "network_failure"
    | "command_failed"
    | "invalid_result"
    | "event_persistence_failed"
    | "unexpected";
  httpStatus?: number;
  exitCode?: number;
}
export class AttemptCommandError extends Error {
  readonly stdout?: string;
  readonly stderr?: string;
  constructor(
    readonly exitCode: number,
    stdout?: string,
    stderr?: string,
  ) {
    const cause = parseSandboxFailure(stdout);
    super("Sandbox command failed", cause === undefined ? undefined : { cause });
    this.stdout = cause === undefined ? stdout : undefined;
    this.stderr = stderr;
  }
}
export class AttemptResultError extends Error {
  constructor(
    message: string,
    readonly stdout?: string,
  ) {
    super(message);
  }
}
export class AttemptReportError extends Error {}

// Never copy SDK messages, command output, URLs, request configs, or headers.
export function attemptDiagnostic(error: unknown, stage: AttemptStage): AttemptDiagnostic {
  if (error instanceof AttemptReportError) return { stage, cause: "event_persistence_failed" };
  if (error instanceof AttemptCommandError)
    return {
      stage,
      cause: "command_failed",
      ...(Number.isInteger(error.exitCode) && error.exitCode >= 0 && error.exitCode <= 255
        ? { exitCode: error.exitCode }
        : {}),
    };
  if (error instanceof AttemptResultError) return { stage, cause: "invalid_result" };
  const value = error as {
    name?: unknown;
    code?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
  } | null;
  const status = value?.statusCode ?? value?.response?.status;
  const httpStatus =
    typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599
      ? status
      : undefined;
  if (
    [
      "AbortError",
      "TimeoutError",
      "DaytonaTimeoutError",
      "DaytonaConnectionTimeoutError",
      "DaytonaProcessExecutionTimeoutError",
      "DaytonaQueueTimeoutError",
    ].includes(typeof value?.name === "string" ? value.name : "") ||
    ["ETIMEDOUT", "ECONNABORTED"].includes(typeof value?.code === "string" ? value.code : "")
  )
    return { stage, cause: "timeout", ...(httpStatus ? { httpStatus } : {}) };
  if (httpStatus) return { stage, cause: "http_error", httpStatus };
  if (
    error instanceof TypeError ||
    value?.name === "DaytonaConnectionError" ||
    ["ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"].includes(
      typeof value?.code === "string" ? value.code : "",
    )
  )
    return { stage, cause: "network_failure" };
  return { stage, cause: "unexpected" };
}
export function attemptDiagnosticMessage(diagnostic: AttemptDiagnostic): string {
  return `${diagnostic.stage}: ${diagnostic.cause}${diagnostic.httpStatus === undefined ? "" : `; HTTP ${diagnostic.httpStatus}`}${diagnostic.exitCode === undefined ? "" : `; exit ${diagnostic.exitCode}`}`;
}
