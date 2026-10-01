import { type CompanyIdentity, type CompanyStore, type DomainChallenge, type DomainProof, OnboardingError } from '../core/onboarding.js';
import { HttpError } from './auth.js';
export class D1Companies implements CompanyStore {
  constructor(private db: D1Database) {}
  async domainExists(domain: string) { return Boolean(await this.db.prepare('SELECT 1 FROM company_domains WHERE domain=?').bind(domain).first()); }
  async challenge(sub: string, domain: string) {
    return await this.db.prepare('SELECT id,sub,domain,workspace,name,token,expires FROM domain_challenges WHERE sub=? AND domain=? AND consumed=0').bind(sub, domain).first<DomainChallenge>() ?? undefined;
  }
  async saveChallenge(c: DomainChallenge) {
    await this.db.prepare(`INSERT INTO domain_challenges(id,sub,domain,workspace,name,token,expires) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(sub,domain) DO UPDATE SET id=excluded.id,workspace=excluded.workspace,name=excluded.name,token=excluded.token,expires=excluded.expires,consumed=0 WHERE domain_challenges.expires<?`)
      .bind(c.id,c.sub,c.domain,c.workspace,c.name,c.token,c.expires,Date.now()).run();
  }
  async provision(c: DomainChallenge, now: number) {
    try {
      const results = await this.db.batch([
        this.db.prepare('INSERT INTO workspaces(id,name) SELECT workspace,name FROM domain_challenges WHERE id=? AND sub=? AND expires>? AND consumed=0').bind(c.id,c.sub,now),
        this.db.prepare('INSERT INTO company_domains(domain,workspace,verified_at,enabled) SELECT ?,id,?,0 FROM workspaces WHERE id=?').bind(c.domain,now,c.workspace),
        this.db.prepare("INSERT INTO members(workspace,sub,role) SELECT id,?,'admin' FROM workspaces WHERE id=?").bind(c.sub,c.workspace),
        this.db.prepare('INSERT INTO workspace_audit(workspace,actor,action,detail,at) SELECT id,?,?,?,? FROM workspaces WHERE id=?').bind(c.sub,'company.verified',c.domain,now,c.workspace),
        this.db.prepare('UPDATE domain_challenges SET consumed=1 WHERE id=?').bind(c.id),
      ]);
      if (!results[0].meta.changes) throw new Error();
    } catch { throw new OnboardingError('conflict', 'Verification expired or the company was registered concurrently. Refresh to continue.'); }
  }
}
export class DnsOverHttps implements DomainProof {
  constructor(private transport: typeof fetch = globalThis.fetch.bind(globalThis)) {}
  async txt(name: string) {
    const url = new URL('https://cloudflare-dns.com/dns-query'); url.searchParams.set('name',name); url.searchParams.set('type','TXT');
    const response = await this.transport(url, { headers: { Accept: 'application/dns-json' }, signal: AbortSignal.timeout(10000), redirect: 'error' });
    if (!response.ok) throw new Error('DNS resolver unavailable');
    const data = await response.json() as { Status: number; Answer?: { name: string; type: number; data: string }[] };
    if (data.Status === 3) return []; // NXDOMAIN: propagation may be pending.
    if (data.Status !== 0) throw new Error('DNS resolver could not verify the domain');
    return (data.Answer ?? []).filter(a => a.type === 16 && a.name.toLowerCase().replace(/\.$/, '') === name.toLowerCase()).map(a => {
      // DNS TXT strings may be split into adjacent quoted fragments.
      try { return (a.data.match(/"(?:[^"\\]|\\.)*"/g) ?? []).map(part => JSON.parse(part) as string).join(''); }
      catch { return ''; }
    });
  }
}
export class WorkspaceAdmin {
  constructor(private db: D1Database) {}
  async identity(sub: string): Promise<CompanyIdentity> {
    const identity = await this.db.prepare('SELECT sub,domain,name,email FROM identities WHERE sub=?').bind(sub).first<CompanyIdentity>();
    if (!identity) throw new HttpError(401, 'Sign in again to verify your company identity');
    return identity;
  }
  async setDomain(actor: string, workspace: string, domain: string, enabled: boolean) {
    const result = await this.db.prepare(`UPDATE company_domains SET enabled=? WHERE workspace=? AND domain=? AND verified_at>0
      AND EXISTS(SELECT 1 FROM members WHERE workspace=? AND sub=? AND role='admin' AND status='active')`).bind(Number(enabled),workspace,domain,workspace,actor).run();
    if (!result.meta.changes) throw new HttpError(403,'Verified domain administrator access required');
    await this.audit(workspace,actor,'domain.enabled',JSON.stringify({domain,enabled}));
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
