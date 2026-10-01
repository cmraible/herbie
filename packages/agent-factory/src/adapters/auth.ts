import type { CompanyIdentity } from '../core/onboarding.js';
export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
export async function hash(value: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), x => x.toString(16).padStart(2, '0')).join('');
}
export function cookie(req: Request, name: string) {
  return req.headers.get('cookie')?.split(';').map(s => s.trim()).find(s => s.startsWith(`${name}=`))?.slice(name.length + 1);
}
export function requireOrigin(req: Request, origin: string) {
  if (req.headers.get('origin') !== origin) throw new HttpError(403, 'Origin rejected');
}
export class Access {
  constructor(private db: D1Database) {}
  async signIn(identity: CompanyIdentity) {
    await this.db.prepare('INSERT INTO identities(sub,domain,name,email,verified_at) VALUES(?,?,?,?,?) ON CONFLICT(sub) DO UPDATE SET domain=excluded.domain,name=excluded.name,email=excluded.email,verified_at=excluded.verified_at').bind(identity.sub,identity.domain,identity.name,identity.email,Date.now()).run();
    const enabled = await this.db.prepare('SELECT 1 FROM company_domains WHERE domain=? AND enabled=1 AND verified_at>0').bind(identity.domain).first();
    if (enabled) await this.join(identity);
  }
  async join(identity: { sub: string; domain: string }) {
    const domain = await this.db.prepare('SELECT workspace FROM company_domains WHERE domain=? AND enabled=1 AND verified_at>0')
      .bind(identity.domain).first<{ workspace: string }>();
    if (!domain) throw new HttpError(403, 'Company domain is not enabled');
    await this.db.prepare("INSERT OR IGNORE INTO members(workspace,sub,role) VALUES(?,?,'member')").bind(domain.workspace, identity.sub).run();
  }
  async member(sub: string, workspace: string, admin = false) {
    const row = await this.db.prepare("SELECT role FROM members WHERE sub=? AND workspace=? AND status='active'").bind(sub, workspace).first<{ role: string }>();
    if (!row || (admin && row.role !== 'admin')) throw new HttpError(403, 'Workspace access denied');
    return row.role;
  }
  async repository(workspace: string, repo: string) {
    const row = await this.db.prepare(`SELECT r.installation FROM repositories r JOIN workspaces w ON w.id=r.workspace
      WHERE r.workspace=? AND r.repo=? AND r.enabled=1 AND w.billing_status IN ('trial','active')`)
      .bind(workspace, repo).first<{ installation: number }>();
    if (!row) throw new HttpError(403, 'Repository connection disabled');
    return row.installation;
  }
}
