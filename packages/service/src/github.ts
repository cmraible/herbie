import { createHmac, createSign, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Repository } from '@herbie/contracts';
import type { PullRequest, RepositoryAccess } from './adapters.js';

export interface GithubConfig {
  appId: string; clientId: string; clientSecret: string; privateKey: string;
  callbackUrl: string; webhookSecret: string;
}
const repositorySchema = z.object({id:z.number().int(),full_name:z.string(),private:z.boolean(),default_branch:z.string(),permissions:z.object({push:z.boolean().optional()}).optional()});
const installationSchema = z.object({id:z.number().int(),permissions:z.object({contents:z.string().optional(),pull_requests:z.string().optional()})});
const pullSchema = z.object({number:z.number().int(),html_url:z.string().url(),state:z.enum(['open','closed']),merged_at:z.string().nullable(),head:z.object({ref:z.string()}),base:z.object({ref:z.string()})});
const tokenSchema = z.object({access_token:z.string().min(1),expires_in:z.number().positive().optional()});

export function createGithub(config: GithubConfig, testEndpoints?: {api:string;oauth:string}) {
  if (Object.values(config).some(value=>!value.trim())) throw new Error('Complete GitHub App configuration is required');
  const callback = new URL(config.callbackUrl);
  if (callback.protocol !== 'https:' || callback.username || callback.password || callback.search || callback.hash) throw new Error('GitHub callback must be a trusted HTTPS URL');
  for (const endpoint of Object.values(testEndpoints ?? {})) {
    const url = new URL(endpoint);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('Test endpoints must be loopback HTTP');
  }
  const api = testEndpoints?.api ?? 'https://api.github.com';
  const oauth = testEndpoints?.oauth ?? 'https://github.com';
  async function request(path:string, token:string, body?:unknown):Promise<unknown> {
    const response = await fetch(`${api}${path}`, {
      method:body === undefined ? 'GET' : 'POST', redirect:'error', signal:AbortSignal.timeout(30_000),
      headers:{accept:'application/vnd.github+json',authorization:`Bearer ${token}`,'X-GitHub-Api-Version':'2022-11-28','content-type':'application/json'},
      ...(body === undefined ? {} : {body:JSON.stringify(body)}),
    });
    if (!response.ok) throw new Error(`GitHub request failed (${response.status})`);
    return response.json();
  }
  function jwt() {
    const now = Math.floor(Date.now()/1000);
    const unsigned = `${Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT'})).toString('base64url')}.${Buffer.from(JSON.stringify({iat:now-60,exp:now+540,iss:config.appId})).toString('base64url')}`;
    return `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(config.privateKey,'base64url')}`;
  }
  async function repositories(token:string):Promise<Repository[]> {
    const result: Repository[] = [];
    for (let page=1;page<=100;page++) {
      const installations = z.object({installations:z.array(installationSchema)}).parse(await request(`/user/installations?per_page=100&page=${page}`,token)).installations;
      for (const installation of installations) {
        if (installation.permissions.contents !== 'write' || installation.permissions.pull_requests !== 'write') continue;
        for (let repoPage=1;repoPage<=100;repoPage++) {
          const repos = z.object({repositories:z.array(repositorySchema)}).parse(await request(`/user/installations/${installation.id}/repositories?per_page=100&page=${repoPage}`,token)).repositories;
          for (const repo of repos) if (!repo.private && repo.permissions?.push) result.push({fullName:repo.full_name,defaultBranch:repo.default_branch,installationId:installation.id});
          if (repos.length<100) break;
          if (repoPage===100) throw new Error('Repository listing exceeds supported limit');
        }
      }
      if (installations.length<100) return result;
    }
    throw new Error('Installation listing exceeds supported limit');
  }
  async function authorize(token:string, repository:string):Promise<RepositoryAccess> {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid repository');
    const repo = repositorySchema.parse(await request(`/repos/${repository}`,token));
    if (repo.private) throw new Error('Only public repositories are supported');
    if (!repo.permissions?.push) throw new Error('User write permission is required');
    const accessible = (await repositories(token)).find(item=>item.fullName.toLowerCase()===repository.toLowerCase());
    if (!accessible) throw new Error('An installation with contents and pull request write permissions is required');
    return {repository:accessible.fullName,defaultBranch:accessible.defaultBranch,installationId:accessible.installationId};
  }
  async function findPullRequest(token:string, repository:string, branch:string):Promise<PullRequest|null> {
    const owner = repository.split('/')[0];
    const list = z.array(pullSchema).parse(await request(`/repos/${repository}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=100`,token));
    const pr = list.find(item=>item.head.ref===branch);
    if (!pr) return null;
    if (!pr.html_url.startsWith(`https://github.com/${repository}/pull/`)) throw new Error('Unexpected GitHub pull request URL');
    return {url:pr.html_url,number:pr.number,branch,state:pr.merged_at ? 'merged' : pr.state};
  }
  async function installationToken(installationId:number, repository:string,permission:'read'|'write'='write') {
    if (!Number.isSafeInteger(installationId) || installationId<1 || !/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid repository installation');
    const value = z.object({token:z.string().regex(/^[A-Za-z0-9_]+$/),expires_at:z.string()}).parse(await request(`/app/installations/${installationId}/access_tokens`,jwt(),{repositories:[repository.split('/')[1]],permissions:{contents:permission,pull_requests:permission}}));
    if (!(Date.parse(value.expires_at)>Date.now()+30_000)) throw new Error('GitHub installation token expired');
    return value.token;
  }
  return {
    repositories, authorize, findPullRequest, installationToken,
    async reconciliationRepository(repository:string):Promise<RepositoryAccess> {
      if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid repository');
      const installation = installationSchema.parse(await request(`/repos/${repository}/installation`,jwt()));
      const token = await installationToken(installation.id,repository,'read');
      const repo = repositorySchema.parse(await request(`/repos/${repository}`,token));
      if (repo.private) throw new Error('Only public repositories are supported');
      return {repository:repo.full_name,defaultBranch:repo.default_branch,installationId:installation.id};
    },
    authorizationUrl(state:string,challenge:string) {
      const url = new URL(`${oauth}/login/oauth/authorize`);
      url.search = new URLSearchParams({client_id:config.clientId,redirect_uri:config.callbackUrl,state,code_challenge:challenge,code_challenge_method:'S256'}).toString();
      return url.href;
    },
    async authenticate(code:string,verifier:string) {
      const response = await fetch(`${oauth}/login/oauth/access_token`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(30_000),headers:{accept:'application/json','content-type':'application/json'},body:JSON.stringify({client_id:config.clientId,client_secret:config.clientSecret,redirect_uri:config.callbackUrl,code,code_verifier:verifier})});
      if (!response.ok) throw new Error('GitHub authorization exchange failed');
      const token = tokenSchema.parse(await response.json());
      const user = z.object({id:z.number().int(),login:z.string()}).parse(await request('/user',token.access_token));
      // Bound even non-expiring upstream tokens; reauthorization refreshes this first slice.
      return {user:{id:String(user.id),login:user.login},token:token.access_token,expiresAt:new Date(Date.now()+Math.min(token.expires_in ?? 28800,28800)*1000)};
    },
    async openPullRequest(token:string, input:{repository:string;base:string;head:string;title:string;body:string;draft:true}) {
      const existing = await findPullRequest(token,input.repository,input.head);
      if (existing) return existing;
      try {
        const pr = pullSchema.parse(await request(`/repos/${input.repository}/pulls`,token,{base:input.base,head:input.head,title:input.title,body:input.body,draft:true}));
        return {url:pr.html_url,number:pr.number,branch:input.head,state:pr.merged_at ? 'merged' : pr.state};
      } catch (error) {
        // Lost successful response or duplicate request: read the unique attempt branch.
        const recovered = await findPullRequest(token,input.repository,input.head);
        if (recovered) return recovered;
        throw error;
      }
    },
    verifyWebhook(body:Buffer,signature:string|undefined) {
      if (!signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
      const expected = createHmac('sha256',config.webhookSecret).update(body).digest();
      return timingSafeEqual(expected,Buffer.from(signature.slice(7),'hex'));
    },
  };
}
export type Github = ReturnType<typeof createGithub>;
