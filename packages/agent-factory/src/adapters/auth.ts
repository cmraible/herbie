import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
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
export class GoogleIdentity {
  constructor(private clientId: string, private keys: JWTVerifyGetKey = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'))) {}
  async verify(token: string, nonce: string) {
    const { payload } = await jwtVerify(token, this.keys, { audience: this.clientId,
      issuer: ['https://accounts.google.com', 'accounts.google.com'], algorithms: ['RS256'], requiredClaims: ['sub', 'exp', 'iat'] });
    if (!payload.sub || payload.email_verified !== true || typeof payload.hd !== 'string' || payload.nonce !== nonce)
      throw new HttpError(401, 'Verified company identity required');
    return { sub: payload.sub, domain: payload.hd.toLowerCase() };
  }
}
export class Access {
  constructor(private db: D1Database) {}
  async join(identity: { sub: string; domain: string }) {
    const domain = await this.db.prepare('SELECT workspace FROM company_domains WHERE domain=? AND enabled=1 AND verified_at>0')
      .bind(identity.domain).first<{ workspace: string }>();
    if (!domain) throw new HttpError(403, 'Company domain is not enabled');
    await this.db.prepare("INSERT OR IGNORE INTO members(workspace,sub,role) VALUES(?,?,'member')").bind(domain.workspace, identity.sub).run();
  }
  async session(req: Request) {
    const token = cookie(req, '__Host-herbie');
    if (!token) throw new HttpError(401, 'Sign in required');
    const row = await this.db.prepare('SELECT sub FROM sessions WHERE token_hash=? AND expires>?').bind(await hash(token), Date.now()).first<{ sub: string }>();
    if (!row) throw new HttpError(401, 'Session expired');
    return row.sub;
  }
  async member(sub: string, workspace: string, admin = false) {
    const row = await this.db.prepare('SELECT role FROM members WHERE sub=? AND workspace=?').bind(sub, workspace).first<{ role: string }>();
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
