import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const entrypoint = fileURLToPath(new URL('../src/index.ts', import.meta.url));

function runCli(args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', entrypoint, ...args], {
    encoding: 'utf8',
    timeout: 10_000,
  });
}

test('accepts a repository and a goal containing spaces', () => {
  const result = runCli(['--repo', '/tmp/my project', '--goal', 'Improve error messages']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Repository: \/tmp\/my project/);
  assert.match(result.stdout, /Goal: Improve error messages/);
});

test('help explains the required inputs', () => {
  const result = runCli(['--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--repo <path> --goal <goal>/);
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
