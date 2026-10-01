import { HttpError } from './auth.js';
import type { GitHubAuthorization, RepositoryGrant } from '../core/connections.js';
/** OAuth proves GitHub authority separately from Herbie workspace administration. */
export class GitHubAuthorizationClient implements GitHubAuthorization {
  constructor(private config: { clientId: string; secret: string; redirect: string; appId: string }, private transport: typeof fetch = globalThis.fetch.bind(globalThis)) {}
  authorizationUrl(state: string, challenge: string) {
    const url = new URL('https://github.com/login/oauth/authorize');
    for (const [key,value] of Object.entries({client_id:this.config.clientId,redirect_uri:this.config.redirect,state,code_challenge:challenge,code_challenge_method:'S256'})) url.searchParams.set(key,value);
    return url.toString();
  }
  async repositories(code: string, verifier: string): Promise<RepositoryGrant[]> {
    const response = await this.transport('https://github.com/login/oauth/access_token', { method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { Accept:'application/json','Content-Type':'application/json' }, body: JSON.stringify({client_id:this.config.clientId,client_secret:this.config.secret,redirect_uri:this.config.redirect,code,code_verifier:verifier}) });
    if (!response.ok) throw new Error('GitHub authorization failed');
    const auth = await response.json() as {access_token?:string};
    if (!auth.access_token) throw new Error('GitHub authorization failed');
    const token = auth.access_token; // Transient: never persisted, returned to the browser, or logged.
    let missingAuthority=false;
    const request = async <T>(path: string, optional = false): Promise<T | undefined> => {
      const r = await this.transport('https://api.github.com'+path,{ signal:AbortSignal.timeout(15000),headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','User-Agent':'herbie-agent-factory','X-GitHub-Api-Version':'2022-11-28'} });
      if (optional && [403,404].includes(r.status)) { missingAuthority=true; return undefined; }
      if (!r.ok) throw new Error('GitHub authority verification failed');
      return await r.json() as T;
    };
    const user = (await request<{id:number}>('/user'))!;
    const grants: RepositoryGrant[] = [];
    for (let page=1; page<=10; page++) {
      const result = (await request<{installations:{id:number;app_id:number;account:{id:number;login:string;type:string};suspended_at:string|null}[]}>(`/user/installations?per_page=100&page=${page}`))!;
      for (const install of result.installations) {
        if (String(install.app_id)!==this.config.appId || install.suspended_at) continue;
        let owner = install.account.type==='User' && install.account.id===user.id;
        if (install.account.type==='Organization') {
          const membership = await request<{role:string;state:string}>(`/user/memberships/orgs/${encodeURIComponent(install.account.login)}`,true);
          owner = membership?.role==='admin' && membership.state==='active';
        }
        if (!owner) continue;
        for (let repoPage=1; repoPage<=10; repoPage++) {
          const repos = (await request<{repositories:{full_name:string;owner:{id:number}}[]}>(`/user/installations/${install.id}/repositories?per_page=100&page=${repoPage}`))!;
          for (const repo of repos.repositories) if (repo.owner.id===install.account.id && /^[\w.-]+\/[\w.-]+$/.test(repo.full_name)) grants.push({repo:repo.full_name,installation:install.id,account:install.account.login});
          if (repos.repositories.length<100) break;
          if (repoPage===10) throw new Error('Too many repositories; restrict installation selection');
        }
      }
      if (result.installations.length<100) {
        if (!grants.length && missingAuthority) throw new HttpError(403,'GitHub could not verify organization administration. Configure the app with organization Members: read permission, approve updated permissions, and authorize organization access.');
        return grants;
      }
    }
    throw new Error('Too many installations; narrow GitHub authorization');
  }
}
