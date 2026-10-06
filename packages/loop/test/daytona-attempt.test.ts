import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { test, mock, type TestContext } from 'node:test';
import { DaytonaAttemptError, runDaytonaAttempt } from '../src/daytona-attempt.js';

type Create = Parameters<typeof runDaytonaAttempt>[0];
type Sandbox = Awaited<ReturnType<Create>>;
const request = {
  snapshot: 'approved-codex-runtime', domainAllowList: 'github.com,api.openai.com',
  outboundProxyUrl: 'http://proxy.example:8080', secrets: { OPENAI_API_KEY: 'existing-codex-secret' },
  repoUrl: 'https://github.com/example/repo.git', commit: '0123456789abcdef',
  goal: 'Fix addition; $(do-not-execute) `nor-this` \'quoted\'\nsecond line',
};
const runtimeNames = ['codex-initialize', 'codex-thread', 'codex-turn', 'codex-process', 'daytona-runner'];
const runtime = await Promise.all(runtimeNames.map(async name => ({
  name: `${name}.js`,
  code: stripTypeScriptTypes(await readFile(new URL(`../src/${name}.ts`, import.meta.url), 'utf8')),
})));

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'herbie-daytona-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await Promise.all(runtime.map(file => writeFile(join(directory, file.name), file.code)));
  const sandbox = {
    id: 'attempt-sandbox',
    fs: {
      createFolder: mock.fn<Sandbox['fs']['createFolder']>(async () => {}),
      uploadFile: mock.fn<Sandbox['fs']['uploadFile']>(async () => {}),
    },
    git: { clone: mock.fn<Sandbox['git']['clone']>(async () => {}) },
    process: { executeCommand: mock.fn<Sandbox['process']['executeCommand']>(async () => ({ exitCode: 0, result: 'herbie-attempt-completed\n' })) },
    delete: mock.fn<Sandbox['delete']>(async () => {}),
  };
  const create = mock.fn<Create>(async () => sandbox);
  const reports: string[] = [];
  const report = (message: string) => { reports.push(message); };
  const run = () => runDaytonaAttempt(create, request, report, pathToFileURL(directory + '/'));
  return { directory, sandbox, create, reports, run };
}

test('prepares runtime and repo, invokes the attempt, and waits for deletion using SDK contracts', async t => {
  const { sandbox, create, reports, run } = await fixture(t);
  let release = () => {};
  const deleting = new Promise<void>(resolve => { release = resolve; });
  sandbox.delete.mock.mockImplementation(() => deleting);
  const done = run();
  while (!sandbox.delete.mock.callCount()) await new Promise(resolve => setImmediate(resolve));
  assert.equal(reports.some(message => message.startsWith('Deletion confirmed')), false);
  release();
  await done;
  const [params, options] = create.mock.calls[0].arguments;
  assert.deepEqual(params, {
    name: params.name, snapshot: request.snapshot, domainAllowList: request.domainAllowList,
    secrets: request.secrets, outboundProxyUrl: request.outboundProxyUrl, ttlMinutes: 15,
  });
  assert.match(params.name ?? '', /^herbie-attempt-[0-9a-f-]+$/);
  assert.deepEqual(options, { timeout: 120 });
  const root = `/tmp/${params.name}`;
  assert.deepEqual(sandbox.fs.createFolder.mock.calls[0].arguments, [root, '700']);
  assert.deepEqual(sandbox.git.clone.mock.calls[0].arguments, [request.repoUrl, `${root}/repo`, undefined, request.commit]);
  const uploads = sandbox.fs.uploadFile.mock.calls.map(call => call.arguments);
  assert.deepEqual(uploads.map(([, path]) => path), [...runtimeNames.map(name => `${root}/${name}.js`), `${root}/package.json`, `${root}/attempt.json`]);
  assert.ok(uploads.every(([, , timeout]) => timeout === 30));
  const input = uploads.at(-1);
  assert.ok(input);
  assert.deepEqual(JSON.parse(input[0].toString()), { cwd: `${root}/repo`, goal: request.goal });
  assert.deepEqual(sandbox.process.executeCommand.mock.calls[1].arguments, [`node ${root}/daytona-runner.js`, root, undefined, 360]);
  assert.equal(sandbox.process.executeCommand.mock.calls[0].arguments[3], 30);
  assert.deepEqual(sandbox.delete.mock.calls[0].arguments, [60, true]);
  assert.equal(reports.at(-1), 'Deletion confirmed for sandbox attempt-sandbox');
});

