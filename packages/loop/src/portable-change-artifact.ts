import { MAX_PATCH_BYTES } from "./artifact-limits.js";

export const PORTABLE_CHANGE_ARTIFACT_VERSION = 1 as const;
export type GitFileMode = "100644" | "100755" | "120000";

export interface PortableChange {
  path: string;
  /** The entry at baseCommit, or null when this path did not exist. */
  expectedBase: { mode: GitFileMode; objectId: string } | null;
  /** The final blob, or null when this path is deleted. */
  final: { mode: GitFileMode; contentBase64: string } | null;
}

export interface PortableChangeArtifact {
  version: typeof PORTABLE_CHANGE_ARTIFACT_VERSION;
  changes: PortableChange[];
}

const objectId = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const validMode = (mode: unknown): mode is GitFileMode =>
  mode === "100644" || mode === "100755" || mode === "120000";

/** Validate an untrusted artifact before it is associated with a captured base. */
export function parsePortableChangeArtifact(value: unknown): PortableChangeArtifact {
  if (!value || typeof value !== "object") throw new Error("Invalid portable change artifact");
  const artifact = value as Record<string, unknown>;
  if (
    artifact.version !== PORTABLE_CHANGE_ARTIFACT_VERSION ||
    !Array.isArray(artifact.changes) ||
    artifact.changes.length > 10_000
  )
    throw new Error("Invalid portable change artifact");
  let totalBytes = 0;
  const paths = new Set<string>();
  const changes = artifact.changes.map((item): PortableChange => {
    if (!item || typeof item !== "object") throw new Error("Invalid portable change");
    const change = item as Record<string, unknown>;
    const path = change.path;
    if (
      typeof path !== "string" ||
      !path ||
      path.startsWith("/") ||
      path.includes("\\") ||
      path.split("/").some((part) => !part || part === "." || part === "..") ||
      path.includes("\0") ||
      paths.has(path)
    )
      throw new Error("Invalid or duplicate portable change path");
    paths.add(path);
    let expectedBase: PortableChange["expectedBase"];
    if (change.expectedBase === null) expectedBase = null;
    else {
      const entry = change.expectedBase as Record<string, unknown>;
      if (
        !entry ||
        !validMode(entry.mode) ||
        typeof entry.objectId !== "string" ||
        !objectId.test(entry.objectId)
      )
        throw new Error("Invalid expected base entry");
      expectedBase = { mode: entry.mode, objectId: entry.objectId };
    }
    let final: PortableChange["final"];
    if (change.final === null) final = null;
    else {
      const entry = change.final as Record<string, unknown>;
      if (!entry || !validMode(entry.mode) || typeof entry.contentBase64 !== "string")
        throw new Error("Invalid final file entry");
      if (entry.contentBase64.length > Math.ceil(MAX_PATCH_BYTES / 3) * 4)
        throw new Error("Portable change artifact exceeds its byte limit");
      let decoded: string;
      try {
        decoded = atob(entry.contentBase64);
      } catch {
        throw new Error("Invalid portable file encoding");
      }
      if (btoa(decoded) !== entry.contentBase64) throw new Error("Invalid portable file encoding");
      totalBytes += decoded.length;
      if (totalBytes > MAX_PATCH_BYTES)
        throw new Error("Portable change artifact exceeds its byte limit");
      final = { mode: entry.mode, contentBase64: entry.contentBase64 };
    }
    if (expectedBase === null && final === null) throw new Error("Empty portable change");
    return { path, expectedBase, final };
  });
  return { version: PORTABLE_CHANGE_ARTIFACT_VERSION, changes };
}
