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
}

const publicationStages = {
  preparing: { phase: "git_preparation", cause: "git_preparation_failed" },
  pushing: { phase: "branch_push", cause: "git_push_uncertain" },
  "opening-pr": { phase: "pull_request_creation", cause: "pull_request_uncertain" },
  published: { phase: "publication_confirmation", cause: "cleanup_failed" },
} satisfies Record<string, PublicationDiagnostic>;

const githubStatuses: Record<number, PublicationCause> = {
  401: "github_unauthorized",
  403: "github_forbidden",
  404: "github_not_found",
};

export function publicationDiagnostic(
  error: unknown,
  phase: PublicationPhase,
): PublicationDiagnostic {
  if (error instanceof PatchPublicationError) {
    return publicationStages[error.publication.stage];
  }
  if (error instanceof GithubError) {
    return { phase, cause: githubStatuses[error.status] ?? "github_unavailable" };
  }
  if (error instanceof StoreError)
    return { phase, cause: error.status === 409 ? "lease_conflict" : "database_failure" };
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
    return { phase, cause: "timeout" };
  if (error instanceof TypeError) return { phase, cause: "network_failure" };
  return { phase, cause: "unexpected" };
}

export function publicationDiagnosticMessage(diagnostic: PublicationDiagnostic): string {
  return `Publication remains unconfirmed during ${diagnostic.phase} (${diagnostic.cause}); reconciliation will check GitHub.`;
}
