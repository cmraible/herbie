import { HttpError } from '../adapters/auth.js';
import { verifyRunToken } from '../adapters/capability.js';
import { D1Goals } from '../adapters/d1.js';
import type { AppEnv } from './env.js';
import { bytes } from './http.js';
import { github } from './services.js';
async function authorize(req: Request, env: AppEnv) {
  const header = req.headers.get('authorization') ?? '';
  let token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (header.startsWith('Basic ')) {
    try { token = atob(header.slice(6)).split(':').slice(1).join(':'); } catch { /* denied below */ }
  }
  if (!token) throw new HttpError(401, 'Run capability required');
  let claims;
  try { claims = await verifyRunToken(env.RUN_TOKEN_SECRET, token); } catch { throw new HttpError(401, 'Invalid run capability'); }
  const entry = await new D1Goals(env.DB).load(claims.goal);
  const run = entry?.goal.runs.find(r => r.id === claims.run && r.attempt === claims.attempt);
  if (env.FACTORY_ENABLED !== 'true' || !entry || entry.goal.status !== 'active' || !run || run.status !== 'running' ||
      !run.startedAt || Date.now() - run.startedAt > 30 * 60000) throw new HttpError(403, 'Run is no longer active');
  return { goal: entry.goal, run };
}
/** Parse Git receive-pack command pkt-lines before forwarding the opaque packfile. */
export function validatePush(body: Uint8Array, branch: string) {
  let offset = 0, commands = 0;
  while (offset + 4 <= body.length) {
    const sizeText = new TextDecoder().decode(body.slice(offset, offset + 4));
    if (!/^[0-9a-fA-F]{4}$/.test(sizeText)) throw new HttpError(403, 'Malformed push');
    const size = parseInt(sizeText, 16); offset += 4;
    if (size === 0) { if (commands !== 1) throw new HttpError(403, 'One branch per push required'); return; }
    if (size < 4 || offset + size - 4 > body.length) throw new HttpError(403, 'Malformed push');
    const command = new TextDecoder().decode(body.slice(offset, offset + size - 4)).split('\0')[0].trim();
    const parts = command.split(' ');
    if (parts.length !== 3 || !/^[0-9a-f]{40,64}$/.test(parts[0]) || !/^[0-9a-f]{40,64}$/.test(parts[1]) ||
        /^0+$/.test(parts[1]) || parts[2] !== `refs/heads/${branch}`) throw new HttpError(403, 'Push outside run branch denied');
    commands++; offset += size - 4;
  }
  throw new HttpError(403, 'Malformed push');
}
export async function gitProxy(req: Request, env: AppEnv) {
  const { goal, run } = await authorize(req, env);
  const url = new URL(req.url), base = `/git/${goal.repo}.git/`;
  if (!url.pathname.startsWith(base)) throw new HttpError(403, 'Repository access denied');
  const endpoint = url.pathname.slice(base.length);
  const service = url.searchParams.get('service');
  if (!(req.method === 'GET' && endpoint === 'info/refs' && ['git-upload-pack', 'git-receive-pack'].includes(service ?? '')) &&
      !(req.method === 'POST' && ['git-upload-pack', 'git-receive-pack'].includes(endpoint) && !url.search)) throw new HttpError(404, 'Unknown Git operation');
  const body = req.method === 'POST' ? await bytes(req, 20 * 1024 * 1024) : undefined;
  if (endpoint === 'git-receive-pack') validatePush(body!, run.branch);
  const provider = await github(env, goal.workspace, goal.repo);
  const token = await provider.token(goal.repo, false);
  const upstream = await fetch(`https://github.com/${goal.repo}.git/${endpoint}${url.search}`, {
    method: req.method, body, redirect: 'error', signal: AbortSignal.timeout(60000),
    headers: { Authorization: `Basic ${btoa('x-access-token:' + token)}`, 'User-Agent': 'herbie',
      'Content-Type': req.headers.get('content-type') ?? 'application/octet-stream', 'Git-Protocol': 'version=2' } });
  return new Response(upstream.body, { status: upstream.status, headers: {
    'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream', 'Cache-Control': 'no-store' } });
}
export async function modelProxy(req: Request, env: AppEnv) {
  if (req.method !== 'POST' || new URL(req.url).pathname !== '/model/v1/responses') throw new HttpError(404, 'Unknown model operation');
  const { goal, run } = await authorize(req, env);
  await github(env, goal.workspace, goal.repo); // Recheck disabled connections/billing.
  const body: Record<string, unknown> = JSON.parse(new TextDecoder().decode(await bytes(req, 2 * 1024 * 1024)));
  if (body.model !== env.CODEX_MODEL) throw new HttpError(403, 'Model not enabled');
  // Limit requests atomically per logical run, including retries.
  const usage = await env.DB.prepare(`INSERT INTO model_usage(run,requests) VALUES(?,1)
    ON CONFLICT(run) DO UPDATE SET requests=requests+1 WHERE requests<200 RETURNING requests`).bind(run.id).first();
  if (!usage) throw new HttpError(429, 'Run model request budget exhausted');
  body.store = false; body.max_output_tokens = 16384;
  // Only model inference is exposed; no service-level files, background jobs or hosted tools.
  if (body.background || body.previous_response_id || (Array.isArray(body.tools) && body.tools.some((t: { type?: string }) => !['function', 'custom'].includes(t.type ?? ''))))
    throw new HttpError(403, 'Unsupported hosted model operation');
  const upstream = await fetch('https://api.openai.com/v1/responses', { method: 'POST', signal: AbortSignal.timeout(120000),
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return new Response(upstream.body, { status: upstream.status, headers: {
    'Content-Type': upstream.headers.get('content-type') ?? 'application/json', 'Cache-Control': 'no-store' } });
}
