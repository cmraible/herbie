import type {
  EnvironmentResources,
  Project,
  Repository,
  RepositoryDiscovery,
} from "@herbie/contracts";
import type { AgentAttemptChanges, DurableAttempt } from "@herbie/loop/agent-attempt";

export interface RepositoryAccess {
  repository: string;
  defaultBranch: string;
  installationId: number;
}
export interface Execution {
  agentSessionId?: string;
  durable?: DurableAttempt;
  onEnvironment?: (environment: { provider: string; id: string }) => Promise<void>;
  project: Project;
  repository: RepositoryAccess;
  attemptId: string;
  branch: string;
  signal?: AbortSignal;
  ciRepair?: CiFailure;
  onActivity?: (message: string, offset?: number) => Promise<void>;
  feedback?: PullRequestUpdate & { item: PullRequestFeedback; context: PullRequestFeedback[] };
}
export interface PullRequestFeedback {
  kind: "comment" | "inline" | "review";
  id: number;
  revision: string;
  author: string;
  bot?: boolean;
  body: string;
  url: string;
  state?: string;
  path?: string;
  line?: number | null;
  diff?: string;
  replyTo?: number;
}
export interface PullRequestUpdate {
  head: string;
  pullRequest: { number: number; url: string };
}
export interface CiFailure extends PullRequestUpdate {
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
export type PullRequest = NonNullable<Project["pullRequest"]>;
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
  durableSessions?: boolean;
  environmentLimits?(): Promise<Record<keyof EnvironmentResources, number | null>>;
  prepareEnvironment?(resources: EnvironmentResources | null): Promise<void>;

  pullRequestDiff?(userId: string, repository: string, number: number): Promise<string>;
  feedback?(execution: Execution): Promise<PullRequestFeedback[]>;
  acknowledgeFeedback?(execution: Execution, requireLease: () => Promise<void>): Promise<void>;
  replyToFeedback?(
    execution: Execution,
    body: string,
    requireLease: () => Promise<void>,
  ): Promise<void>;
  requestReview?(execution: Execution): Promise<void>;
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
  ): Promise<AgentAttemptChanges>;
  // Recheck ownership after awaited preparation and immediately before each remote write.
  publish(
    execution: Execution,
    changes: AgentAttemptChanges,
    requireLease: () => Promise<void>,
    reportPhase?: (phase: PublicationPhase) => Promise<void>,
  ): Promise<Omit<PullRequest, "state"> & { state?: PullRequest["state"] }>;
  checkUnpublished?(
    execution: Execution,
  ): Promise<"absent" | "pull_request_exists" | "branch_exists">;
  checkPublicationRetry?(
    execution: Execution,
    changes: AgentAttemptChanges,
  ): Promise<PublicationRetryCheck>;
  reconcile(execution: Execution): Promise<PullRequest | null>;
}
