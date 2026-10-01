import type { Goal, PullRequest, Run } from '../src/core/model.js';
import type { Execution, ExecutionResult, GoalStore, Repository, VersionedGoal } from '../src/core/ports.js';
export class MemoryStore implements GoalStore {
  values = new Map<string, VersionedGoal>();
  constructor(goal: Goal) { this.values.set(goal.id, { goal: structuredClone(goal), revision: 0 }); }
  async load(id: string) { return structuredClone(this.values.get(id)); }
  async save(goal: Goal, revision: number) {
    if (this.values.get(goal.id)?.revision !== revision) return false;
    this.values.set(goal.id, { goal: structuredClone(goal), revision: revision + 1 }); return true;
  }
  async goal() { return (await this.load('g'))!.goal; }
}
export class FakeRepository implements Repository {
  prs: PullRequest[] = [];
  losePublishResponse = false;
  async inspect(_repo: string, number: number) { return structuredClone(this.prs.find(p => p.number === number)!); }
  async publish(_repo: string, run: Run) {
    let pr = this.prs.find(p => p.branch === run.branch);
    if (!pr) { pr = { number: this.prs.length + 1, branch: run.branch, head: 'abc', state: 'open', feedback: [] }; this.prs.push(pr); }
    if (this.losePublishResponse) { this.losePublishResponse = false; throw new Error('network lost after publish'); }
    return structuredClone(pr);
  }
}
export class FakeExecution implements Execution {
  result: ExecutionResult = { status: 'succeeded', checkpoint: 'abc' };
  jobs = new Set<string>();
  async advance(_g: Goal, r: Run) { this.jobs.add(`${r.id}/${r.attempt}`); return this.result; }
  async stop(_g: Goal, r: Run) { this.jobs.delete(`${r.id}/${r.attempt}`); }
}
