import { execFile } from 'node:child_process';
import { chmod, chown, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { DaytonaTestResult } from './daytona-attempt.js';
import { MAX_PATCH_BYTES, MAX_TEST_OUTPUT_BYTES } from './artifact-limits.js';

// Root-owned supervisor in a fresh, private directory. Repository commands always
// run as herbie-verify, distinct from both root and the compat coding process.
try {
  if (process.getuid?.() !== 0) throw new Error('Verification supervisor requires root');
  const directory = fileURLToPath(new URL('.', import.meta.url));
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.uid !== 0 || (metadata.mode & 0o777) !== 0o700) throw new Error('Untrusted verification directory');
  const input: unknown = JSON.parse(await readFile(new URL('./test.json', import.meta.url), 'utf8'));
  if (typeof input !== 'object' || input === null
    || !('baseCommit' in input) || typeof input.baseCommit !== 'string' || !/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(input.baseCommit)
    || !('command' in input) || !Array.isArray(input.command) || !input.command.length
    || !input.command.every((arg: unknown): arg is string => typeof arg === 'string')
    || !('timeoutMs' in input) || typeof input.timeoutMs !== 'number') throw new Error('Invalid repository test input');
  const run = promisify(execFile);
  const uid = Number((await run('/usr/bin/id', ['-u', 'herbie-verify'])).stdout.trim());
  const gid = Number((await run('/usr/bin/id', ['-g', 'herbie-verify'])).stdout.trim());
  const codingUid = Number((await run('/usr/bin/id', ['-u', 'compat'])).stdout.trim());
  if (!Number.isSafeInteger(uid) || uid <= 0 || uid === codingUid || !Number.isSafeInteger(gid) || gid <= 0) throw new Error('Invalid verification identity');
  const checkout = fileURLToPath(new URL('./repo', import.meta.url));
  const home = fileURLToPath(new URL('./home', import.meta.url));
  await mkdir(home, { mode: 0o700 });
  await chown(home, uid, gid);
  // The freshly cloned checkout has never been accessible to the coding user.
  await run('/usr/bin/chown', ['-R', '--no-dereference', `${uid}:${gid}`, checkout]);
  await chmod(checkout, 0o700);
  for (const name of ['daytona-test-runner.js', 'artifact-limits.js', 'test.json']) {
    await chmod(new URL(`./${name}`, import.meta.url), 0o600);
  }
  await chmod(new URL('./package.json', import.meta.url), 0o444);
  const patchFile = fileURLToPath(new URL('./recovered.patch', import.meta.url));
  const patch = await lstat(patchFile);
  if (!patch.isFile() || patch.size > MAX_PATCH_BYTES) throw new Error('Invalid verification patch');
  await chmod(patchFile, 0o444);
  // Permit traversal to the private checkout; no unprivileged user can write to
  // this directory or to the supervisor, input, patch, or result file.
  await chmod(directory, 0o711);
  const networkVariables = new Set(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'NODE_EXTRA_CA_CERTS']);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => networkVariables.has(key))),
    HOME: home, PATH: '/usr/local/bin:/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  const unprivileged = (command: string, args: string[], timeout: number) => run(command, args, {
    uid, gid, cwd: checkout, env, timeout, killSignal: 'SIGKILL', maxBuffer: MAX_TEST_OUTPUT_BYTES,
  });
  const head = await unprivileged('git', ['rev-parse', 'HEAD'], 30_000);
  if (head.stdout.trim() !== input.baseCommit) throw new Error('Verification clone does not match the recovered base');
  // Ownership transfer changes index stat metadata without changing repository bytes.
  await unprivileged('git', ['update-index', '--refresh'], 30_000);
  if (patch.size) {
    await unprivileged('git', ['-c', 'core.hooksPath=/dev/null', 'apply', '--index', patchFile], 30_000);
  }
  let result: DaytonaTestResult;
  try {
    const { stdout, stderr } = await unprivileged(input.command[0], input.command.slice(1), input.timeoutMs);
    result = { exitCode: 0, stdout, stderr };
  } catch (error) {
    // A test assertion failure is a completed result; timeouts/signals/spawn errors are not.
    if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'number'
      || !('stdout' in error) || typeof error.stdout !== 'string'
      || !('stderr' in error) || typeof error.stderr !== 'string') throw error;
    result = { exitCode: error.code, stdout: error.stdout, stderr: error.stderr };
  }
  await writeFile(new URL('./test-result.json', import.meta.url), JSON.stringify(result), { mode: 0o600, flag: 'wx' });
  process.stdout.write('herbie-tests-completed\n');
} catch {
  console.error('Sandbox patch verification failed');
  process.exitCode = 1;
}
