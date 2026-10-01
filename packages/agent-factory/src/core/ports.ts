import type { ChangeSummary } from './policy.js';
import type { Goal, PullRequest, Run } from './model.js';
export interface VersionedGoal { revision: number; goal: Goal }
export interface GoalStore {
  load(id: string): Promise<VersionedGoal | undefined>;
  save(goal: Goal, revision: number): Promise<boolean>;
}
export interface Repository {
  inspect(repo: string, pr: number): Promise<PullRequest>;
  publish(repo: string, run: Run): Promise<PullRequest>;
}
export type ExecutionResult = { status: 'running' } | { status: 'succeeded'; checkpoint: string; summary?: ChangeSummary } | { status: 'lost' | 'failed' };
export interface Execution {
  /** Idempotently start or inspect one attempt. External resources use run.id + attempt. */
  advance(goal: Goal, run: Run): Promise<ExecutionResult>;
  /** Must confirm termination before the next attempt or releasing capacity. */
  stop(goal: Goal, run: Run): Promise<void>;
}
export async function change<T>(store: GoalStore, id: string, fn: (g: Goal) => T): Promise<T> {
  for (let i = 0; i < 20; i++) {
    const value = await store.load(id);
    if (!value) throw new Error('Goal not found');
    const result = fn(value.goal);
    if (await store.save(value.goal, value.revision)) return result;
  }
  throw new Error('Concurrent update; retry');
}
