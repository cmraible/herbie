import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { DaytonaAttemptChanges } from './daytona-attempt.js';
import { MAX_PATCH_BYTES } from './artifact-limits.js';

type CreatePullRequest = (request: {
  repository: string; base: string; head: string; title: string; body: string; draft: true;
}) => Promise<{ url: string }>;
type Request = {
  repository: string; baseBranch: string; branch: string; title: string; body: string;
  changes: DaytonaAttemptChanges;
  // Durable callers must confirm current lease ownership immediately before remote writes.
  beforeWrite?: () => Promise<void>;
  // Trusted caller-owned, per-process auth/identity. Never persist credentials in Git config.
  gitEnvironment?: Readonly<Record<string, string>>;
};

export interface PublicationState {
  repository: string;
  branch: string;
  stage: 'preparing' | 'pushing' | 'opening-pr' | 'published';
  commit?: string;
  url?: string;
}

export class PatchPublicationError extends AggregateError {
  constructor(errors: unknown[], readonly publication: PublicationState) {
    super(errors, `Patch publication failed during ${publication.stage} for ${publication.repository}:${publication.branch}; inspect remote state before retrying`);
  }
}

// Host-only: use existing Git authentication and a caller-owned GitHub API client.
// No checkout, repository scripts, dependency installation, or sandbox credentials.
export async function publishTestedPatch(createPullRequest: CreatePullRequest, request: Request): Promise<{ url: string; branch: string; commit: string }> {
  const { repository, baseBranch, branch, title, body, changes } = request;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !title.trim() || !branch || !baseBranch || branch === baseBranch) {
    throw new Error('Repository, distinct branch names, and a PR title are required');
  }
  const remoteUrl = `https://github.com/${repository}.git`;
  const { verification, baseCommit } = changes;
  if (changes.patch.length > MAX_PATCH_BYTES) throw new Error('Repository patch exceeds its byte limit');
  const patch = Buffer.from(changes.patch);
  if (!verification || verification.version !== 2 || verification.goalCompleted !== true || verification.sandboxDeleted !== true
    || changes.testResult?.exitCode !== 0 || !verification.testCommand.length
    || verification.baseCommit !== baseCommit || !/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(baseCommit)
    || ![remoteUrl, remoteUrl.slice(0, -4)].includes(verification.repoUrl)
    || verification.patchSha256 !== createHash('sha256').update(patch).digest('hex')) {
    throw new Error('Matching successful goal, test, and cleanup evidence is required for this patch');
  }
  if (!patch.length) throw new Error('Cannot publish an empty patch');

  const directory = await mkdtemp(join(tmpdir(), 'herbie-publish-'));
  const state: PublicationState = { repository, branch, stage: 'preparing' };
  const failures: unknown[] = [];
  let result: { url: string; branch: string; commit: string } | undefined;
  try {
    const bare = join(directory, 'repo.git');
    const git = async (...args: string[]) => (await promisify(execFile)('git', ['--git-dir', bare, ...args], {
      cwd: directory, timeout: 30_000, killSignal: 'SIGKILL',
      env: { ...process.env, ...request.gitEnvironment, GIT_INDEX_FILE: join(directory, 'index'), GIT_TERMINAL_PROMPT: '0' },
    })).stdout.trim();
    await git('init', '--bare', '--template=', bare);
    const headRef = `refs/heads/${branch}`;
    await git('check-ref-format', headRef);
    await git('check-ref-format', `refs/heads/${baseBranch}`);
    await git('remote', 'add', 'origin', remoteUrl);
    if (await git('ls-remote', '--heads', 'origin', headRef)) throw new Error('Publication branch already exists');
    await git('fetch', '--no-tags', 'origin', `refs/heads/${baseBranch}`);
    if (await git('rev-parse', 'FETCH_HEAD^{commit}') !== baseCommit) throw new Error('Base branch changed; retest before publishing');
    await git('read-tree', baseCommit);
    const patchFile = join(directory, 'changes.patch');
    await writeFile(patchFile, patch);
    await git('apply', '--cached', '--binary', patchFile);
    const tree = await git('write-tree');
    if (tree === await git('rev-parse', `${baseCommit}^{tree}`)) throw new Error('Patch has no repository changes');
    const commit = await git('commit-tree', tree, '-p', baseCommit, '-m', title);
    state.commit = commit;
    await request.beforeWrite?.();
    state.stage = 'pushing';
    // An empty expected value makes branch creation atomic: never replace an existing ref.
    const pushed = await git('push', '--porcelain', `--force-with-lease=${headRef}:`, 'origin', `${commit}:${headRef}`);
    if (!pushed.split('\n').some(line => line.startsWith('*\t'))) throw new Error('Push did not create a new branch');
    await request.beforeWrite?.();
    state.stage = 'opening-pr';
    const { url } = await createPullRequest({ repository, base: baseBranch, head: branch, title, body, draft: true });
    state.url = url;
    state.stage = 'published';
    result = { url, branch, commit };
  } catch (error) {
    failures.push(error);
  } finally {
    try { await rm(directory, { recursive: true, force: true }); }
    catch (error) { failures.push(error); }
  }
  if (!failures.length && result) return result;
  throw new PatchPublicationError(failures, state);
}
