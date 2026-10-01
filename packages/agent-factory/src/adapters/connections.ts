import type { GitHubAuthorization, RepositoryGrant } from '../core/connections.js';
import { Access, hash, HttpError } from './auth.js';
export class Connections {
  constructor(private db: D1Database, private provider: GitHubAuthorization, private now = () => Date.now()) {}
  async begin(sub: string, workspace: string, session: string) {
    await new Access(this.db).member(sub,workspace,true);
    await this.requireSession(sub,session);
    const state = crypto.randomUUID()+crypto.randomUUID(), verifier = crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-','');
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier)));
    const challenge = btoa(String.fromCharCode(...digest)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
    await this.db.prepare('INSERT INTO github_states(hash,sub,workspace,verifier,expires,session_hash) VALUES(?,?,?,?,?,?)').bind(await hash(state),sub,workspace,verifier,this.now()+10*60000,session).run();
    return {url:this.provider.authorizationUrl(state,challenge)};
  }
  async complete(sub: string, state: string, code: string, session: string) {
    await this.requireSession(sub,session);
    const row = await this.db.prepare('SELECT workspace FROM github_states WHERE hash=? AND sub=? AND expires>? AND session_hash=?').bind(await hash(state),sub,this.now(),session).first<{workspace:string}>();
    if (!row) throw new HttpError(400,'GitHub connection request expired or does not belong to this session');
    await new Access(this.db).member(sub,row.workspace,true);
    const consumed = await this.db.prepare('DELETE FROM github_states WHERE hash=? AND sub=? AND expires>? AND session_hash=? RETURNING verifier').bind(await hash(state),sub,this.now(),session).first<{verifier:string}>();
    if (!consumed) throw new HttpError(400,'GitHub connection request already used');
    const grants = await this.provider.repositories(code,consumed.verifier);
    if (!grants.length) throw new HttpError(403,'No installations you administer were found. Install the app and authorize organization access first.');
    const id = crypto.randomUUID();
    await this.db.prepare('INSERT INTO github_proposals(id,sub,workspace,body,expires) VALUES(?,?,?,?,?)').bind(id,sub,row.workspace,JSON.stringify(grants),this.now()+10*60000).run();
    return {workspace:row.workspace};
  }
  private async requireSession(sub:string,session:string) {
    const active=await this.db.prepare('SELECT 1 FROM sessions WHERE token_hash=? AND sub=? AND expires>?').bind(session,sub,this.now()).first();
    if (!active) throw new HttpError(401,'Session expired');
  }
  async list(sub:string,workspace:string) {
    await new Access(this.db).member(sub,workspace,true);
    const rows = await this.db.prepare('SELECT id,body,expires FROM github_proposals WHERE sub=? AND workspace=? AND expires>? AND consumed=0').bind(sub,workspace,this.now()).all<{id:string;body:string;expires:number}>();
    return rows.results.map(r=>({id:r.id,expires:r.expires,repositories:JSON.parse(r.body) as RepositoryGrant[]}));
  }
  async accept(sub:string,workspace:string,id:string,repos:string[]) {
    await new Access(this.db).member(sub,workspace,true);
    if (!Array.isArray(repos) || repos.length<1 || repos.length>100 || repos.some(r=>typeof r!=='string') || new Set(repos).size!==repos.length) throw new HttpError(400,'Select 1–100 distinct repositories');
    const now = this.now();
    const proposal = await this.db.prepare('SELECT body FROM github_proposals WHERE id=? AND sub=? AND workspace=? AND expires>? AND consumed=0').bind(id,sub,workspace,now).first<{body:string}>();
    if (!proposal) throw new HttpError(400,'Repository selection expired or already used');
    const grants = JSON.parse(proposal.body) as RepositoryGrant[];
    const selected = repos.map(repo=>grants.find(g=>g.repo===repo));
    if (selected.some(g=>!g)) throw new HttpError(403,'Repository was not authorized by GitHub');
    try {
      // The NOT NULL audit workspace is a transaction gate: stale proposals or revoked
      // admins abort the entire batch before any grant, consumption, or audit commits.
      await this.db.batch([
        this.db.prepare(`INSERT INTO workspace_audit(workspace,actor,action,detail,at)
          VALUES((SELECT workspace FROM github_proposals WHERE id=? AND sub=? AND workspace=? AND expires>? AND consumed=0
          AND EXISTS(SELECT 1 FROM members WHERE workspace=? AND sub=? AND role='admin' AND status='active')),?,?,?,?)`)
          .bind(id,sub,workspace,now,workspace,sub,sub,'github.connected',JSON.stringify(repos),now),
        ...selected.map(g=>this.db.prepare(`INSERT INTO repositories(workspace,repo,installation,enabled) VALUES(?,?,?,0)
          ON CONFLICT(workspace,repo) DO UPDATE SET installation=excluded.installation,enabled=0`)
          .bind(workspace,g!.repo,g!.installation)),
        this.db.prepare('UPDATE github_proposals SET consumed=1 WHERE id=?').bind(id),
      ]);
    } catch { throw new HttpError(409,'Repository already belongs to another workspace, or access/selection changed. Start the connection again.'); }
  }
}
