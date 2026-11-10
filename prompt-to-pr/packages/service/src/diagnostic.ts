export function redactDiagnostic(value: string, secrets: string[] = []) {
  let text = value;
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    text = text.split(secret).join("[redacted]");
    text = text
      .split(Buffer.from(`x-access-token:${secret}`).toString("base64"))
      .join("[redacted]");
  }
  return text
    .replace(
      /-----BEGIN[\s\S]*?PRIVATE KEY-----[\s\S]*?-----END[\s\S]*?PRIVATE KEY-----/g,
      "[redacted key]",
    )
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+)\b/g,
      "[redacted token]",
    )
    .replace(/(authorization\s*[:=]\s*)(?:bearer|basic)\s+[^\s"']+/gi, "$1[redacted]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, "$1[redacted]@")
    .slice(-8000);
}

export class ExecutionError extends Error {
  constructor(public diagnostic: { exitCode?: number; output: string }) {
    super("Sandbox execution failed");
  }
}
