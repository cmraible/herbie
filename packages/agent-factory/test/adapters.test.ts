import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DaytonaNotFoundError, SandboxClass, SandboxState } from '@daytona/sdk';
import { DaytonaExecution, type DaytonaVM, type DaytonaClient } from '../src/adapters/daytona.js';
import { GitHub } from '../src/adapters/github.js';
import { createGoal, reserve } from '../src/core/model.js';
import { generateKeyPair, exportPKCS8 } from 'jose';

test('Daytona adapter requires VM class, recovers named VM, isolates provider keys and confirms deletion', async () => {
  const g = createGoal('g', 'w', 'owner/repo', 'Fix one bug'); reserve(g, 1); const run = g.runs[0];
  let vm: DaytonaVM | undefined, count = 0, uploaded = '';
  let snapshotClass: SandboxClass = SandboxClass.CONTAINER;
  let result = '';
  const client: DaytonaClient = {
    async get() { if (!vm) throw new DaytonaNotFoundError('missing', 404); return vm; },
    snapshot: { async get() { return { sandboxClass: snapshotClass }; } },
    async create(params) {
      count++; assert.equal(params.name, 'herbie-g-1-1'); assert.equal(params.public, false);
      vm = { sandboxClass: SandboxClass.LINUX_VM, state: SandboxState.STARTED,
        process: { async executeCommand(command) { return { exitCode: 0, result: command.startsWith('cat ') ? result : '' }; } },
        fs: { async uploadFile(buffer) { uploaded = buffer.toString(); } },
        async delete(_timeout, wait) { assert.equal(wait, true); vm = undefined; } };
      return vm;
    },
  };
  const executor = new DaytonaExecution({ apiKey: 'master-key-never-in-vm', snapshot: 'snapshot', origin: 'https://test', tokenSecret: 'test-secret-at-least-32-characters', model: 'test-model' }, client);
  await assert.rejects(executor.advance(g, run), /Linux VM/);
  snapshotClass = SandboxClass.LINUX_VM;
  assert.deepEqual(await executor.advance(g, run), { status: 'running' });
  assert.equal(uploaded.includes('master-key-never-in-vm'), false);
  assert.equal(JSON.parse(uploaded).instructions.includes('Solve only one problem'), true);
  await executor.advance(g, run); assert.equal(count, 1);
  const summary = { problem: 'An empty input crashes', change: 'Handle empty input', verification: 'Existing empty-input test passes' };
  result = JSON.stringify({ status: 'succeeded', checkpoint: 'a'.repeat(40), summary });
  assert.deepEqual(await executor.advance(g, run), { status: 'succeeded', checkpoint: 'a'.repeat(40), summary });
  await executor.stop(g, run); assert.equal(vm, undefined);
  await executor.stop(g, run); // A lost VM is already terminated.
  run.status = 'running'; assert.deepEqual(await executor.advance(g, run), { status: 'lost' });
});
test('GitHub repair reconciliation finds its progress marker after the first 100 comments', async () => {
  const keys = await generateKeyPair('RS256', { extractable: true }); const pem = await exportPKCS8(keys.privateKey);
  const g = createGoal('g', 'w', 'owner/repo', 'Broad goal'); reserve(g, 1);
  const run = { ...g.runs[0], kind: 'repair' as const, pr: 1, checkpoint: 'abc' };
  let posted = 0;
  const transport: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('/access_tokens')) return Response.json({ token: 'test-token' });
    if (url.endsWith('/pulls/1')) return Response.json({ number: 1, state: 'open', merged_at: null, head: { ref: run.branch, sha: 'abc', repo: { full_name: 'owner/repo' } } });
    if (new URL(url).searchParams.get('page') === '1') return Response.json(Array.from({ length: 100 }, () => ({ body: 'old comment' })));
    if (new URL(url).searchParams.get('page') === '2') return Response.json([{ body: '<!-- herbie:g-1 --> Fixed.' }]);
    if (init?.method === 'POST') { posted++; return Response.json({}); }
    throw new Error('Unexpected request');
  };
  await new GitHub('app', pem, 1, transport).publish('owner/repo', run);
  assert.equal(posted, 0);
});
test('new PR title and body describe the one concrete problem, rather than restating a broad goal', async () => {
  const keys = await generateKeyPair('RS256', { extractable: true }); const pem = await exportPKCS8(keys.privateKey);
  const g = createGoal('g', 'w', 'owner/repo', 'Overhaul reliability and performance'); reserve(g, 1);
  const run = { ...g.runs[0], checkpoint: 'abc', summary: { problem: 'Empty input crashes the parser', change: 'Return an empty result for empty input.', verification: 'Parser tests pass.' } };
  let submitted: { title?: string; body?: string; draft?: boolean } = {};
  const transport: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('/access_tokens')) return Response.json({ token: 'test-token' });
    if (url.includes('/pulls?')) return Response.json([]);
    if (url.endsWith('/pulls')) { submitted = JSON.parse(String(init?.body)); return Response.json({ number: 1, state: 'open', merged_at: null, head: { ref: run.branch, sha: 'abc', repo: { full_name: 'owner/repo' } } }); }
    return Response.json({ default_branch: 'main' });
  };
  await new GitHub('app', pem, 1, transport).publish('owner/repo', run);
  assert.equal(submitted.title, 'Empty input crashes the parser');
  assert.equal(submitted.body!.startsWith('Empty input crashes the parser'), true);
  assert.equal(submitted.body!.includes('Overhaul'), false);
  assert.equal(submitted.draft, true);
});
