import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../src/cli.js';

async function fixture(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing TCP address');
  const directory = await mkdtemp(join(tmpdir(), 'herbie-cli-'));
  const output: string[] = [];
  const errors: string[] = [];
  return {
    baseUrl: `http://127.0.0.1:${address.port}`, configPath: join(directory, 'session.json'), output, errors,
    invoke(args: string[]) { return runCli(args, { configPath: join(directory, 'session.json'), stdout: value => output.push(value), stderr: value => errors.push(value) }); },
    async close() { server.close(); await once(server, 'close'); await rm(directory, {recursive: true, force: true}); },
  };
}

function json(response: ServerResponse, value: unknown, status = 200) { response.writeHead(status, {'content-type':'application/json'}); response.end(JSON.stringify(value)); }
const session = { user: { id: 'user-1', login: 'octocat' }, mode: 'demo' };

test('explicit demo login persists a private bearer session and authenticates subsequent status calls', async () => {
  const app = await fixture((request, response) => {
    if (request.url === '/api/demo/login' && request.method === 'POST') { json(response, {token:'private-session',session}); return; }
    if (request.url === '/api/goals' && request.headers.authorization === 'Bearer private-session') { json(response, []); return; }
    json(response, {error:'Unauthorized'}, 401);
  });
  try {
    assert.equal(await app.invoke(['login','--demo','--url',app.baseUrl]), 0);
    assert.equal((await stat(app.configPath)).mode & 0o777, 0o600);
    assert.match(await readFile(app.configPath, 'utf8'), /private-session/);
    assert.equal(await app.invoke(['status']), 0);
    assert.deepEqual(JSON.parse(app.output.at(-1) ?? ''), []);
    assert.ok(!app.output.join('').includes('private-session'));
  } finally { await app.close(); }
});

const goalId = '271de1c7-b32c-43b7-a61f-f0a2a1d53c0d';
const requestId = '8e5e189f-b9cf-4f65-9c94-5d8d25b43b70';
const goal = {id:goalId, ownerId:'user-1', repository:'octocat/demo', prompt:'Add a regression test', testCommand:['npm','test'], maxAttempts:2, attemptCount:0, state:'queued', createdAt:'2026-10-08T00:00:00Z', updatedAt:'2026-10-08T00:00:00Z', mode:'demo', stopRequested:null, pullRequest:null, error:null};

test('start retries preserve the request ID and JSON test arguments without shell evaluation', async () => {
  const requests: {key: string | string[] | undefined; body: unknown}[] = [];
  const app = await fixture((request, response) => {
    if (request.url === '/api/demo/login') { json(response, {token:'private-session',session}); return; }
    if (request.url === '/api/goals' && request.method === 'POST') {
      let body = '';
      request.setEncoding('utf8'); request.on('data', (chunk: string) => { body += chunk; });
      request.on('end', () => { requests.push({key:request.headers['idempotency-key'],body:JSON.parse(body)}); json(response, goal, requests.length === 1 ? 201 : 200); }); return;
    }
    json(response, {error:'Not found'}, 404);
  });
  try {
    await app.invoke(['login','--demo','--url',app.baseUrl]);
    const args = ['start','--repo','octocat/demo','--prompt','Add a regression test','--test','["npm","test","literal; $(whoami)"]','--max-attempts','2','--request-id',requestId];
    assert.equal(await app.invoke(args), 0);
    assert.equal(await app.invoke(args), 0);
    assert.deepEqual(requests, [0,1].map(() => ({key:requestId,body:{repository:'octocat/demo',prompt:'Add a regression test',testCommand:['npm','test','literal; $(whoami)'],maxAttempts:2}})));
    assert.equal(JSON.parse(app.output.at(-1) ?? '').id, goalId);
  } finally { await app.close(); }
});

