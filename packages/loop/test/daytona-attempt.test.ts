import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { MAX_ARTIFACT_BYTES, MAX_PATCH_BYTES, MAX_TEST_OUTPUT_BYTES, MAX_TEST_RESULT_BYTES } from '../src/artifact-limits.js';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { test, mock, type TestContext } from 'node:test';
import { DaytonaAttemptError, runDaytonaAttempt } from '../src/daytona-attempt.js';
import { createArithmeticFixture } from './fixtures/arithmetic.js';

type Create = Parameters<typeof runDaytonaAttempt>[0];
type Sandbox = Awaited<ReturnType<Create>>;
const request = {
  snapshot: 'approved-codex-runtime', domainAllowList: 'github.com,api.openai.com',
  outboundProxyUrl: 'http://proxy.example:8080', secrets: { OPENAI_API_KEY: 'existing-codex-secret' },
  repoUrl: 'https://github.com/example/repo.git', commit: '0123456789abcdef',
  goal: 'Fix addition; $(do-not-execute) `nor-this` \'quoted\'\nsecond line',
};
const runtimeNames = ['codex-initialize', 'codex-thread', 'codex-turn', 'codex-process', 'daytona-runner', 'daytona-test-runner', 'artifact-limits'];
const privilegedVerification = (() => {
  if (process.getuid?.() !== 0) return false;
  try {
    const coding = Number(execFileSync('id', ['-u', 'compat'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
    const verification = Number(execFileSync('id', ['-u', 'herbie-verify'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
    return coding > 0 && verification > 0 && coding !== verification;
  } catch { return false; }
})();
const changes = { baseCommit: 'a'.repeat(40), patch: Buffer.from('diff --git a/file.txt b/file.txt\n') };
const artifact = Buffer.from(JSON.stringify({ baseCommit: changes.baseCommit, patchBase64: changes.patch.toString('base64') }));
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
      downloadFileStream: mock.fn<Sandbox['fs']['downloadFileStream']>(async () => Readable.from([artifact])),
    },
    git: { clone: mock.fn<Sandbox['git']['clone']>(async () => {}) },
    process: { executeCommand: mock.fn<Sandbox['process']['executeCommand']>(async () => ({ exitCode: 0, result: 'herbie-attempt-completed\n' })) },
    delete: mock.fn<Sandbox['delete']>(async () => {}),
  };
  const create = mock.fn<Create>(async () => sandbox);
  const reports: string[] = [];
  const report = (message: string) => { reports.push(message); };
  const run = (options: Partial<Parameters<typeof runDaytonaAttempt>[1]> = {}) => runDaytonaAttempt(create, { ...request, ...options }, report, pathToFileURL(directory + '/'));
  return { directory, sandbox, create, reports, run };
}

test('verifies a fresh clone under a protected supervisor before deletion and returns the result', async t => {
  const { sandbox, run } = await fixture(t);
  const testResult = { exitCode: 0, stdout: '2 tests passed\n', stderr: '' };
  sandbox.process.executeCommand.mock.mockImplementationOnce(async () => ({ exitCode: 0, result: 'herbie-tests-completed\n' }), 2);
  sandbox.fs.downloadFileStream.mock.mockImplementationOnce(async () => Readable.from([Buffer.from(JSON.stringify(testResult))]), 1);
  const result = await run({ testCommand: ['node', '--test', 'a test.mjs'] });
  assert.deepEqual(result, { ...changes, testResult, verification: {
    version: 2,
    repoUrl: request.repoUrl, baseCommit: changes.baseCommit,
    patchSha256: 'fb6f3d476ca7ea43d75e41b36690c464b706e56179dacf4f1a72208ea895d6b4',
    testCommand: ['node', '--test', 'a test.mjs'], goalCompleted: true, sandboxDeleted: true,
  } });
  const root = sandbox.fs.createFolder.mock.calls[1].arguments[0];
  assert.match(root, /^\/tmp\/herbie-verification-/);
  assert.deepEqual(sandbox.git.clone.mock.calls[1].arguments, [request.repoUrl, `${root}/repo`, undefined, changes.baseCommit]);
  const uploads = sandbox.fs.uploadFile.mock.calls.map(call => call.arguments);
  assert.deepEqual(uploads.at(-2), [changes.patch, `${root}/recovered.patch`, 30]);
  assert.deepEqual(JSON.parse(uploads.at(-1)![0].toString()), {
    baseCommit: changes.baseCommit,
    command: ['node', '--test', 'a test.mjs'], timeoutMs: 60_000,
  });
  assert.deepEqual(sandbox.process.executeCommand.mock.calls[2].arguments,
    [`/usr/local/bin/node ${root}/daytona-test-runner.js`, root, undefined, 150]);
  assert.equal(sandbox.delete.mock.callCount(), 1);
});

for (const phase of ['test-upload', 'test-execute', 'test-nonzero', 'test-download', 'test-malformed', 'test-failure-and-delete', 'test-success-and-delete']) {
  test(`preserves recovered changes and cleanup on ${phase}`, async t => {
    const { sandbox, run, reports } = await fixture(t);
    const fail = async () => { throw new Error('private test details'); };
    const testResult = { exitCode: phase === 'test-failure-and-delete' ? 1 : 0, stdout: 'private output', stderr: '' };
    sandbox.process.executeCommand.mock.mockImplementationOnce(async () => ({ exitCode: 0, result: 'herbie-tests-completed\n' }), 2);
    sandbox.fs.downloadFileStream.mock.mockImplementationOnce(async () => Readable.from([Buffer.from(JSON.stringify(testResult))]), 1);
    if (phase === 'test-upload') sandbox.fs.uploadFile.mock.mockImplementationOnce(fail, runtimeNames.length);
    if (phase === 'test-execute') sandbox.process.executeCommand.mock.mockImplementationOnce(fail, 2);
    if (phase === 'test-nonzero') sandbox.process.executeCommand.mock.mockImplementationOnce(async () => ({ exitCode: 1, result: '' }), 2);
    if (phase === 'test-download') sandbox.fs.downloadFileStream.mock.mockImplementationOnce(fail, 1);
    if (phase === 'test-malformed') sandbox.fs.downloadFileStream.mock.mockImplementationOnce(async () => Readable.from([Buffer.from('{"exitCode":null}')]), 1);
    if (phase.endsWith('-and-delete')) sandbox.delete.mock.mockImplementation(fail);
    await assert.rejects(run({ testCommand: ['node', '--test'] }), error => {
      assert.ok(error instanceof DaytonaAttemptError);
      assert.equal(error.errors.length, phase === 'test-failure-and-delete' ? 2 : 1);
      assert.equal(error.changes?.baseCommit, changes.baseCommit);
      assert.deepEqual(error.changes?.patch, changes.patch);
      assert.deepEqual(error.changes?.testResult, phase.endsWith('-and-delete') ? testResult : undefined);
      assert.equal(error.changes?.verification, undefined);
      assert.doesNotMatch(error.message, /private/);
      return true;
    });
    assert.equal(sandbox.delete.mock.callCount(), 1);
    assert.ok(reports.every(message => !message.includes('private')));
  });
}

test('invalid test commands and deadlines fail before sandbox creation', async t => {
  const { run, create } = await fixture(t);
  for (const testCommand of [[], [''], ['node', 'bad\0argument']]) {
    await assert.rejects(run({ testCommand }), /Test command/);
  }
  for (const testTimeoutMs of [0, -1, 1.5, 60_001, NaN]) {
    await assert.rejects(run({ testCommand: ['node'], testTimeoutMs }), /Test timeout/);
  }
  assert.equal(create.mock.callCount(), 0);
});

test('prepares runtime and repo, invokes the attempt, and waits for deletion using SDK contracts', async t => {
  const { sandbox, create, reports, run } = await fixture(t);
  let release = () => {};
  const deleting = new Promise<void>(resolve => { release = resolve; });
  sandbox.delete.mock.mockImplementation(() => deleting);
  const done = run();
  while (!sandbox.delete.mock.callCount()) await new Promise(resolve => setImmediate(resolve));
  assert.equal(reports.some(message => message.startsWith('Deletion confirmed')), false);
  release();
  assert.deepEqual(await done, changes);
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
  assert.deepEqual(uploads.map(([, path]) => path), [...runtimeNames.filter(name => !['daytona-test-runner', 'artifact-limits'].includes(name)).map(name => `${root}/${name}.js`), `${root}/package.json`, `${root}/attempt.json`]);
  assert.ok(uploads.every(([, , timeout]) => timeout === 30));
  const input = uploads.at(-1);
  assert.ok(input);
  assert.deepEqual(JSON.parse(input[0].toString()), { cwd: `${root}/repo`, goal: request.goal });
  assert.deepEqual(sandbox.process.executeCommand.mock.calls[1].arguments, [`chown -R compat:compat ${root} && runuser -u compat -- env HOME=/home/compat PATH=/usr/local/bin:/usr/bin:/bin node ${root}/daytona-runner.js`, root, undefined, 240]);
  assert.equal(sandbox.process.executeCommand.mock.calls[0].arguments[3], 30);
  assert.equal(sandbox.fs.downloadFileStream.mock.calls[0].arguments[0], `${root}/changes.json`);
  assert.equal(sandbox.fs.downloadFileStream.mock.calls[0].arguments[1].timeout, 30);
  assert.ok(sandbox.fs.downloadFileStream.mock.calls[0].arguments[1].signal.aborted);
  assert.deepEqual(sandbox.delete.mock.calls[0].arguments, [60, true]);
  assert.equal(reports.at(-1), 'Deletion confirmed for sandbox attempt-sandbox');
});

for (const phase of ['preflight', 'upload', 'clone', 'execute', 'nonzero', 'wrong-output', 'download', 'invalid-json', 'invalid-artifact', 'invalid-base64', 'delete', 'execute-and-delete', 'download-and-delete']) {
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
    if (phase === 'download' || phase === 'download-and-delete') sandbox.fs.downloadFileStream.mock.mockImplementation(fail);
    if (phase === 'invalid-json') sandbox.fs.downloadFileStream.mock.mockImplementation(async () => Readable.from([Buffer.from('invalid JSON')]));
    if (phase === 'invalid-artifact') sandbox.fs.downloadFileStream.mock.mockImplementation(async () => Readable.from([Buffer.from('{"baseCommit":"unknown","patch":null}')]));
    if (phase === 'invalid-base64') sandbox.fs.downloadFileStream.mock.mockImplementation(async () => Readable.from([Buffer.from(JSON.stringify({ baseCommit: changes.baseCommit, patchBase64: 'not base64!' }))]));
    if (phase === 'delete' || phase.endsWith('-and-delete')) sandbox.delete.mock.mockImplementation(fail);
    await assert.rejects(run(), error => {
      assert.ok(error instanceof DaytonaAttemptError);
      assert.equal(error.errors.length, phase.endsWith('-and-delete') ? 2 : 1);
      assert.deepEqual(error.changes, phase === 'delete' ? changes : undefined);
      assert.doesNotMatch(error.message, /private/);
      return true;
    });
    assert.equal(sandbox.delete.mock.callCount(), 1);
    if (phase === 'delete' || phase.endsWith('-and-delete')) assert.equal(reports.some(message => message.startsWith('Deletion confirmed')), false);
    if (phase === 'preflight' || phase === 'upload') assert.equal(sandbox.git.clone.mock.callCount(), 0);
    if (phase === 'clone') assert.equal(sandbox.process.executeCommand.mock.callCount(), 1);
  });
}

test('waits for change retrieval before starting sandbox deletion', async t => {
  const { sandbox, run, reports } = await fixture(t);
  const download = Promise.withResolvers<Readable>();
  sandbox.fs.downloadFileStream.mock.mockImplementation(() => download.promise);
  const done = run();
  while (!sandbox.fs.downloadFileStream.mock.callCount()) await new Promise(resolve => setImmediate(resolve));
  assert.equal(sandbox.delete.mock.callCount(), 0);
  download.resolve(Readable.from([artifact]));
  assert.deepEqual(await done, changes);
  assert.equal(sandbox.delete.mock.callCount(), 1);
  assert.ok(reports.every(message => !message.includes(changes.patch.toString())));
});

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

async function localFixture(t: TestContext, edits = '') {
  const { directory, sandbox, run } = await fixture(t);
  const bin = join(directory, 'bin');
  await mkdir(bin);
  const record = join(directory, 'protocol');
  const protocolFixture = fileURLToPath(new URL('./fixtures/goal-attempt.ts', import.meta.url));
  await writeFile(join(bin, 'codex'), `#!/usr/bin/env node\n${edits}\nprocess.argv = [process.execPath, ${JSON.stringify(protocolFixture)}, 'success', ${JSON.stringify(record)}];\nawait import(${JSON.stringify(pathToFileURL(protocolFixture).href)});\n`, { mode: 0o700 });
  sandbox.fs.createFolder.mock.mockImplementation(async path => {
    await mkdir(path, { mode: 0o700 });
    t.after(() => rm(path, { recursive: true, force: true }));
  });
  sandbox.fs.uploadFile.mock.mockImplementation(async (contents, path) => {
    // These local fixtures have no credentials; expose supervisor errors for diagnostics.
    const data = path.endsWith('/daytona-test-runner.js')
      ? contents.toString().replace(/catch \{\s*console.error\('Sandbox patch verification failed'\);/, 'catch (error) { console.error(error);') : contents;
    await writeFile(path, data);
  });
  sandbox.fs.downloadFileStream.mock.mockImplementation(async (path: string) => createReadStream(path));
  const baseRepo = join(directory, 'base');
  const baseCommit = createArithmeticFixture(baseRepo).trim();
  sandbox.git.clone.mock.mockImplementation(async (_url, path) => {
    await promisify(execFile)('git', ['clone', '--no-hardlinks', baseRepo, path]);
  });
  sandbox.process.executeCommand.mock.mockImplementation(async (command, cwd) => {
    if (!cwd) return { exitCode: 0, result: 'fixture preflight' };
    // Mock the SDK and Codex. Root-only cases execute the real privilege-dropping verifier.
    const prefix = `chown -R compat:compat ${cwd} && runuser -u compat -- env HOME=/home/compat PATH=/usr/local/bin:/usr/bin:/bin node `;
    const verification = command === `/usr/local/bin/node ${cwd}/daytona-test-runner.js`;
    const runner = verification ? `${cwd}/daytona-test-runner.js` : command.slice(prefix.length);
    assert.ok(verification || command === `${prefix}${cwd}/daytona-runner.js`);
    const { stdout } = await promisify(execFile)(process.execPath, [runner], {
      cwd, env: { PATH: `${bin}:${process.env.PATH}` }, timeout: 8_000,
    });
    return { exitCode: 0, result: stdout };
  });
  sandbox.delete.mock.mockImplementation(async () => {
    for (const call of sandbox.fs.createFolder.mock.calls) await rm(call.arguments[0], { recursive: true });
  });
  return { directory, sandbox, run, record, baseRepo, baseCommit };
}

test('uploaded runner executes the connected attempt with a local fake Codex and preserves an empty patch', { skip: process.platform === 'win32', timeout: 10_000 }, async t => {
  const { sandbox, run, record, baseCommit } = await localFixture(t);
  assert.deepEqual(await run(), { baseCommit, patch: Buffer.alloc(0) });
  const events: unknown[] = (await readFile(record, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(events.some(event => typeof event === 'object' && event !== null && 'params' in event
    && JSON.stringify(event.params).includes('do-not-execute')));
  const paramsFor = (method: string) => {
    const event = events.find(event => typeof event === 'object' && event !== null && 'method' in event && event.method === method);
    assert.ok(typeof event === 'object' && event !== null && 'params' in event);
    return event.params;
  };
  assert.deepEqual(paramsFor('initialize'), {
    clientInfo: { name: 'herbie', version: '0.1.0' }, capabilities: { experimentalApi: true },
  });
  assert.deepEqual(paramsFor('thread/start'), {
    cwd: sandbox.git.clone.mock.calls[0].arguments[1], ephemeral: true,
    model: 'gpt-6-luna', modelProvider: 'daytona_openai',
  });
  assert.ok(JSON.stringify(paramsFor('turn/start')).includes('externalSandbox'));
  assert.deepEqual(events.slice(-2), [{ completed: 'completed' }, { eof: true }]);
  assert.equal(sandbox.delete.mock.callCount(), 1);
});

for (const commitDuringAttempt of [false, true]) {
  test(`retrieved patch reproduces tracked, staged, new, binary and non-UTF-8 files after deletion (Codex commits: ${commitDuringAttempt})`, { skip: process.platform === 'win32', timeout: 10_000 }, async t => {
    const { directory, sandbox, run, baseRepo, baseCommit } = await localFixture(t, `
      import { writeFileSync, rmSync, chmodSync } from 'node:fs';
      import { execFileSync } from 'node:child_process';
      if (${commitDuringAttempt}) {
        writeFileSync('committed.txt', 'committed during the attempt\\n');
        execFileSync('git', ['add', 'committed.txt']);
        execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
          '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'Codex change']);
      }
      writeFileSync('add.mjs', Buffer.from('// café\\nexport const add = (a, b) => a + b;\\n', 'latin1'));
      chmodSync('add.mjs', 0o755);
      rmSync('add.test.mjs');
      writeFileSync('staged.txt', 'staged change\\n');
      execFileSync('git', ['add', 'staged.txt']);
      writeFileSync('new file.txt', 'new untracked file\\n');
      writeFileSync('empty.txt', '');
      writeFileSync('binary.dat', Buffer.from([0, 255, 1, 254]));
      writeFileSync('.gitignore', 'ignored.txt\\n');
      writeFileSync('ignored.txt', 'excluded build output');
    `);
    const result = await run();
    assert.equal(result.baseCommit, baseCommit);
    const root = sandbox.fs.createFolder.mock.calls[0].arguments[0];
    await assert.rejects(readFile(join(root, 'changes.json')), { code: 'ENOENT' });
    const patch = join(directory, 'retrieved.patch');
    await writeFile(patch, result.patch);
    await promisify(execFile)('git', ['-C', baseRepo, 'apply', '--index', patch]);
    assert.deepEqual(await readFile(join(baseRepo, 'add.mjs')), Buffer.from('// café\nexport const add = (a, b) => a + b;\n', 'latin1'));
    await assert.rejects(readFile(join(baseRepo, 'add.test.mjs')), { code: 'ENOENT' });
    assert.equal(await readFile(join(baseRepo, 'staged.txt'), 'utf8'), 'staged change\n');
    assert.equal(await readFile(join(baseRepo, 'new file.txt'), 'utf8'), 'new untracked file\n');
    assert.equal(await readFile(join(baseRepo, 'empty.txt'), 'utf8'), '');
    assert.deepEqual(await readFile(join(baseRepo, 'binary.dat')), Buffer.from([0, 255, 1, 254]));
    await assert.rejects(readFile(join(baseRepo, 'ignored.txt')), { code: 'ENOENT' });
    const { stdout: mode } = await promisify(execFile)('git', ['-C', baseRepo, 'ls-files', '--stage', 'add.mjs']);
    assert.match(mode, /^100755 /);
    if (commitDuringAttempt) assert.equal(await readFile(join(baseRepo, 'committed.txt'), 'utf8'), 'committed during the attempt\n');
  });
}

test('runner patch extraction failure rejects and still deletes the sandbox', { skip: process.platform === 'win32', timeout: 10_000 }, async t => {
  const { sandbox, run } = await localFixture(t, `
    import { writeFileSync } from 'node:fs';
    writeFileSync('.git/index.lock', 'prevent extraction from staging changes');
  `);
  await assert.rejects(run(), error => {
    assert.ok(error instanceof DaytonaAttemptError);
    assert.equal(error.changes, undefined);
    return true;
  });
  assert.equal(sandbox.fs.downloadFileStream.mock.callCount(), 0);
  assert.equal(sandbox.delete.mock.callCount(), 1);
});

test('runs repository tests against the recovered patch in a clean checkout, excluding test side effects', { skip: !privilegedVerification, timeout: 10_000 }, async t => {
  const { sandbox, run } = await localFixture(t, `
    import { writeFileSync } from 'node:fs';
    writeFileSync('add.mjs', 'export const add = (a, b) => a + b;\\n');
    writeFileSync('.gitignore', 'ignored.txt\\n');
    writeFileSync('ignored.txt', 'present only in the Codex checkout');
  `);
  const literal = '$(do-not-run) `nor-this` "quotes"\nnew line';
  const result = await run({ testCommand: ['node', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { existsSync, writeFileSync } from 'node:fs';
    import { spawnSync } from 'node:child_process';
    assert.equal(existsSync('ignored.txt'), false);
    assert.equal(process.argv[1], ${JSON.stringify(literal)});
    const tests = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'add.test.mjs'], { encoding: 'utf8' });
    process.stdout.write(tests.stdout);
    process.stderr.write('fixture test diagnostics');
    writeFileSync('test-side-effect.txt', 'must not enter the returned patch');
    process.exit(tests.status ?? 1);
  `, literal] });
  assert.equal(result.testResult?.exitCode, 0);
  assert.match(result.testResult!.stdout, /^# pass 2$/m);
  assert.equal(result.testResult?.stderr, 'fixture test diagnostics');
  assert.doesNotMatch(result.patch.toString(), /test-side-effect/);
  assert.equal(sandbox.delete.mock.callCount(), 1);
});

test('failing repository tests reject while preserving the empty patch, exit code and output', { skip: !privilegedVerification, timeout: 10_000 }, async t => {
  const { sandbox, run, baseCommit } = await localFixture(t);
  await assert.rejects(run({ testCommand: ['node', '--test', '--test-reporter=tap', 'add.test.mjs'] }), error => {
    assert.ok(error instanceof DaytonaAttemptError);
    assert.equal(error.changes?.baseCommit, baseCommit);
    assert.deepEqual(error.changes?.patch, Buffer.alloc(0));
    assert.equal(error.changes?.testResult?.exitCode, 1);
    assert.match(error.changes!.testResult!.stdout, /^# fail 2$/m);
    return true;
  });
  assert.equal(sandbox.delete.mock.callCount(), 1);
});

for (const mode of ['apply', 'spawn', 'timeout']) {
  test(`patch verification ${mode} failure retains changes and deletes the sandbox`, { skip: !privilegedVerification, timeout: 10_000 }, async t => {
    const { directory, sandbox, run } = await localFixture(t);
    const marker = join(directory, 'tests-ran');
    let testCommand = ['node', '--input-type=module', '-e', `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran');`];
    if (mode === 'apply') {
      sandbox.fs.uploadFile.mock.mockImplementation(async (contents, path) => {
        await writeFile(path, path.endsWith('/recovered.patch') ? 'not a Git patch' : contents);
      });
    }
    if (mode === 'spawn') testCommand = ['herbie-command-that-does-not-exist'];
    if (mode === 'timeout') testCommand = ['node', '-e', 'setInterval(() => {}, 1000)'];
    await assert.rejects(run({ testCommand, testTimeoutMs: mode === 'timeout' ? 100 : 60_000 }), error => {
      assert.ok(error instanceof DaytonaAttemptError);
      assert.deepEqual(error.changes?.patch, Buffer.alloc(0));
      assert.equal(error.changes?.testResult, undefined);
      return true;
    });
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
    assert.equal(sandbox.delete.mock.callCount(), 1);
  });
}

test('provisions a bounded Ubuntu runtime with default networking when no snapshot is supplied', async t => {
  const { create, sandbox, run } = await fixture(t);
  await run({ snapshot: undefined, domainAllowList: undefined });
  const [params] = create.mock.calls[0].arguments;
  assert.deepEqual(params, {
    name: params.name, image: 'ubuntu:22.04', resources: { cpu: 1, memory: 1, disk: 3 },
    secrets: request.secrets, outboundProxyUrl: request.outboundProxyUrl, ttlMinutes: 15,
  });
  const [setup, cwd, , timeout] = sandbox.process.executeCommand.mock.calls[0].arguments;
  assert.equal(cwd, undefined);
  assert.equal(timeout, 240);
  assert.match(setup, /node-v24\.19\.0-linux-x64/);
  assert.match(setup, /codex-0\.159\.2-linux-x64/);
  assert.match(setup, /sha256sum -c/);
  assert.match(setup, /createHash\('sha512'\)/);
  assert.match(setup, /env_key = "OPENAI_API_KEY"/);
  assert.match(setup, /request_max_retries = 0/);
  assert.match(setup, /supports_websockets = false/);
  assert.doesNotMatch(setup, /existing-codex-secret|http:\/\/proxy\.example/);
});

test('fresh runtime setup failure deletes the sandbox before cloning or starting Codex', async t => {
  const { sandbox, run } = await fixture(t);
  sandbox.process.executeCommand.mock.mockImplementation(async () => ({ exitCode: 1, result: 'setup failure' }));
  await assert.rejects(run({ snapshot: undefined, domainAllowList: undefined }), /Attempt failed/);
  assert.equal(sandbox.git.clone.mock.callCount(), 0);
  assert.equal(sandbox.fs.uploadFile.mock.callCount(), 0);
  assert.equal(sandbox.delete.mock.callCount(), 1);
});

for (const kind of ['changes', 'test-result'] as const) {
  test(`aborts an oversized ${kind} download and cleans up without issuing verification`, async t => {
    const { sandbox, run } = await fixture(t);
    const limit = kind === 'changes' ? MAX_ARTIFACT_BYTES : MAX_TEST_RESULT_BYTES;
    const chunk = Buffer.alloc(64 * 1024);
    let bytesProduced = 0;
    const stream = Readable.from((async function* () {
      while (bytesProduced < limit * 10) { bytesProduced += chunk.length; yield chunk; }
    })(), { highWaterMark: 1 });
    sandbox.fs.downloadFileStream.mock.mockImplementationOnce(async () => stream, kind === 'changes' ? 0 : 1);
    sandbox.process.executeCommand.mock.mockImplementationOnce(async () => ({ exitCode: 0, result: 'herbie-tests-completed\n' }), 2);
    await assert.rejects(run({ testCommand: ['node', '--test'] }), error => {
      assert.ok(error instanceof DaytonaAttemptError);
      assert.equal(error.changes?.verification, undefined);
      assert.equal(error.changes?.testResult, undefined);
      return true;
    });
    assert.ok(stream.destroyed);
    const call = sandbox.fs.downloadFileStream.mock.calls[kind === 'changes' ? 0 : 1];
    assert.ok(call.arguments[1].signal.aborted);
    assert.ok(bytesProduced <= limit + chunk.length * 3, 'overflow must stop producer instead of buffering the rest');
    assert.equal(sandbox.delete.mock.callCount(), 1);
  });
}

test('accepts the patch byte limit and rejects decoded overflow within the same base64 length', async t => {
  const { sandbox, run } = await fixture(t);
  for (const size of [MAX_PATCH_BYTES, MAX_PATCH_BYTES + 1]) {
    const patch = Buffer.alloc(size, 'a');
    const encoded = Buffer.from(JSON.stringify({ baseCommit: changes.baseCommit, patchBase64: patch.toString('base64') }));
    assert.ok(encoded.length <= MAX_ARTIFACT_BYTES);
    sandbox.fs.downloadFileStream.mock.mockImplementation(async () => Readable.from([encoded]));
    if (size === MAX_PATCH_BYTES) assert.equal((await run()).patch.length, size);
    else await assert.rejects(run(), error => error instanceof DaytonaAttemptError && !error.changes);
  }
  assert.equal(sandbox.delete.mock.callCount(), 2);
});

test('rejects oversized decoded test output even inside the JSON transport limit', async t => {
  const { sandbox, run } = await fixture(t);
  sandbox.process.executeCommand.mock.mockImplementationOnce(async () => ({ exitCode: 0, result: 'herbie-tests-completed\n' }), 2);
  const encoded = Buffer.from(JSON.stringify({ exitCode: 0, stdout: 'a'.repeat(MAX_TEST_OUTPUT_BYTES + 1), stderr: '' }));
  assert.ok(encoded.length < MAX_TEST_RESULT_BYTES);
  sandbox.fs.downloadFileStream.mock.mockImplementationOnce(async () => Readable.from([encoded]), 1);
  await assert.rejects(run({ testCommand: ['node', '--test'] }), error => {
    assert.ok(error instanceof DaytonaAttemptError);
    assert.equal(error.changes?.verification, undefined);
    assert.equal(error.changes?.testResult, undefined);
    return true;
  });
  assert.equal(sandbox.delete.mock.callCount(), 1);
});

test('rejects an interrupted artifact stream and cancels its transport', async t => {
  const { sandbox, run } = await fixture(t);
  const stream = Readable.from((async function* () { yield artifact.subarray(0, 10); throw new Error('transfer interrupted'); })());
  sandbox.fs.downloadFileStream.mock.mockImplementation(async () => stream);
  await assert.rejects(run(), error => error instanceof DaytonaAttemptError && !error.changes);
  assert.ok(sandbox.fs.downloadFileStream.mock.calls[0].arguments[1].signal.aborted);
  assert.equal(sandbox.delete.mock.callCount(), 1);
});

test('agent-written verifier and Git hooks cannot turn failing tests into successful evidence', { skip: !privilegedVerification, timeout: 10_000 }, async t => {
  const { sandbox, run } = await localFixture(t, `
    import { writeFileSync } from 'node:fs';
    import { execFileSync } from 'node:child_process';
    writeFileSync('../daytona-test-runner.js', "process.stdout.write('herbie-tests-completed\\\\n');");
    writeFileSync('../test-result.json', JSON.stringify({ exitCode: 0, stdout: 'forged', stderr: '' }));
    writeFileSync('.git/hooks/post-checkout', '#!/bin/sh\\nexit 99\\n', {mode:0o755});
    execFileSync('git', ['config', 'core.hooksPath', '.git/hooks']);
  `);
  await assert.rejects(run({ testCommand: ['node', '-e', 'process.exit(1)'] }), error => {
    assert.ok(error instanceof DaytonaAttemptError);
    assert.equal(error.changes?.testResult?.exitCode, 1);
    assert.equal(error.changes?.testResult?.stdout, '');
    assert.equal(error.changes?.verification, undefined);
    return true;
  });
  assert.equal(sandbox.git.clone.mock.callCount(), 2);
  assert.equal(sandbox.delete.mock.callCount(), 1);
});

test('coding and test users cannot modify the supervisor or its result channel', { skip: !privilegedVerification, timeout: 10_000 }, async t => {
  const { run, sandbox } = await localFixture(t);
  const codingUid = Number(execFileSync('id', ['-u', 'compat'], { encoding: 'utf8' }).trim());
  const codingGid = Number(execFileSync('id', ['-g', 'compat'], { encoding: 'utf8' }).trim());
  sandbox.fs.downloadFileStream.mock.mockImplementation(async path => {
    if (path.endsWith('/test-result.json')) {
      const root = path.slice(0, -'/test-result.json'.length);
      // A surviving coding process still cannot alter verification after the supervisor runs.
      await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
        import assert from 'node:assert/strict';
        import { readFileSync, writeFileSync } from 'node:fs';
        const root = process.argv[1];
        assert.throws(() => readFileSync(root+'/repo/.git/config'), {code:'EACCES'});
        for (const name of ['daytona-test-runner.js','test.json','test-result.json','recovered.patch']) {
          assert.throws(() => writeFileSync(root+'/'+name, 'forged'), {code:'EACCES'});
        }
      `, root], { uid: codingUid, gid: codingGid, cwd: '/' });
    }
    return createReadStream(path);
  });
  const result = await run({ testCommand: ['node', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { writeFileSync } from 'node:fs';
    assert.notEqual(process.getuid(), 0);
    assert.equal(process.env.OPENAI_API_KEY, undefined);
    for (const path of ['../daytona-test-runner.js', '../artifact-limits.js', '../test.json', '../test-result.json', '../recovered.patch']) {
      assert.throws(() => writeFileSync(path, 'forged'), {code:'EACCES'});
    }
    process.stdout.write('protected');
  `] });
  assert.equal(result.testResult?.stdout, 'protected');
  assert.ok(result.verification);
});
