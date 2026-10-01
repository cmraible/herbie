import { active, record, reserve, type Goal, type Run } from './model.js';
import { change, type Execution, type GoalStore, type Repository } from './ports.js';

/** Short durable ticks: never waits for a coding process to finish. */
export class Factory {
  constructor(private store: GoalStore, private repos: Repository, private executor: Execution,
    private now = () => Date.now()) {}

  async tick(id: string): Promise<void> {
    const owner = crypto.randomUUID();
    const claimed = await change(this.store, id, g => {
      if (g.lease && g.lease.until > this.now()) return false;
      g.lease = { owner, until: this.now() + 300000 }; return true;
    });
    if (!claimed) return;
    const update = <T>(fn: (g: Goal) => T) => change(this.store, id, g => {
      if (g.lease?.owner !== owner) throw new Error('Lease lost');
      g.lease.until = this.now() + 300000;
      return fn(g);
    });
    try {
      let g = (await this.store.load(id))!.goal;
      // Reconcile provider truth, including after missed or reordered webhooks.
      for (const known of g.prs.filter(p => p.state === 'open')) {
        const actual = await this.repos.inspect(g.repo, known.number);
        await update(s => {
          const p = s.prs.find(p => p.number === actual.number)!;
          p.state = actual.state; p.head = actual.head;
          if (actual.state === 'closed') {
            s.status = 'paused'; s.reason = `PR #${p.number} closed without merge`;
            record(s, this.now(), s.reason);
          }
        });
      }
      await update(s => reserve(s, this.now()));
      g = (await this.store.load(id))!.goal;
      // One in-flight operation per goal also guarantees serial work per PR.
      const run = g.runs.find(active);
      if (!run) return;
      if (g.status === 'paused' || (run.pr && g.prs.find(p => p.number === run.pr)?.state !== 'open')) {
        await this.executor.stop(g, run);
        await update(s => { s.runs.find(r => r.id === run.id)!.status = 'failed'; });
        return;
      }
      if (run.status === 'publishing') {
        await this.executor.stop(g, run);
        const pr = await this.repos.publish(g.repo, run);
        await update(s => {
          const r = s.runs.find(r => r.id === run.id)!;
          const existing = s.prs.find(p => p.number === pr.number);
          if (existing) { existing.state = pr.state; existing.head = pr.head; }
          else s.prs.push(pr);
          if (pr.state === 'closed') { s.status = 'paused'; s.reason = `PR #${pr.number} closed without merge`; }
          r.pr = pr.number; r.status = 'done';
          record(s, this.now(), `PR #${pr.number} ready for review`);
        });
        return;
      }
      if (run.startedAt && this.now() - run.startedAt > 30 * 60000) {
        await this.retry(g, run, update); return;
      }
      await update(s => {
        const r = s.runs.find(r => r.id === run.id)!;
        r.status = 'running'; r.startedAt ??= this.now();
      });
      const result = await this.executor.advance(g, run);
      if (result.status === 'failed' || result.status === 'lost') {
        await this.retry(g, run, update);
      } else if (result.status === 'succeeded') {
        // Checkpoint is persisted outside the VM before cleanup or PR publication.
        await update(s => {
          const r = s.runs.find(r => r.id === run.id)!;
          r.checkpoint = result.checkpoint; r.status = 'publishing';
        });
        await this.executor.stop(g, run);
      }
    } finally {
      await change(this.store, id, g => { if (g.lease?.owner === owner) delete g.lease; });
    }
  }
  private async retry(g: Goal, run: Run, update: <T>(fn: (g: Goal) => T) => Promise<T>) {
    await this.executor.stop(g, run);
    await update(s => {
      const r = s.runs.find(r => r.id === run.id)!;
      if (r.attempt >= 3) {
        r.status = 'failed'; s.status = 'paused'; s.reason = `Run ${r.id} exhausted 3 attempts; human intervention required`;
        record(s, this.now(), s.reason);
      } else {
        r.attempt++; r.status = 'queued'; delete r.startedAt;
        record(s, this.now(), `Recovering ${r.id}, attempt ${r.attempt}`);
      }
    });
  }
}
