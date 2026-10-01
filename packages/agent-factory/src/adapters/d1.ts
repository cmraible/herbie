import type { Goal } from '../core/model.js';
import type { GoalStore } from '../core/ports.js';
export class D1Goals implements GoalStore {
  constructor(private db: D1Database) {}
  async load(id: string) {
    const row = await this.db.prepare('SELECT body,revision FROM goals WHERE id=?').bind(id).first<{ body: string; revision: number }>();
    return row ? { goal: JSON.parse(row.body) as Goal, revision: row.revision } : undefined;
  }
  async save(g: Goal, revision: number) {
    const result = await this.db.prepare('UPDATE goals SET body=?,revision=revision+1 WHERE id=? AND workspace=? AND revision=?')
      .bind(JSON.stringify(g), g.id, g.workspace, revision).run();
    return result.meta.changes === 1;
  }
  async create(g: Goal) {
    // The quota check and insertion run in one SQL statement, avoiding concurrent over-allocation.
    const r = await this.db.prepare(`INSERT INTO goals(id,workspace,repo,body)
      SELECT ?,?,?,? WHERE (SELECT COUNT(*) FROM goals WHERE workspace=?) <
      (SELECT max_goals FROM workspaces WHERE id=? AND billing_status IN ('trial','active'))`)
      .bind(g.id, g.workspace, g.repo, JSON.stringify(g), g.workspace, g.workspace).run();
    if (!r.meta.changes) throw new Error('Workspace goal limit or billing restriction');
  }
  async list(workspace: string) {
    const rows = await this.db.prepare('SELECT body FROM goals WHERE workspace=? ORDER BY id').bind(workspace).all<{ body: string }>();
    return rows.results.map(r => JSON.parse(r.body) as Goal);
  }
}
