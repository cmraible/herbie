import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { Auth } from './auth.js';
import { responseText } from './stream.js';

async function jsonBody(request: IncomingMessage) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > 32_768) throw new Error('Request is too large.');
  }
  return JSON.parse(body || '{}');
}
function json(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(value));
}

export function createApp(auth: Auth, origin: string) {
  const session = randomBytes(32).toString('hex');
  let busy = false;
  return createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (request.headers.host !== new URL(origin).host) return json(response, { error: 'Invalid host.' }, 403);
    const url = new URL(request.url || '/', origin);
    const authenticated = request.headers.cookie?.split(';').some(c => c.trim() === `herbie=${session}`);
    if (request.method === 'GET' && ['/', '/app.js', '/style.css'].includes(url.pathname)) {
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (file === 'index.html') response.setHeader('Set-Cookie', `herbie=${session}; HttpOnly; SameSite=Lax; Path=/`);
      try {
        const data = await readFile(new URL(`../public/${file}`, import.meta.url));
        response.setHeader('Content-Type', file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8');
        response.end(data);
      } catch { json(response, { error: 'Could not load the app.' }, 500); }
      return;
    }
    if (!authenticated) return json(response, { error: 'Open Herbie in this browser first.' }, 403);
    if (request.method === 'GET' && url.pathname === '/api/status') return json(response, auth.status());
    const callback = request.method === 'GET' && url.pathname === '/auth/callback';
    if (!callback && (request.method !== 'POST' || request.headers.origin !== origin || request.headers['content-type'] !== 'application/json')) return json(response, { error: 'Invalid request origin or method.' }, 403);
    // One mutation at a time also serializes rotating refresh tokens and account changes.
    if (busy) return json(response, { error: 'A request is already running. Wait or stop it first.' }, 409);
    busy = true;
    const controller = new AbortController();
    response.on('close', () => controller.abort());
    try {
      if (callback) {
        try {
          await auth.complete(url.searchParams);
          response.writeHead(303, { Location: '/' }).end();
        } catch {
          // Never reflect authorization codes, tokens, or upstream error bodies.
          response.writeHead(303, { Location: '/?signin=failed' }).end();
        }
        return;
      }
      const body = await jsonBody(request);
      if (url.pathname === '/api/login') {
        if (body.client !== undefined && typeof body.client !== 'string') throw new Error('Invalid account.');
        return json(response, { url: auth.begin(body.client || undefined) });
      }
      if (url.pathname === '/api/logout') return json(response, { message: await auth.logout() });
      if (url.pathname === '/api/welcome') { await auth.welcome(); return json(response, {}); }
      if (!['/api/models', '/api/prompt'].includes(url.pathname)) return json(response, { error: 'Not found.' }, 404);
      const token = await auth.accessToken();
      if (url.pathname === '/api/models') {
        const result = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]) });
        if (!result.ok) throw new Error(result.status === 401 ? 'Session was rejected. Please sign in again.' : 'Could not load models. Check your plan access and try again.');
        const catalog = await result.json() as { models: { visibility: string; slug: string; display_name: string }[] };
        return json(response, catalog.models.filter(m => m.visibility === 'list').map(m => ({ id: m.slug, name: m.display_name })));
      }
      if (typeof body.prompt !== 'string' || !body.prompt.trim() || typeof body.model !== 'string' || !body.model.trim()) throw new Error('Choose a model and enter a prompt.');
      const upstream = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: body.model, input: [{ role: 'user', content: body.prompt }], store: false, stream: true }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(300_000)]),
      });
      if (!upstream.ok || !upstream.body) throw new Error(upstream.status === 429 ? 'Usage limit reached. Open Manage usage to review your limits.' : upstream.status === 401 ? 'Session was rejected. Please sign in again.' : 'ChatGPT could not start the response. Check your model and plan access.');
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
      for await (const text of responseText(upstream.body)) {
        if (!response.write(JSON.stringify({ text }) + '\n')) await once(response, 'drain', { signal: controller.signal });
      }
      response.end(JSON.stringify({ done: true }) + '\n');
    } catch (error) {
      if (controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : 'Request failed. Please try again.';
      if (response.headersSent) response.end(JSON.stringify({ error: message }) + '\n');
      else json(response, { error: message }, 400);
    } finally { busy = false; }
  });
}
