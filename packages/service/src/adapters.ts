import type { Goal, Repository } from '@herbie/contracts';
import type { DaytonaAttemptChanges } from '@herbie/loop/daytona-attempt';

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
}
export interface PullRequest {
  url: string;
  number: number;
  branch: string;
  state: 'open' | 'closed' | 'merged';
}
export class KnownAttemptFailure extends Error {}
export interface Adapters {
  mode: 'demo' | 'live';
  authorize(userId: string, repository: string): Promise<RepositoryAccess>;
  reconciliationRepository(repository: string): Promise<RepositoryAccess>;
  repositories(userId: string): Promise<Repository[]>;
  attempt(execution: Execution, report: (message: string) => Promise<void>): Promise<DaytonaAttemptChanges>;
  // Recheck ownership after awaited preparation and immediately before each remote write.
  publish(execution: Execution, changes: DaytonaAttemptChanges, requireLease: () => Promise<void>): Promise<Omit<PullRequest, 'state'>>;
  reconcile(execution: Execution): Promise<PullRequest | null>;
}