test('failed and repeated controls report service truth; events support a cursor', async () => {
  const app = await fixture((request, response) => {
    if (request.url === '/api/demo/login') { json(response, {token:'private-session',session}); return; }
    if (request.url === `/api/goals/${goalId}/pause`) { json(response,{error:'Publication already started'},409); return; }
    if (request.url === `/api/goals/${goalId}/cancel`) { json(response,{...goal,state:'cancelled'}); return; }
    if (request.url === `/api/goals/${goalId}/events?after=2`) { json(response,[{id:3,goalId,type:'cancelled',message:'Goal cancelled',createdAt:'2026-10-08T00:00:01Z'}]); return; }
    json(response, {error:'Not found'}, 404);
  });
  try {
    await app.invoke(['login','--demo','--url',app.baseUrl]);
    assert.equal(await app.invoke(['pause',goalId]), 1);
    assert.match(app.errors.at(-1) ?? '', /Publication already started/);
    assert.equal(await app.invoke(['cancel',goalId]), 0);
    assert.equal(await app.invoke(['cancel',goalId]), 0);
    assert.equal(JSON.parse(app.output.at(-1) ?? '').state,'cancelled');
    assert.equal(await app.invoke(['logs',goalId,'--after','2']), 0);
    assert.equal(JSON.parse(app.output.at(-1) ?? '')[0].message,'Goal cancelled');
  } finally { await app.close(); }
});

test('a saved bearer token is never sent to a different service', async () => {
  const app = await fixture((_request,response) => json(response,{token:'private-session',session}));
  try {
    await app.invoke(['login','--demo','--url',app.baseUrl]);
    assert.equal(await app.invoke(['status','--url','https://elsewhere.example']),1);
    assert.match(app.errors.at(-1) ?? '', /differs from saved session/);
  } finally { await app.close(); }
});

test('the CLI refuses misspelled options and malformed test commands before creating a goal', async () => {
  const app = await fixture((_request,response) => json(response,{token:'private-session',session}));
  try {
    await app.invoke(['login','--demo','--url',app.baseUrl]);
    assert.equal(await app.invoke(['start','--repo','octocat/demo','--prompt','Fix it','--test','npm test']),1);
    assert.match(app.errors.at(-1) ?? '', /JSON argument array/);
    assert.equal(await app.invoke(['status','--requestid',requestId]),1);
    assert.match(app.errors.at(-1) ?? '', /Unknown option/);
  } finally { await app.close(); }
});

test('an insecure session file is rejected before credentials are read', async () => {
  const app = await fixture((_request,response) => json(response,{token:'private-session',session}));
  try {
    await app.invoke(['login','--demo','--url',app.baseUrl]);
    const { chmod } = await import('node:fs/promises');
    await chmod(app.configPath, 0o644);
    assert.equal(await app.invoke(['status']),1);
    assert.match(app.errors.at(-1) ?? '', /private.*0600/i);
  } finally { await app.close(); }
});

test('logout clears a locally saved session that the service has already expired', async () => {
  const app = await fixture((request, response) => {
    if (request.url === '/api/demo/login') { json(response, {token:'expired-session',session}); return; }
    json(response, {error:'Session expired'}, 401);
  });
  try {
    await app.invoke(['login','--demo','--url',app.baseUrl]);
    assert.equal(await app.invoke(['logout']), 0);
    await assert.rejects(stat(app.configPath), {code:'ENOENT'});
    assert.deepEqual(JSON.parse(app.output.at(-1) ?? ''), {ok:true});
  } finally { await app.close(); }
});

test('logout clears local credentials during a network outage and reports unconfirmed remote sign-out', async () => {
  const app = await fixture((request, response) => {
    if (request.url === '/api/demo/login') { json(response, {token:'private-session',session}); return; }
    request.socket.destroy();
  });
  try {
    await app.invoke(['login','--demo','--url',app.baseUrl]);
    assert.equal(await app.invoke(['logout']), 1);
    await assert.rejects(stat(app.configPath), {code:'ENOENT'});
    assert.match(app.errors.at(-1) ?? '', /Local session removed.*remote sign-out could not be confirmed/);
    assert.equal(await app.invoke(['status']), 1);
    assert.match(app.errors.at(-1) ?? '', /No valid session/);
  } finally { await app.close(); }
});

