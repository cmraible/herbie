import { Access, GoogleIdentity, HttpError, cookie, hash, requireOrigin } from '../adapters/auth.js';
import { D1Goals } from '../adapters/d1.js';
import { createGoal, editGoal, type Goal } from '../core/model.js';
import { change } from '../core/ports.js';
import type { AppEnv } from './env.js';
import { json, string } from './http.js';
import { receiveWebhook, processDelivery } from './webhooks.js';
import { gitProxy, modelProxy } from './proxy.js';
import { html, script } from './ui.js';
export { GoalCoordinator } from './coordinator.js';
const sessionCookie = (name: string, value: string, age: number) => `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${age}`;
async function route(req: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url), path = url.pathname;
  if (path === '/' && req.method === 'GET') return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' https://accounts.google.com/gsi/client; style-src 'self' 'unsafe-inline' https://accounts.google.com; frame-src https://accounts.google.com; connect-src 'self' https://accounts.google.com; base-uri 'none'; frame-ancestors 'none'" } });
  if (path === '/app.js' && req.method === 'GET') return new Response(script, { headers: { 'Content-Type': 'text/javascript' } });
  if (path === '/health') return Response.json({ ok: true, executionEnabled: env.FACTORY_ENABLED === 'true' });
  if (path === '/webhooks/github' && req.method === 'POST') {
    const id = await receiveWebhook(req, env);
    ctx.waitUntil(processDelivery(env, id).catch(() => { /* persisted inbox is retried by cron */ }));
    return Response.json({ accepted: true }, { status: 202 });
  }
  if (path.startsWith('/git/')) return gitProxy(req, env);
  if (path.startsWith('/model/')) return modelProxy(req, env);
  if (!['GET', 'HEAD'].includes(req.method)) requireOrigin(req, env.APP_ORIGIN);
  const access = new Access(env.DB), store = new D1Goals(env.DB);
  if (path === '/auth/challenge' && req.method === 'GET') {
    const nonce = crypto.randomUUID();
    return Response.json({ nonce, clientId: env.GOOGLE_CLIENT_ID }, { headers: { 'Set-Cookie': sessionCookie('__Host-google-nonce', nonce, 300) } });
  }
  if (path === '/auth/google' && req.method === 'POST') {
    const nonce = cookie(req, '__Host-google-nonce'); if (!nonce) throw new HttpError(401, 'Sign-in challenge expired');
    const input = await json(req);
    let identity;
    try { identity = await new GoogleIdentity(env.GOOGLE_CLIENT_ID).verify(string(input, 'credential'), nonce); }
    catch { throw new HttpError(401, 'Google identity verification failed'); }
    await access.join(identity);
    const token = crypto.randomUUID() + crypto.randomUUID();
    await env.DB.prepare('INSERT INTO sessions(token_hash,sub,expires) VALUES(?,?,?)').bind(await hash(token), identity.sub, Date.now() + 8 * 3600000).run();
    const headers = new Headers(); headers.append('Set-Cookie', sessionCookie('__Host-herbie', token, 8 * 3600));
    headers.append('Set-Cookie', sessionCookie('__Host-google-nonce', '', 0));
    return Response.json({ signedIn: true }, { headers });
  }
  const sub = await access.session(req);
  if (path === '/auth/logout' && req.method === 'POST') {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await hash(cookie(req, '__Host-herbie')!)).run();
    return Response.json({ signedOut: true }, { headers: { 'Set-Cookie': sessionCookie('__Host-herbie', '', 0) } });
  }
  if (path === '/api/workspaces' && req.method === 'GET') return Response.json((await env.DB.prepare(
    'SELECT w.id,w.name,m.role FROM workspaces w JOIN members m ON w.id=m.workspace WHERE m.sub=?').bind(sub).all()).results);
  const match = /^\/api\/workspaces\/([^/]+)\/(goals|repositories|settings)(?:\/([^/]+))?$/.exec(path);
  if (!match) throw new HttpError(404, 'Not found');
  const [, workspace, resource, id] = match;
  await access.member(sub, workspace, resource === 'settings' || (resource === 'repositories' && req.method !== 'GET'));
  if (resource === 'settings' && req.method === 'GET') return Response.json(await env.DB.prepare(
    'SELECT name,billing_status,max_goals FROM workspaces WHERE id=?').bind(workspace).first());
  if (resource === 'repositories') {
    if (req.method === 'GET') return Response.json((await env.DB.prepare('SELECT repo,enabled FROM repositories WHERE workspace=?').bind(workspace).all()).results);
    if (req.method === 'PATCH') {
      const input = await json(req); if (typeof input.enabled !== 'boolean') throw new HttpError(400, 'enabled must be boolean');
      const r = await env.DB.prepare('UPDATE repositories SET enabled=? WHERE workspace=? AND repo=?').bind(Number(input.enabled), workspace, string(input, 'repo')).run();
      if (!r.meta.changes) throw new HttpError(404, 'Repository grant not found');
      return Response.json({ updated: true });
    }
  }
  if (resource === 'goals') {
    if (req.method === 'GET' && !id) return Response.json(await store.list(workspace));
    if (id) {
      const entry = await store.load(id);
      if (!entry || entry.goal.workspace !== workspace) throw new HttpError(404, 'Goal not found');
      if (req.method === 'GET') return Response.json(entry.goal);
      if (req.method === 'PATCH') {
        const input = await json(req);
        if (input.status === 'active') await access.repository(workspace, entry.goal.repo);
        try { await change(store, id, g => editGoal(g, string(input, 'prompt'), Number(input.target), string(input, 'status') as Goal['status'])); }
        catch (e) { throw new HttpError(400, e instanceof Error ? e.message : 'Invalid goal'); }
        await env.GOALS.getByName(id).wake(id);
        return Response.json((await store.load(id))!.goal);
      }
    } else if (req.method === 'POST') {
      const input = await json(req); const repo = string(input, 'repo'); await access.repository(workspace, repo);
      let goal;
      try { goal = createGoal(crypto.randomUUID(), workspace, repo, string(input, 'prompt'), input.target === undefined ? 1 : Number(input.target)); }
      catch { throw new HttpError(400, 'Invalid goal prompt, repository or target'); }
      await store.create(goal); await env.GOALS.getByName(goal.id).wake(goal.id);
      return Response.json(goal, { status: 201 });
    }
  }
  throw new HttpError(405, 'Method not allowed');
}
export default {
  async fetch(req: Request, env: AppEnv, ctx: ExecutionContext) {
    try {
      const response = await route(req, env, ctx);
      response.headers.set('Cache-Control', 'no-store'); response.headers.set('X-Content-Type-Options', 'nosniff');
      response.headers.set('Referrer-Policy', 'no-referrer'); return response;
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      return Response.json({ error: e instanceof HttpError ? e.message : 'Operation failed; please retry or contact your administrator' }, {
        status, headers: { 'Cache-Control': 'no-store', ...(status === 401 && new URL(req.url).pathname.startsWith('/git/') ? { 'WWW-Authenticate': 'Basic realm="Herbie run"' } : {}) } });
    }
  },
  async scheduled(_event: ScheduledController, env: AppEnv) {
    const deliveries = await env.DB.prepare('SELECT id FROM deliveries WHERE completed=0 ORDER BY received LIMIT 100').all<{ id: string }>();
    for (const row of deliveries.results) { try { await processDelivery(env, row.id); } catch { /* retry next sweep */ } }
    // Cursor pagination avoids leaving larger tenants unscheduled.
    let after = '';
    for (;;) {
      const goals = await env.DB.prepare('SELECT id FROM goals WHERE id>? ORDER BY id LIMIT 100').bind(after).all<{ id: string }>();
      for (const row of goals.results) await env.GOALS.getByName(row.id).wake(row.id);
      if (goals.results.length < 100) break;
      after = goals.results.at(-1)!.id;
    }
    await env.DB.prepare('DELETE FROM sessions WHERE expires<?').bind(Date.now()).run();
  },
} satisfies ExportedHandler<AppEnv>;
