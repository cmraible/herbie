import { DurableObject } from 'cloudflare:workers';
import { HttpError } from '../adapters/auth.js';
import { GitHub } from '../adapters/github.js';
import { D1Goals } from '../adapters/d1.js';
import { DaytonaExecution } from '../adapters/daytona.js';
import { Factory } from '../core/engine.js';
import { change } from '../core/ports.js';
import { record } from '../core/model.js';
import { github } from './services.js';
import type { AppEnv } from './env.js';
export class GoalCoordinator extends DurableObject<AppEnv> {
  async wake(id: string) {
    await this.ctx.storage.put('goal', id);
    if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now() + 1);
  }
  async alarm() {
    const id = await this.ctx.storage.get<string>('goal');
    if (!id) return;
    // Schedule recovery before any external side effect. Cron also repairs lost wakeups.
    await this.ctx.storage.setAlarm(Date.now() + 30000);
        const store = new D1Goals(this.env.DB);
    const entry = await store.load(id);
    if (!entry) { await this.ctx.storage.deleteAlarm(); return; }
    if (this.env.FACTORY_ENABLED !== 'true') {
      if (!entry.goal.runs.some(r => !['done', 'failed'].includes(r.status))) return;
      await change(store, id, g => { g.status = 'paused'; g.reason = 'Factory execution disabled'; });
      entry.goal.status = 'paused';
    }
    try {
      const executor = new DaytonaExecution({ apiKey: this.env.DAYTONA_API_KEY, snapshot: this.env.DAYTONA_SNAPSHOT,
        origin: this.env.APP_ORIGIN, tokenSecret: this.env.RUN_TOKEN_SECRET, model: this.env.CODEX_MODEL });
      let repo: GitHub;
      if (entry.goal.status === 'paused') {
        // Factory's paused path does not call the repository adapter.
        repo = new GitHub(this.env.GITHUB_APP_ID, this.env.GITHUB_APP_PRIVATE_KEY, 0);
      } else {
        try { repo = await github(this.env, entry.goal.workspace, entry.goal.repo); }
        catch (e) {
          if (!(e instanceof HttpError) || e.status !== 403) throw e;
          await change(store, id, g => { g.status = 'paused'; g.reason = 'Repository connection or billing disabled'; record(g, Date.now(), g.reason); });
          repo = new GitHub(this.env.GITHUB_APP_ID, this.env.GITHUB_APP_PRIVATE_KEY, 0);
        }
      }
      await new Factory(store, repo, executor).tick(id);
      await this.ctx.storage.delete('failures');
    } catch {
      // Provider errors may contain credentials, headers or customer output: never log raw errors.
      const failures = (await this.ctx.storage.get<number>('failures') ?? 0) + 1;
      await this.ctx.storage.put('failures', failures);
      if (failures >= 3) await change(store, id, g => {
        g.status = 'paused'; g.reason = 'Provider operation repeatedly failed; inspect configuration and resume manually';
        record(g, Date.now(), g.reason);
      });
      await this.ctx.storage.setAlarm(Date.now() + Math.min(300000, failures * 30000));
    }
  }
}