for (const phase of ['preflight', 'upload', 'clone', 'execute', 'nonzero', 'wrong-output', 'delete', 'execute-and-delete']) {
  test(`reports ${phase} failure and cleans up after acquiring the sandbox`, async t => {
    const { sandbox, reports, run } = await fixture(t);
    const fail = async () => { throw new Error('private SDK detail'); };
    if (phase === 'upload') sandbox.fs.uploadFile.mock.mockImplementation(fail);
    if (phase === 'clone') sandbox.git.clone.mock.mockImplementation(fail);
    if (phase === 'preflight') sandbox.process.executeCommand.mock.mockImplementation(fail);
    if (phase === 'execute' || phase === 'execute-and-delete') sandbox.process.executeCommand.mock.mockImplementationOnce(fail, 1);
    if (phase === 'nonzero' || phase === 'wrong-output') {
      sandbox.process.executeCommand.mock.mockImplementationOnce(async () => ({ exitCode: phase === 'nonzero' ? 1 : 0, result: 'private output' }), 1);
    }
    if (phase === 'delete' || phase === 'execute-and-delete') sandbox.delete.mock.mockImplementation(fail);
    await assert.rejects(run(), error => {
      assert.ok(error instanceof DaytonaAttemptError);
      assert.equal(error.errors.length, phase === 'execute-and-delete' ? 2 : 1);
      assert.doesNotMatch(error.message, /private/);
      return true;
    });
    assert.equal(sandbox.delete.mock.callCount(), 1);
    if (phase === 'delete' || phase === 'execute-and-delete') assert.equal(reports.some(message => message.startsWith('Deletion confirmed')), false);
    if (phase === 'preflight' || phase === 'upload') assert.equal(sandbox.git.clone.mock.callCount(), 0);
    if (phase === 'clone') assert.equal(sandbox.process.executeCommand.mock.callCount(), 1);
  });
}

test('creation failure remains unconfirmed without retries or fake deletion', async t => {
  const { create, sandbox, run } = await fixture(t);
  create.mock.mockImplementation(async () => { throw new Error('private create failure'); });
  await assert.rejects(run(), /Creation failed.*cleanup is unconfirmed/);
  assert.equal(create.mock.callCount(), 1);
  assert.equal(sandbox.delete.mock.callCount(), 0);
});

test('missing runtime and credential-bearing repo URLs fail before provisioning', async t => {
  const { create, directory } = await fixture(t);
  await assert.rejects(runDaytonaAttempt(create, { ...request, repoUrl: 'https://user:secret@github.com/repo' }, () => {}), /public HTTPS/);
  await rm(join(directory, 'codex-process.js'));
  await assert.rejects(runDaytonaAttempt(create, request, () => {}, pathToFileURL(directory + '/')), /ENOENT/);
  assert.equal(create.mock.callCount(), 0);
});

test('uploaded runner executes the connected attempt with a local fake Codex, without a provider', { skip: process.platform === 'win32', timeout: 10_000 }, async t => {
  const { directory, sandbox, run } = await fixture(t);
  const bin = join(directory, 'bin');
  await mkdir(bin);
  const record = join(directory, 'protocol');
  const protocolFixture = fileURLToPath(new URL('./fixtures/goal-attempt.ts', import.meta.url));
  await writeFile(join(bin, 'codex'), `#!/usr/bin/env node\nprocess.argv = [process.execPath, ${JSON.stringify(protocolFixture)}, 'success', ${JSON.stringify(record)}];\nawait import(${JSON.stringify(pathToFileURL(protocolFixture).href)});\n`, { mode: 0o700 });
  sandbox.fs.createFolder.mock.mockImplementation(async path => {
    await mkdir(path);
    t.after(() => rm(path, { recursive: true, force: true }));
  });
  sandbox.fs.uploadFile.mock.mockImplementation(async (contents, path) => { await writeFile(path, contents); });
  sandbox.git.clone.mock.mockImplementation(async (_url, path) => { await mkdir(path); });
  sandbox.process.executeCommand.mock.mockImplementationOnce(async (command, cwd) => {
    assert.ok(cwd);
    assert.equal(command, `node ${cwd}/daytona-runner.js`);
    const { stdout } = await promisify(execFile)(process.execPath, [join(cwd, 'daytona-runner.js')], {
      cwd, env: { PATH: `${bin}:${process.env.PATH}` }, timeout: 8_000,
    });
    return { exitCode: 0, result: stdout };
  }, 1);
  await run();
  const events: unknown[] = (await readFile(record, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(events.some(event => typeof event === 'object' && event !== null && 'params' in event
    && JSON.stringify(event.params).includes('do-not-execute')));
  assert.deepEqual(events.slice(-2), [{ completed: 'completed' }, { eof: true }]);
  assert.equal(sandbox.delete.mock.callCount(), 1);
});
