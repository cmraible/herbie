import type { Goal, Repository, RepositoryDiscovery } from "@herbie/contracts";
import type { DaytonaAttemptChanges } from "@herbie/loop/daytona-attempt";

export interface RepositoryAccess {
  repository: string;
  defaultBranch: string;
  installationId: number;
}
export interface Execution {
  goal: Goal;
  repository: RepositoryAccess;
  attemptId: string;
  branch: string;
  signal?: AbortSignal;
  ciRepair?: CiFailure;
}
export interface CiFailure {
  head: string;
  pullRequest: { number: number; url: string };
  details: string;
}
export type CiStatus =
  | (CiFailure & { state: "failed" })
  | {
      state: "passed";
      draft: boolean;
      head: string;
      pullRequest: { number: number; url: string };
    };
export type PullRequest = NonNullable<Goal["pullRequest"]>;
export type PublicationPhase =
  | "preflight_reconciliation"
  | "authorization"
  | "installation_token"
  | "existing_pr_check"
  | "git_preparation"
  | "branch_push"
  | "pull_request_creation"
  | "publication_confirmation"
  | "state_persistence";
export type PublicationRetryCheck =
  | "ready"
  | "pull_request_exists"
  | "branch_exists"
  | "base_changed";
export class KnownAttemptFailure extends Error {}
export class PublicationBlockedError extends Error {}
export class StaleRepairError extends Error {}
export interface Adapters {
  mode: "demo" | "live";
  readinessState?(execution: Execution): Promise<"ready" | "draft" | "closed">;
  ciStatus?(execution: Execution): Promise<CiStatus | null>;
  markReady?(
    execution: Execution,
    head: string,
    beforeWrite: () => Promise<void>,
  ): Promise<boolean>;
  authorize(userId: string, repository: string): Promise<RepositoryAccess>;
  reconciliationRepository(repository: string): Promise<RepositoryAccess>;
  repositories(userId: string): Promise<Repository[]>;
  discoverRepositories?(userId: string): Promise<RepositoryDiscovery>;
  attempt(
    execution: Execution,
    report: (message: string) => Promise<void>,
  ): Promise<DaytonaAttemptChanges>;
  // Recheck ownership after awaited preparation and immediately before each remote write.
  publish(
    execution: Execution,
    changes: DaytonaAttemptChanges,
    requireLease: () => Promise<void>,
    reportPhase?: (phase: PublicationPhase) => Promise<void>,
  ): Promise<Omit<PullRequest, "state"> & { state?: PullRequest["state"] }>;
  checkUnpublished?(
    execution: Execution,
  ): Promise<"absent" | "pull_request_exists" | "branch_exists">;
  checkPublicationRetry?(
    execution: Execution,
    changes: DaytonaAttemptChanges,
  ): Promise<PublicationRetryCheck>;
  reconcile(execution: Execution): Promise<PullRequest | null>;
}
