import { DurableObject } from 'cloudflare:workers';
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
    if (this.env.FACTORY_ENABLED !== 'true') return;
    const store = new D1Goals(this.env.DB);
    const entry = await store.load(id);
    if (!entry) { await this.ctx.storage.deleteAlarm(); return; }
    try {
      const repo = await github(this.env, entry.goal.workspace, entry.goal.repo);
      const executor = new DaytonaExecution({ apiKey: this.env.DAYTONA_API_KEY, snapshot: this.env.DAYTONA_SNAPSHOT,
        origin: this.env.APP_ORIGIN, tokenSecret: this.env.RUN_TOKEN_SECRET, model: this.env.CODEX_MODEL });
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
