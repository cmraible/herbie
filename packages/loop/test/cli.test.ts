import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createInterface } from 'node:readline';

const entrypoint = fileURLToPath(new URL('../src/index.ts', import.meta.url));

function runCli(args: string[], env: NodeJS.ProcessEnv = { ...process.env, PATH: '' }) {
  return spawnSync(process.execPath, ['--import', 'tsx', entrypoint, ...args], {
    encoding: 'utf8',
    timeout: 10_000,
    env,
  });
}

async function fakeCodex(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'herbie-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = fileURLToPath(new URL('fixtures/codex.ts', import.meta.url));
  await symlink(fixture, join(directory, 'codex'));
  await symlink(process.execPath, join(directory, 'node'));
  const record = join(directory, 'invocation.json');
  return { directory, record, env: { ...process.env, PATH: directory, CODEX_TEST_RECORD: record } };
}

test('runs one Codex attempt with the repository and goal, exposing both output streams', async t => {
  const { env, record, directory } = await fakeCodex(t);
  const repo = join(directory, 'my project');
  await mkdir(repo);
  const result = runCli(['--repo', repo, '--goal', 'Improve error messages'], env);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(`Repository: ${repo}`));
  assert.match(result.stdout, /Goal: Improve error messages/);
  assert.match(result.stdout, /Codex test output/);
  assert.match(result.stderr, /Codex test diagnostics/);
  const args: unknown = JSON.parse(await readFile(record, 'utf8'));
  assert.deepEqual(args, [
    'exec', '--cd', repo, '--sandbox', 'workspace-write',
    [
      'Make one small improvement aligned with the goal below.',
      'Read the repository instructions, implement the change, and run proportionate tests.',
      'Keep the code minimal and readable. Summarize the change and verification.',
      'Leave changes local. Do not commit, push, create a pull request, or merge.',
      '',
      'Goal: Improve error messages',
    ].join('\n'),
  ]);
});

test('preserves a failed Codex exit status', async t => {
  const { env, directory } = await fakeCodex(t);
  const result = runCli(['--repo', directory, '--goal', 'Improve errors'], {
    ...env, CODEX_TEST_EXIT: '7',
  });
  assert.equal(result.status, 7);
  assert.match(result.stderr, /Codex test diagnostics/);
});

test('reports a child terminated by a signal as failure', async t => {
  const { env, directory } = await fakeCodex(t);
  const result = runCli(['--repo', directory, '--goal', 'Improve errors'], {
    ...env, CODEX_TEST_SIGNAL: '1',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Codex stopped by SIGTERM/);
});

test('reports a missing Codex executable', async t => {
  const { env, directory } = await fakeCodex(t);
  await rm(join(directory, 'codex'));
  const result = runCli(['--repo', directory, '--goal', 'Improve errors'], env);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Could not start Codex/);
});

test('rejects a missing repository or a file before starting Codex', async t => {
  const { env, directory, record } = await fakeCodex(t);
  for (const repo of [join(directory, 'missing'), entrypoint]) {
    const result = runCli(['--repo', repo, '--goal', 'Improve errors'], env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ENOENT|must point to a directory/);
    await assert.rejects(readFile(record), { code: 'ENOENT' });
  }
});

test('help explains the required inputs', () => {
  const result = runCli(['--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--repo <path> --goal <goal>/);
});

test('streams output before Codex finishes and inherits stdin', { timeout: 10_000 }, async t => {
  const { env, directory } = await fakeCodex(t);
  const child = spawn(process.execPath, [
    '--import', 'tsx', entrypoint, '--repo', directory, '--goal', 'Improve errors',
  ], { env: { ...env, CODEX_TEST_WAIT: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const closed = once(child, 'close');
  const lines = createInterface({ input: child.stdout });
  t.after(() => lines.close());
  let sawOutput = false;
  for await (const line of lines) {
    if (line === 'Codex test output') {
      sawOutput = true;
      child.stdin.end('finish\n');
      break;
    }
  }
  assert.equal(sawOutput, true);
  const [code] = await closed;
  assert.equal(code, 0);
});

test('rejects missing, blank, and unknown inputs', () => {
  for (const args of [
    [],
    ['--repo', '/tmp/project'],
    ['--goal', 'Improve errors'],
    ['--repo', ' ', '--goal', 'Improve errors'],
    ['--repo', '/tmp/project', '--goal', ' '],
    ['--unknown'],
  ]) {
    const result = runCli(args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:/);
  }
});
