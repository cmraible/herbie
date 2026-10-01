import type { CompanyIdentity } from '../core/onboarding.js';
import { Access, hash, HttpError } from './auth.js';

export class PrivateWorkspaces {
  constructor(private db: D1Database) {}
  async create(sub: string, name: string) {
    if (!name.trim() || name.length > 120) throw new HttpError(400,'Workspace name must contain 1–120 characters');
    await new WorkspaceAdmin(this.db).identity(sub);
    const workspace = 'private-' + await hash(sub);
    // D1 batches are atomic. The receipt is inserted last, so every earlier write
    // happens only on the first creation. Retries cannot restore revoked membership.
    await this.db.batch([
      this.db.prepare('INSERT INTO workspaces(id,name) SELECT ?,? WHERE NOT EXISTS(SELECT 1 FROM private_workspaces WHERE sub=?)').bind(workspace,name.trim(),sub),
      this.db.prepare("INSERT INTO members(workspace,sub,role) SELECT ?,?,'admin' WHERE NOT EXISTS(SELECT 1 FROM private_workspaces WHERE sub=?)").bind(workspace,sub,sub),
      this.db.prepare("INSERT INTO workspace_audit(workspace,actor,action,detail,at) SELECT ?,?,'workspace.created','private',? WHERE NOT EXISTS(SELECT 1 FROM private_workspaces WHERE sub=?)").bind(workspace,sub,Date.now(),sub),
      this.db.prepare('INSERT OR IGNORE INTO private_workspaces(sub,workspace) VALUES(?,?)').bind(sub,workspace),
    ]);
    const receipt = await this.db.prepare('SELECT workspace FROM private_workspaces WHERE sub=?').bind(sub).first<{workspace:string}>();
    if (!receipt) throw new HttpError(500,'Workspace creation could not be confirmed');
    await new Access(this.db).member(sub,receipt.workspace);
    return { workspace: receipt.workspace };
  }
}

export class WorkspaceAdmin {
  constructor(private db: D1Database) {}
  async identity(sub: string): Promise<CompanyIdentity> {
    const identity = await this.db.prepare('SELECT sub,domain,name,email FROM identities WHERE sub=?').bind(sub).first<CompanyIdentity>();
    if (!identity) throw new HttpError(401, 'Sign in again to verify your identity');
    return identity;
  }
  async setMember(actor: string, workspace: string, sub: string, role: string, status: string) {
    if (!['admin','member'].includes(role) || !['active','suspended'].includes(status)) throw new HttpError(400,'Invalid member settings');
    // The last active administrator cannot be demoted/suspended, including concurrent requests.
    const result = await this.db.prepare(`UPDATE members SET role=?,status=? WHERE workspace=? AND sub=?
      AND EXISTS(SELECT 1 FROM members WHERE workspace=? AND sub=? AND role='admin' AND status='active')
      AND (role!='admin' OR status!='active' OR (?='admin' AND ?='active') OR
        (SELECT COUNT(*) FROM members WHERE workspace=? AND role='admin' AND status='active')>1)`)
      .bind(role,status,workspace,sub,workspace,actor,role,status,workspace).run();
    if (!result.meta.changes) throw new HttpError(409,'Member unavailable, access changed, or this would remove the last administrator');
    await this.audit(workspace,actor,'member.updated',JSON.stringify({sub,role,status}));
  }
  async audit(workspace: string, actor: string, action: string, detail: string) {
    await this.db.prepare('INSERT INTO workspace_audit(workspace,actor,action,detail,at) VALUES(?,?,?,?,?)').bind(workspace,actor,action,detail,Date.now()).run();
  }
}
