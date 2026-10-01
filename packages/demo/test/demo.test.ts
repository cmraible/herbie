import { test, type TestContext } from 'node:test';
import { request } from 'node:http';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { Auth } from '../src/auth.js';
import { createApp } from '../src/server.js';
import { responseText } from '../src/stream.js';

async function temporaryAuth(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'herbie-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const auth = new Auth(directory, 'http://127.0.0.1:3210/auth/callback');
  await auth.init();
  return { auth, directory };
}

test('OAuth uses a persistent host, PKCE, and rejects wrong state and missing client IDs', async t => {
  const { auth, directory } = await temporaryAuth(t);
  const url = new URL(auth.begin());
  assert.equal(url.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:3210/auth/callback');
  assert.match(url.searchParams.get('scope')!, /chatgpt.tokens.use.direct/);
  await assert.rejects(auth.complete(new URLSearchParams({ state: 'wrong', code: 'code' })), /state/);
  await assert.rejects(auth.complete(new URLSearchParams({ state: url.searchParams.get('state')!, code: 'code' })), /registration/);
  const restarted = new Auth(directory, 'http://127.0.0.1:3210/auth/callback');
  await restarted.init();
  assert.equal(new URL(restarted.begin()).searchParams.get('ext_agent_host_id'), url.searchParams.get('ext_agent_host_id'));
  assert.equal((await stat(join(directory, 'credentials.json'))).mode & 0o777, 0o600);
});

test('verified login, refresh rotation, account binding, permission checks, and revocation', async t => {
  const { auth, directory } = await temporaryAuth(t);
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const key = { ...await exportJWK(publicKey), kid: 'test', alg: 'RS256' };
  let nonce = '';
  let subject = 'user-1';
  let scopes = 'openid chatgpt.tokens.use.direct';
  let expires = 1;
  let refreshCount = 0;
  let revoked = false;
  let wrongNonce = false;
  t.mock.method(globalThis, 'fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/jwks.json')) return Response.json({ keys: [key] });
    if (url.endsWith('/openid-configuration')) return Response.json({ revocation_endpoint: 'https://auth.openai.com/revoke' });
    const body = init?.body as URLSearchParams;
    if (url.endsWith('/revoke')) { assert.equal(body.get('token'), 'rotated-refresh'); revoked = true; return new Response(''); }
    assert.equal(body.get('client_id'), 'oaiapp_test');
    assert.equal(body.get('resource'), 'https://api.openai.com/v1');
    if (body.get('grant_type') === 'refresh_token') {
      refreshCount++;
      assert.equal(body.get('refresh_token'), 'initial-refresh');
      assert.equal(body.has('scope'), false);
      return Response.json({ access_token: 'renewed-access', refresh_token: 'rotated-refresh', token_type: 'Bearer', expires_in: 3600 });
    }
    assert.ok(body.get('code_verifier'));
    const id = await new SignJWT({ nonce: wrongNonce ? 'wrong' : nonce, email: 'test@example.com' }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer('https://auth.openai.com').setSubject(subject).setAudience('oaiapp_test').setIssuedAt().setExpirationTime('1h').sign(privateKey);
    return Response.json({ access_token: 'initial-access', refresh_token: 'initial-refresh', id_token: id, token_type: 'Bearer', expires_in: expires, scope: scopes });
  });
  async function login(client?: string) {
    const url = new URL(auth.begin(client));
    nonce = url.searchParams.get('nonce')!;
    return auth.complete(new URLSearchParams({ state: url.searchParams.get('state')!, code: 'code', client_id: 'oaiapp_test' }));
  }
  await login();
  assert.equal(auth.status().enabled, true);
  assert.equal(await auth.accessToken(), 'renewed-access');
  assert.equal(await auth.accessToken(), 'renewed-access');
  assert.equal(refreshCount, 1);
  assert.equal(JSON.stringify(auth.status()).includes('access_token'), false);
  const saved = JSON.parse(await readFile(join(directory, 'credentials.json'), 'utf8'));
  assert.equal(saved.accounts[0].tokens.refresh_token, 'rotated-refresh');
  const returning = new URL(auth.begin('oaiapp_test'));
  assert.equal(returning.searchParams.has('agent_name_hint'), false);
  assert.ok(returning.searchParams.get('id_token_hint'));
  await assert.rejects(auth.complete(new URLSearchParams({ state: returning.searchParams.get('state')!, code: 'code', client_id: 'oaiapp_other' })), /registration/);
  wrongNonce = true;
  await assert.rejects(login('oaiapp_test'), /nonce/);
  wrongNonce = false;
  subject = 'wrong-user';
  await assert.rejects(login('oaiapp_test'), /different account/);
  assert.equal(await auth.accessToken(), 'renewed-access');
  await auth.logout();
  assert.equal(revoked, true);
  assert.equal(auth.status().signedIn, false);
  assert.equal(auth.status().accounts.length, 1);
  assert.equal(new URL(auth.begin('oaiapp_test')).searchParams.has('id_token_hint'), false);
  subject = 'user-1'; scopes = 'openid'; expires = 3600;
  await login('oaiapp_test');
  assert.equal(auth.status().signedIn, true);
  assert.equal(auth.status().enabled, false);
  await assert.rejects(auth.accessToken(), /not enabled/);
});

function stream(value: string) {
  const bytes = new TextEncoder().encode(value);
  return new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
}
async function collect(value: string) { let text = ''; for await (const delta of responseText(stream(value))) text += delta; return text; }
test('stream handles split UTF-8 and CRLF, and rejects failures and premature EOF', async () => {
  const delta = 'data: {"type":"response.output_text.delta","delta":"Hello 🌱"}\r\n\r\n';
  assert.equal(await collect(delta + 'data: {"type":"response.completed"}\n\n'), 'Hello 🌱');
  await assert.rejects(collect(delta), /before completion/);
  await assert.rejects(collect('data: {"type":"response.failed"}\n\n'), /could not be completed/);
});

test('local HTTP boundary blocks foreign hosts, unauthenticated requests, and cross-origin writes', async t => {
  const { auth } = await temporaryAuth(t);
  // Select an available port before constructing the origin guard.
  const { createServer } = await import('node:net');
  const probe = createServer().listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const server = createApp(auth, origin).listen(port, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  assert.equal((await fetch(`${origin}/api/status`)).status, 403);
  const foreignHostStatus = await new Promise(resolve => {
    request(origin, { headers: { Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); }).end();
  });
  assert.equal(foreignHostStatus, 403);
  // The OAuth callback redirects here from a different site.
  assert.equal((await fetch(origin, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 200);
  const page = await fetch(origin);
  assert.match(await page.text(), /Continue with ChatGPT/);
  const cookie = page.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await fetch(`${origin}/api/status`, { headers: { Cookie: cookie } })).status, 200);
  const post = (site: string) => fetch(`${origin}/api/login`, { method: 'POST', headers: { Cookie: cookie, Origin: site, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal((await post('https://evil.example')).status, 403);
  const login = await post(origin);
  assert.equal(login.status, 200);
  assert.match((await login.json() as { url: string }).url, /^https:\/\/auth.openai.com\//);
});
