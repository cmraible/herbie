import { PatchPublicationError } from "@herbie/loop/publish-patch";
import { GithubError } from "./github.js";
import { StoreError } from "./store.js";
import type { PublicationPhase } from "./adapters.js";

export type PublicationCause =
  | "github_unauthorized"
  | "github_forbidden"
  | "github_not_found"
  | "github_unavailable"
  | "git_preparation_failed"
  | "git_push_uncertain"
  | "workflow_permission_missing"
  | "pull_request_uncertain"
  | "cleanup_failed"
  | "lease_conflict"
  | "timeout"
  | "network_failure"
  | "database_failure"
  | "pull_request_not_found"
  | "unexpected";
export interface PublicationDiagnostic {
  phase: PublicationPhase;
  cause: PublicationCause;
  workflow?: string;
}

export function publicationDiagnostic(
  error: unknown,
  phase: PublicationPhase,
): PublicationDiagnostic {
  if (error instanceof PatchPublicationError) {
    if (error.publication.stage === "preparing")
      return { phase: "git_preparation", cause: "git_preparation_failed" };
    if (error.publication.stage === "pushing") {
      for (const failure of error.errors) {
        if (
          !(failure instanceof Error) ||
          !("stdout" in failure) ||
          typeof failure.stdout !== "string"
        )
          continue;
        const match =
          /\[remote rejected\] \(refusing to allow a GitHub App to create or update workflow `([^`\r\n]+)` without `workflows` permission\)/.exec(
            failure.stdout,
          );
        if (match) {
          // Only expose a bounded workflow filename, never arbitrary remote output.
          const workflow = /^\.github\/workflows\/[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,200}\.ya?ml$/.test(
            match[1],
          )
            ? match[1]
            : undefined;
          return {
            phase: "branch_push",
            cause: "workflow_permission_missing",
            ...(workflow ? { workflow } : {}),
          };
        }
      }
      return { phase: "branch_push", cause: "git_push_uncertain" };
    }
    if (error.publication.stage === "opening-pr")
      return { phase: "pull_request_creation", cause: "pull_request_uncertain" };
    return { phase: "publication_confirmation", cause: "cleanup_failed" };
  }
  if (error instanceof GithubError) {
    if (error.status === 401) return { phase, cause: "github_unauthorized" };
    if (error.status === 403) return { phase, cause: "github_forbidden" };
    if (error.status === 404) return { phase, cause: "github_not_found" };
    return { phase, cause: "github_unavailable" };
  }
  if (error instanceof StoreError)
    return { phase, cause: error.status === 409 ? "lease_conflict" : "database_failure" };
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
    return { phase, cause: "timeout" };
  if (error instanceof TypeError) return { phase, cause: "network_failure" };
  return { phase, cause: "unexpected" };
}

export function publicationDiagnosticMessage(diagnostic: PublicationDiagnostic): string {
  if (diagnostic.cause === "workflow_permission_missing")
    return `workflow_permission_missing${diagnostic.workflow ? ` (${diagnostic.workflow})` : ""}`;
  return `Publication remains unconfirmed during ${diagnostic.phase} (${diagnostic.cause}); reconciliation will check GitHub.`;
}
