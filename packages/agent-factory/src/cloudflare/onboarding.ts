import { Access, HttpError } from '../adapters/auth.js';
import { PrivateWorkspaces, WorkspaceAdmin } from '../adapters/onboarding.js';
import { Connections } from '../adapters/connections.js';
import { GitHubAuthorizationClient } from '../adapters/github-onboarding.js';
import type { AppEnv } from './env.js';
import { json, string } from './http.js';
function connections(env:AppEnv) {
  if (!env.GITHUB_CLIENT_ID || env.GITHUB_CLIENT_ID==='configure-before-use' || !env.GITHUB_CLIENT_SECRET) throw new HttpError(503,'GitHub connection setup is not configured');
  return new Connections(env.DB,new GitHubAuthorizationClient({clientId:env.GITHUB_CLIENT_ID,secret:env.GITHUB_CLIENT_SECRET,appId:env.GITHUB_APP_ID,redirect:env.APP_ORIGIN+'/auth/github/callback'}));
}
export async function onboardingRoute(req:Request,env:AppEnv,sub:string,session:string):Promise<Response|undefined> {
  const url=new URL(req.url), path=url.pathname, admin=new WorkspaceAdmin(env.DB);
  if (path==='/api/account' && req.method==='GET') {
    const identity=await admin.identity(sub);
    return Response.json({identity});
  }
  if (path==='/api/onboarding/workspace' && req.method==='POST') {
    return Response.json(await new PrivateWorkspaces(env.DB).create(sub,string(await json(req),'name')));
  }
  if (['/api/onboarding/company','/api/onboarding/verify','/api/onboarding/join'].includes(path)) {
    throw new HttpError(410,'Company domain onboarding is retired. Refresh to create a private workspace.');
  }
  if (path==='/auth/github/callback' && req.method==='GET') {
    const state=url.searchParams.get('state'),code=url.searchParams.get('code');
    if (!state || !code) throw new HttpError(400,'GitHub authorization was canceled or incomplete');
    await connections(env).complete(sub,state,code,session);
    return Response.redirect(env.APP_ORIGIN+'/?github=connected',303);
  }
  const match=/^\/api\/workspaces\/([^/]+)\/(domains|members|audit|github)(?:\/(start|accept))?$/.exec(path);
  if (!match) return;
  const [,workspace,resource,action]=match;
  await new Access(env.DB).member(sub,workspace,true);
  if (resource==='domains') throw new HttpError(410,'Domain-based membership is disabled');
  if (resource==='members') {
    if (req.method==='GET') return Response.json((await env.DB.prepare("SELECT m.sub,m.role,m.status,COALESCE(i.name,'Company member') AS name,COALESCE(i.email,'') AS email FROM members m LEFT JOIN identities i ON i.sub=m.sub WHERE m.workspace=?").bind(workspace).all()).results);
    if (req.method==='PATCH') { const input=await json(req); await admin.setMember(sub,workspace,string(input,'sub'),string(input,'role'),string(input,'status')); return Response.json({updated:true}); }
  }
  if (resource==='audit' && req.method==='GET') return Response.json((await env.DB.prepare('SELECT actor,action,detail,at FROM workspace_audit WHERE workspace=? ORDER BY id DESC LIMIT 100').bind(workspace).all()).results);
  if (resource==='github') {
    if (req.method==='GET') return Response.json({installUrl:/^[a-z0-9-]+$/.test(env.GITHUB_APP_SLUG) ? `https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new` : null,proposals:await connections(env).list(sub,workspace)});
    if (req.method==='POST' && action==='start') return Response.json(await connections(env).begin(sub,workspace,session));
    if (req.method==='POST' && action==='accept') { const input=await json(req); await connections(env).accept(sub,workspace,string(input,'id'),input.repositories as string[]); return Response.json({connected:true}); }
  }
  throw new HttpError(405,'Method not allowed');
}
