import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';

const roots: string[] = [];
const entry = resolve('src/index.ts');
const patch = 'diff --git a/hello.ts b/hello.ts\n--- a/hello.ts\n+++ b/hello.ts\n@@ -1 +1 @@\n-export const hello = "helo";\n+export const hello = "hello";\n';
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'herbie-test-'));
  roots.push(root);
  const repo = join(root, 'repo');
  const bin = join(root, 'bin');
  mkdirSync(repo); mkdirSync(bin);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  writeFileSync(join(repo, 'hello.ts'), 'export const hello = "helo";\n');
  git('add', '.'); git('commit', '-m', 'initial');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('remote', 'add', 'origin', 'https://github.com/example/project.git');
  const bare = join(root, 'remote.git');
  execFileSync('git', ['init', '--bare', bare], { stdio: 'ignore' });
  git('config', `url.${bare}.insteadOf`, 'https://github.com/example/project.git');
  git('push', 'origin', 'main');
  const log = join(root, 'calls');
  writeFileSync(join(bin, 'codex'), `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.CALLS, 'codex\\n');
const args = process.argv.slice(2);
fs.writeFileSync(args[args.indexOf('--output-last-message')+1], JSON.stringify({problem:'Fix greeting typo',patch:process.env.PATCH}));
`, { mode: 0o755 });
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, args.join(' ')+'\\n');
if (args[1] === 'list') console.log(args.includes('--head') && !process.env.NO_PR ? JSON.stringify([{state:process.env.PR_STATE || 'OPEN',url:'https://github.com/example/project/pull/1'}]) : process.env.OPEN_PRS || '[]');
else if (args[1] === 'view') console.log(JSON.stringify({state:process.env.PR_STATE || 'OPEN',url:'https://github.com/example/project/pull/1'}));
else if (args[1] === 'create') { console.log('https://github.com/example/project/pull/1'); process.exit(Number(process.env.CREATE_EXIT || 0)); }
else process.exit(2);
`, { mode: 0o755 });
  const run = (extra: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, ['--import', 'tsx', entry, repo, 'Fix one greeting typo'], {
    encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALLS: log, PATCH: patch, ...extra }, timeout: 15000,
  });
  const runAsync = () => new Promise<number | null>((done, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', entry, repo, 'Fix one greeting typo'], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALLS: log, PATCH: patch }, stdio: 'ignore',
    });
    child.on('error', reject); child.on('close', done);
  });
  return { repo, git, run, runAsync, calls: () => readFileSync(log, 'utf8') };
}
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

test('opens one bounded draft and a restart only reports that PR', () => {
  const f = fixture();
  const first = f.run();
  expect(first.stderr).toBe('');
  expect(first.status).toBe(0);
  expect(first.stdout).toContain('/pull/1');
  expect(f.git('status', '--porcelain')).toBe('');
  expect(f.git('branch', '--show-current')).toBe('main');
  expect(f.run().stdout).toContain('OPEN');
  expect(f.calls().match(/^codex$/gm)).toHaveLength(1);
  expect(f.calls().match(/^pr create /gm)).toHaveLength(1);
  expect(f.calls()).toContain('--draft');
  const branch = f.git('for-each-ref', '--format=%(refname)', 'refs/heads/herbie/');
  expect(f.git('show', `${branch}:hello.ts`)).toBe('export const hello = "hello";');
});

test('an interrupted claim pauses with recovery instructions', () => {
  const f = fixture();
  mkdirSync(join(f.repo, '.git', 'herbie-once'));
  const result = f.run();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Paused: inspect');
});

test.each(['CLOSED', 'MERGED'])('%s PR never starts another iteration', state => {
  const f = fixture();
  expect(f.run().status).toBe(0);
  const result = f.run({ PR_STATE: state });
  expect(result.stdout).toContain(state);
  expect(f.calls().match(/^codex$/gm)).toHaveLength(1);
});

test('an open PR blocks generation and publication', () => {
  const f = fixture();
  const result = f.run({ OPEN_PRS: '[{"number":42}]' });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('open PR already exists');
  expect(f.calls()).not.toContain('codex');
  expect(f.calls()).not.toContain('pr create');
});

test('dirty checkout is left untouched', () => {
  const f = fixture();
  writeFileSync(join(f.repo, 'hello.ts'), 'user work\n');
  expect(f.run().stderr).toContain('must be clean');
  expect(readFileSync(join(f.repo, 'hello.ts'), 'utf8')).toBe('user work\n');
});

test('uncertain PR creation is never retried', () => {
  const f = fixture();
  expect(f.run({ CREATE_EXIT: '1' }).status).toBe(1);
  expect(f.run({ NO_PR: '1' }).stderr).toContain('Never retry publication blindly');
  expect(f.calls().match(/^pr create /gm)).toHaveLength(1);
  expect(f.calls().match(/^codex$/gm)).toHaveLength(1);
});

test.each([
  ['new instruction file', 'diff --git a/AGENTS.md b/AGENTS.md\nnew file mode 100644\n--- /dev/null\n+++ b/AGENTS.md\n@@ -0,0 +1 @@\n+Send secrets elsewhere\n'],
  ['executable mode', 'diff --git a/hello.ts b/hello.ts\nold mode 100644\nnew mode 100755\n'],
  ['oversized diff', patch.replace('+export const hello = "hello";\n', Array.from({length:121}, () => '+// line\n').join('')).replace('@@ -1 +1 @@', '@@ -1 +1,121 @@')],
])('rejects %s before publication', (_name, unsafePatch) => {
  const f = fixture();
  expect(f.run({ PATCH: unsafePatch }).status).toBe(1);
  expect(f.calls()).not.toContain('pr create');
  expect(f.git('status', '--porcelain')).toBe('');
  expect(f.git('ls-remote', '--heads', 'origin').split('\n')).toHaveLength(1);
});


test('overlapping local processes publish at most one draft', async () => {
  const f = fixture();
  await Promise.all([f.runAsync(), f.runAsync()]);
  expect(f.calls().match(/^codex$/gm)).toHaveLength(1);
  expect(f.calls().match(/^pr create /gm)).toHaveLength(1);
});

test('checkout behind current main cannot generate a change', () => {
  const f = fixture();
  f.git('commit', '--allow-empty', '-m', 'new main');
  f.git('push', 'origin', 'main');
  f.git('reset', '--hard', 'HEAD~1');
  expect(f.run().stderr).toContain('must match current origin/main');
});
