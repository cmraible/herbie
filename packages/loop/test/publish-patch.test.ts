import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { mock, test, type TestContext } from 'node:test';
import { runDaytonaAttempt } from '../src/daytona-attempt.js';
import { PatchPublicationError, publishTestedPatch } from '../src/publish-patch.js';
import { createArithmeticFixture, runArithmeticTests } from './fixtures/arithmetic.js';

const git = async (cwd: string, ...args: string[]) => (await promisify(execFile)('git', args, { cwd, timeout: 30_000 })).stdout.trim();

async function fixture(t: TestContext, extraFiles = false) {
  const directory = await mkdtemp(join(tmpdir(), 'herbie-publisher-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repo = join(directory, 'source');
  const baseCommit = createArithmeticFixture(repo).trim();
  const remote = join(directory, 'remote.git');
  await git(directory, 'clone', '--bare', repo, remote);
  await writeFile(join(repo, 'add.mjs'), 'export function add(a, b) {\n  return a + b;\n}\n');
  if (extraFiles) {
    await writeFile(join(repo, 'binary.dat'), Buffer.from([0, 255, 1, 254]));
    await writeFile(join(repo, 'latin1.txt'), Buffer.from('café\n', 'latin1'));
    await writeFile(join(repo, 'empty.txt'), '');
    await writeFile(join(repo, '.gitattributes'), '*.txt filter=fixture\n');
    await chmod(join(repo, 'add.mjs'), 0o755);
  }
  runArithmeticTests(repo, 0);
  await git(repo, 'add', '--all');
  const patchFile = join(directory, 'changes.patch');
  await git(repo, 'diff', '--cached', '--binary', '--full-index', `--output=${patchFile}`, baseCommit);
  const patch = await readFile(patchFile);
  const runtime = join(directory, 'runtime');
  await mkdir(runtime);
  for (const name of ['codex-initialize', 'codex-thread', 'codex-turn', 'codex-process', 'daytona-runner', 'daytona-test-runner', 'artifact-limits']) {
    await writeFile(join(runtime, `${name}.js`), '');
  }
  const changes = await runDaytonaAttempt(async () => ({
    id: 'fixture', delete: async () => {}, git: { clone: async () => {} },
    fs: {
      createFolder: async () => {}, uploadFile: async () => {},
      downloadFileStream: async path => Readable.from([Buffer.from(JSON.stringify(path.endsWith('/changes.json')
        ? { baseCommit, patchBase64: patch.toString('base64') }
        : { exitCode: 0, stdout: '2 tests passed', stderr: '' }))]),
    },
    process: { executeCommand: async command => ({ exitCode: 0,
      result: command.includes('daytona-test-runner') ? 'herbie-tests-completed\n' : 'herbie-attempt-completed\n',
    }) },
  }), {
    snapshot: 'fixture', domainAllowList: 'github.com', repoUrl: 'https://github.com/example/repo.git',
    goal: 'Fix addition', testCommand: ['node', '--test', 'add.test.mjs'],
  }, () => {}, pathToFileURL(runtime + '/'));

  // All publisher Git traffic is redirected to this local bare fixture, never GitHub.
  const config = join(directory, 'gitconfig');
  await git(directory, 'config', '--file', config, `url.${pathToFileURL(remote).href}.insteadOf`, 'https://github.com/example/repo.git');
  await git(directory, 'config', '--file', config, 'user.name', 'Publisher Fixture');
  await git(directory, 'config', '--file', config, 'user.email', 'fixture@example.invalid');
  const scratch = join(directory, 'scratch');
  await mkdir(scratch);
  const environment = { GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1', TMPDIR: scratch };
  for (const [key, value] of Object.entries(environment)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  const createPullRequest = mock.fn<Parameters<typeof publishTestedPatch>[0]>(async () => ({ url: 'https://github.com/example/repo/pull/1' }));
  const request = { repository: 'example/repo', baseBranch: 'main', branch: 'herbie/fix-addition', title: 'Fix addition', body: 'Tested arithmetic fix', changes };
  const publish = () => publishTestedPatch(createPullRequest, request);
  return { directory, repo, remote, config, scratch, changes, request, createPullRequest, publish };
}

test('publishes a verified patch as one commit and one draft PR without changing the source checkout', async t => {
  const { repo, remote, scratch, changes, request, createPullRequest, publish } = await fixture(t);
  const before = await git(repo, 'status', '--porcelain');
  const result = await publish();
  assert.equal(result.url, 'https://github.com/example/repo/pull/1');
  assert.equal(await git(remote, 'rev-parse', request.branch), result.commit);
  assert.equal(await git(remote, 'rev-parse', `${result.commit}^`), changes.baseCommit);
  assert.equal(await git(remote, 'show', `${result.commit}:add.mjs`), 'export function add(a, b) {\n  return a + b;\n}');
  assert.deepEqual(createPullRequest.mock.calls[0].arguments, [{
    repository: request.repository, base: 'main', head: request.branch, title: request.title, body: request.body, draft: true,
  }]);
  assert.equal(createPullRequest.mock.callCount(), 1);
  assert.equal(await git(repo, 'status', '--porcelain'), before);
  assert.deepEqual(await readdir(scratch), []);
});

test('accepts Git identity and authentication configuration only for this publication', async t => {
  const { request, remote, createPullRequest } = await fixture(t);
  const previousName = process.env.GIT_AUTHOR_NAME;
  const result = await publishTestedPatch(createPullRequest, { ...request, gitEnvironment: {
    GIT_AUTHOR_NAME: 'Herbie App', GIT_AUTHOR_EMAIL: 'herbie@example.invalid',
    GIT_COMMITTER_NAME: 'Herbie App', GIT_COMMITTER_EMAIL: 'herbie@example.invalid',
  } });
  assert.equal(await git(remote, 'show', '--format=%an <%ae>', '--no-patch', result.commit), 'Herbie App <herbie@example.invalid>');
  assert.equal(process.env.GIT_AUTHOR_NAME, previousName);
});

for (const invalid of ['unverified', 'legacy verifier', 'untested', 'failed tests', 'incomplete goal', 'unconfirmed cleanup', 'changed bytes', 'changed base', 'wrong repo', 'empty']) {
  test(`rejects ${invalid} evidence without publication`, async t => {
    const { changes, scratch, createPullRequest, publish } = await fixture(t);
    if (invalid === 'legacy verifier') delete changes.verification!.version;
    if (invalid === 'unverified') delete changes.verification;
    if (invalid === 'untested') delete changes.testResult;
    if (invalid === 'failed tests') changes.testResult!.exitCode = 1;
    if (invalid === 'incomplete goal') Object.assign(changes.verification!, { goalCompleted: false });
    if (invalid === 'unconfirmed cleanup') Object.assign(changes.verification!, { sandboxDeleted: false });
    if (invalid === 'changed bytes') changes.patch[0] ^= 1;
    if (invalid === 'changed base') changes.baseCommit = 'a'.repeat(40);
    if (invalid === 'wrong repo') changes.verification!.repoUrl = 'https://github.com/other/repo.git';
    if (invalid === 'empty') {
      changes.patch = Buffer.alloc(0);
      changes.verification!.patchSha256 = createHash('sha256').update(changes.patch).digest('hex');
    }
    await assert.rejects(publish(), invalid === 'empty' ? /empty patch/ : /evidence is required/);
    assert.equal(createPullRequest.mock.callCount(), 0);
    assert.deepEqual(await readdir(scratch), []);
  });
}

test('publishes the checked bytes even if the caller mutates its buffer while publishing', async t => {
  const { changes, remote, publish } = await fixture(t);
  const pending = publish();
  changes.patch.fill(0);
  const { commit } = await pending;
  assert.match(await git(remote, 'show', `${commit}:add.mjs`), /return a \+ b/);
});

for (const problem of ['existing branch', 'base drift', 'invalid patch']) {
  test(`rejects ${problem} before pushing or opening a PR`, async t => {
    const { changes, request, remote, scratch, createPullRequest, publish } = await fixture(t);
    if (problem === 'existing branch') await git(remote, 'update-ref', `refs/heads/${request.branch}`, changes.baseCommit);
    if (problem === 'base drift') {
      const tree = await git(remote, 'rev-parse', 'main^{tree}');
      const next = await git(remote, 'commit-tree', tree, '-p', changes.baseCommit, '-m', 'Main advanced');
      await git(remote, 'update-ref', 'refs/heads/main', next);
    }
    if (problem === 'invalid patch') {
      changes.patch = Buffer.from('not a Git patch');
      changes.verification!.patchSha256 = createHash('sha256').update(changes.patch).digest('hex');
    }
    await assert.rejects(publish(), error => {
      assert.ok(error instanceof PatchPublicationError);
      assert.equal(error.publication.stage, 'preparing');
      assert.equal(error.publication.commit, undefined);
      return true;
    });
    assert.equal(createPullRequest.mock.callCount(), 0);
    assert.equal(await git(remote, 'branch', '--list', request.branch), problem === 'existing branch' ? request.branch : '');
    if (problem === 'existing branch') assert.equal(await git(remote, 'rev-parse', request.branch), changes.baseCommit);
    assert.deepEqual(await readdir(scratch), []);
  });
}

test('a push failure reports uncertain remote state without opening a PR or retrying', async t => {
  const { remote, scratch, request, createPullRequest, publish } = await fixture(t);
  await writeFile(join(remote, 'hooks', 'pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  await assert.rejects(publish(), error => {
    assert.ok(error instanceof PatchPublicationError);
    assert.equal(error.publication.stage, 'pushing');
    assert.match(error.publication.commit!, /^[0-9a-f]{40}$/);
    return true;
  });
  assert.equal(await git(remote, 'branch', '--list', request.branch), '');
  assert.equal(createPullRequest.mock.callCount(), 0);
  assert.deepEqual(await readdir(scratch), []);
});

test('a lost GitHub response retains the pushed branch and blocks blind retry', async t => {
  const { remote, scratch, request, createPullRequest, publish } = await fixture(t);
  createPullRequest.mock.mockImplementation(async () => { throw new Error('private API response lost'); });
  await assert.rejects(publish(), error => {
    assert.ok(error instanceof PatchPublicationError);
    assert.equal(error.publication.stage, 'opening-pr');
    assert.equal(error.publication.branch, request.branch);
    assert.equal(error.publication.url, undefined);
    assert.doesNotMatch(error.message, /private/);
    return true;
  });
  const pushed = await git(remote, 'rev-parse', request.branch);
  await assert.rejects(publish(), error => error instanceof PatchPublicationError && error.publication.stage === 'preparing');
  assert.equal(await git(remote, 'rev-parse', request.branch), pushed);
  assert.equal(createPullRequest.mock.callCount(), 1);
  assert.deepEqual(await readdir(scratch), []);
});

test('does not overwrite a branch created between the initial check and push', async t => {
  const { directory, config, remote, changes, request, createPullRequest, publish } = await fixture(t);
  const hooks = join(directory, 'hooks');
  await mkdir(hooks);
  await writeFile(join(hooks, 'pre-push'), `#!/bin/sh\ngit --git-dir='${remote}' update-ref refs/heads/${request.branch} ${changes.baseCommit}\n`, { mode: 0o700 });
  await git(directory, 'config', '--file', config, 'core.hooksPath', hooks);
  await assert.rejects(publish(), error => error instanceof PatchPublicationError && error.publication.stage === 'pushing');
  assert.equal(await git(remote, 'rev-parse', request.branch), changes.baseCommit);
  assert.equal(createPullRequest.mock.callCount(), 0);
});

test('preserves binary/non-UTF-8 files and modes without executing checkout filters', async t => {
  const { directory, config, remote, publish } = await fixture(t, true);
  const marker = join(directory, 'filter-ran');
  const filter = join(directory, 'filter.mjs');
  await writeFile(filter, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran'); process.stdin.pipe(process.stdout);`);
  const filterCommand = `${process.execPath} '${filter.replaceAll("'", "'\\''")}'`;
  await git(directory, 'config', '--file', config, 'filter.fixture.clean', filterCommand);
  await git(directory, 'config', '--file', config, 'filter.fixture.smudge', filterCommand);
  const { commit } = await publish();
  const blob = async (path: string) => (await promisify(execFile)('git', ['show', `${commit}:${path}`], { cwd: remote, encoding: 'buffer' })).stdout;
  assert.deepEqual(await blob('binary.dat'), Buffer.from([0, 255, 1, 254]));
  assert.deepEqual(await blob('latin1.txt'), Buffer.from('café\n', 'latin1'));
  assert.deepEqual(await blob('empty.txt'), Buffer.alloc(0));
  assert.match(await git(remote, 'ls-tree', commit, 'add.mjs'), /^100755 /);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('a lost publication lease after local Git preparation prevents the push and PR creation', async t => {
  const { remote, request, scratch, createPullRequest } = await fixture(t);
  await assert.rejects(publishTestedPatch(createPullRequest, {
    ...request,
    beforeWrite: async () => { throw new Error('Worker lease lost'); },
  }), error => {
    assert.ok(error instanceof PatchPublicationError);
    assert.equal(error.publication.stage, 'preparing');
    assert.match(error.publication.commit ?? '', /^[0-9a-f]{40}$/);
    return true;
  });
  assert.equal(await git(remote, 'branch', '--list', request.branch), '');
  assert.equal(createPullRequest.mock.callCount(), 0);
  assert.deepEqual(await readdir(scratch), []);
});

test('a lease lost after push preserves the branch but prevents PR creation', async t => {
  const { remote, request, scratch, createPullRequest } = await fixture(t);
  let ownership = true;
  await assert.rejects(publishTestedPatch(createPullRequest, {
    ...request,
    beforeWrite: async () => {
      if (!ownership) throw new Error('Worker lease lost');
      ownership = false;
    },
  }), error => {
    assert.ok(error instanceof PatchPublicationError);
    assert.equal(error.publication.stage, 'pushing');
    return true;
  });
  assert.match(await git(remote, 'rev-parse', request.branch), /^[0-9a-f]{40}$/);
  assert.equal(createPullRequest.mock.callCount(), 0);
  assert.deepEqual(await readdir(scratch), []);
});
