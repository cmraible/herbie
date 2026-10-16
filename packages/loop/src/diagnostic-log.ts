import { randomUUID } from "node:crypto";

const secrets = new Set<string>();
export function registerDiagnosticSecret(value: string | undefined): void {
  if (!value || value.length < 4) return;
  for (const variant of [
    value,
    encodeURIComponent(value),
    Buffer.from(`x-access-token:${value}`).toString("base64"),
  ])
    secrets.add(variant);
  while (secrets.size > 768) secrets.delete(secrets.values().next().value!);
}
function registerEnvironmentSecrets(): void {
  for (const [key, value] of Object.entries(process.env)) {
    if (
      /TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|CREDENTIAL_KEY|DATABASE_URL|DATABASE_CA|RUNTIME_SECRETS/i.test(
        key,
      )
    )
      registerDiagnosticSecret(value);
    if (/DATABASE_URL/.test(key) && value) {
      try {
        const url = new URL(value);
        registerDiagnosticSecret(decodeURIComponent(url.password));
      } catch {
        /* Invalid config is reported by startup. */
      }
    }
  }
}
export function redactDiagnostic(value: string): string {
  let text = value;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length))
    text = text.split(secret).join("[REDACTED]");
  return text
    .replace(
      /-----BEGIN [^-]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?(?:-----END [^-]+-----|$)/g,
      "[REDACTED PEM]",
    )
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "[REDACTED AUTH]")
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_.-]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g,
      "[REDACTED TOKEN]",
    )
    .replace(/\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s"'<>]+/gi, (raw) => {
      try {
        const url = new URL(raw);
        if (url.username) url.username = "REDACTED";
        if (url.password) url.password = "REDACTED";
        if (url.search) url.search = "?REDACTED";
        if (url.hash) url.hash = "#REDACTED";
        return url.toString();
      } catch {
        return "[REDACTED URL]";
      }
    })
    .replace(
      /((?:[A-Z0-9_]{0,100}(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|CREDENTIAL)[A-Z0-9_]{0,100}|authorization|cookie)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
      "$1[REDACTED]",
    );
}
const sensitiveKey = /token|secret|password|authorization|cookie|private.?key|api.?key|credential/i;
const omitKey =
  /^(env|environment|config|request|headers|command|cmd|changes|artifact|patch|project|prompt|input)$/i;
export interface DiagnosticContext {
  component: string;
  projectId?: string;
  jobId?: string;
  stage?: string;
}
export function diagnosticRecord(
  error: unknown,
  context: DiagnosticContext,
  errorId: string = randomUUID(),
): Record<string, unknown> {
  registerEnvironmentSecrets();
  const seen = new Set<object>();
  let remaining = 10_000;
  let nodes = 0;
  let clean: (value: unknown, depth?: number) => unknown;
  const cleanProperty = (
    out: Record<string, unknown>,
    key: string,
    property: PropertyDescriptor,
    depth: number,
  ): void => {
    const safeKey = redactDiagnostic(key).slice(0, 80);
    if (sensitiveKey.test(key) || omitKey.test(key)) {
      out[safeKey] = "[REDACTED]";
      return;
    }
    out[safeKey] = "value" in property ? clean(property.value, depth + 1) : "[accessor omitted]";
  };
  const cleanObject = (value: object, depth: number): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    if (value instanceof Error) {
      out.name = clean(value.name);
      out.message = clean(value.message);
      out.stack = clean(value.stack);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Object.keys(descriptors).slice(0, 30)) {
      if (key in out) continue;
      cleanProperty(out, key, descriptors[key], depth);
    }
    return out;
  };
  clean = (value: unknown, depth = 0): unknown => {
    if (++nodes > 200) return "[node limit]";
    if (Buffer.isBuffer(value)) return clean(value.toString("utf8"), depth);
    if (typeof value === "string") {
      const redacted = redactDiagnostic(value);
      const limit = Math.min(2000, Math.max(0, remaining));
      remaining -= Math.min(limit, redacted.length);
      return redacted.length > limit ? redacted.slice(0, limit) + " [truncated]" : redacted;
    }
    if (value === null || typeof value === "boolean" || typeof value === "number") return value;
    if (typeof value !== "object") return clean(String(value), depth);
    if (depth >= 10) return "[depth limit]";
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    if (Array.isArray(value)) return value.slice(0, 8).map((item) => clean(item, depth + 1));
    return cleanObject(value, depth);
  };
  const record = { event: "herbie_failure", errorId, context: clean(context), error: clean(error) };
  const encoded = JSON.stringify(record);
  if (Buffer.byteLength(encoded) > 32_768)
    return {
      event: "herbie_failure",
      errorId,
      truncated: true,
      excerpt: Buffer.from(encoded).subarray(0, 12_000).toString("utf8"),
    };
  return record;
}
// Production stderr is captured by restricted container/runtime logging, never an API response.
export function logFailure(error: unknown, context: DiagnosticContext): string {
  const errorId = randomUUID();
  try {
    console.error(JSON.stringify(diagnosticRecord(error, context, errorId)));
  } catch {
    try {
      console.error(JSON.stringify({ event: "herbie_failure", errorId, loggingFailure: true }));
    } catch {
      /* Logging must not skip cleanup or alter execution. */
    }
  }
  return errorId;
}

const sandboxFailurePrefix = "herbie-sandbox-failure:";
// Explicit stdout transport: SDKs may omit stderr from their command result.
export function sandboxFailureOutput(error: unknown, component: string): string {
  return sandboxFailurePrefix + JSON.stringify(diagnosticRecord(error, { component })) + "\n";
}
export function parseSandboxFailure(output: string | undefined): unknown | undefined {
  if (!output || Buffer.byteLength(output) > 65_536) return undefined;
  const line = output.split("\n").find((value) => value.startsWith(sandboxFailurePrefix));
  if (!line || Buffer.byteLength(line) > 32_800) return undefined;
  try {
    const record: unknown = JSON.parse(line.slice(sandboxFailurePrefix.length));
    if (
      record &&
      typeof record === "object" &&
      "event" in record &&
      record.event === "herbie_failure"
    )
      return record;
  } catch {
    /* Malformed transport remains bounded command output for the host logger. */
  }
  return undefined;
}