test('CLI login shows its service and approval code, saving no session until browser approval', async () => {
  const pending = Promise.withResolvers<void>();
  let approved = false;
  const app = await fixture((request, response) => {
    if (request.url === '/api/auth/start') { json(response, {url:'https://github.example/authorize?state=opaque-state',pollToken:'private-poll-token',userCode:'ABCD-EFGH'}); return; }
    if (request.url === '/api/auth/poll?token=private-poll-token') {
      if (approved) json(response, {status:'complete',token:'approved-session'});
      else { json(response, {status:'pending'}); pending.resolve(); }
      return;
    }
    if (request.url === '/api/session' && request.headers.authorization === 'Bearer approved-session') { json(response, {...session,mode:'live'}); return; }
    json(response, {error:'Not found'}, 404);
  });
  const login = app.invoke(['login','--url',app.baseUrl]);
  try {
    await pending.promise;
    await assert.rejects(stat(app.configPath), {code:'ENOENT'});
    const instructions = app.errors.join('');
    assert.ok(instructions.includes(`Service: ${app.baseUrl}`));
    assert.match(instructions, /Approval code: ABCD-EFGH/);
    assert.match(instructions, /Only approve if you started this login on this computer\. Enter this code in the browser\. Never approve a code sent by someone else\./);
    assert.ok(instructions.includes('https://github.example/authorize?state=opaque-state\n'));
    assert.ok(!instructions.includes('private-poll-token'));
    approved = true;
    assert.equal(await login, 0);
    assert.match(await readFile(app.configPath,'utf8'), /approved-session/);
    assert.equal((await stat(app.configPath)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(app.output.at(-1) ?? '').mode, 'live');
  } finally { approved = true; await login; await app.close(); }
});

test('rejecting pending CLI authorization stops polling without saving a session', async () => {
  const pending = Promise.withResolvers<void>();
  let reject = false;
  const app = await fixture((request, response) => {
    if (request.url === '/api/auth/start') { json(response, {url:'https://github.example/authorize?state=rejected-state',pollToken:'private-poll-token',userCode:'WXYZ-2345'}); return; }
    if (request.url === '/api/auth/poll?token=private-poll-token') {
      json(response, {status:reject ? 'rejected' : 'pending'});
      pending.resolve(); return;
    }
    json(response, {error:'No session should be issued'}, 401);
  });
  const login = app.invoke(['login','--url',app.baseUrl]);
  try {
    await pending.promise;
    await assert.rejects(stat(app.configPath), {code:'ENOENT'});
    reject = true;
    assert.equal(await login, 1);
    assert.match(app.errors.at(-1) ?? '', /CLI authorization rejected; no session saved/);
    await assert.rejects(stat(app.configPath), {code:'ENOENT'});
    assert.equal(app.output.length, 0);
  } finally { reject = true; await login; await app.close(); }
});

test('CLI authorization without a user approval code is refused before polling', async () => {
  let polls = 0;
  const app = await fixture((request, response) => {
    if (request.url === '/api/auth/start') { json(response, {url:'https://github.example/authorize?state=legacy-state',pollToken:'private-poll-token'}); return; }
    polls++; json(response, {status:'complete',token:'unapproved-session'});
  });
  try {
    assert.equal(await app.invoke(['login','--url',app.baseUrl]), 1);
    assert.match(app.errors.at(-1) ?? '', /did not provide a CLI approval code; no session saved/);
    assert.equal(polls, 0);
    await assert.rejects(stat(app.configPath), {code:'ENOENT'});
  } finally { await app.close(); }
});
