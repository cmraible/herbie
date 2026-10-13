import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import type { CreateSandboxFromImageParams, CreateSandboxFromSnapshotParams, Sandbox } from '@daytona/sdk';

import {AttemptCommandError,AttemptResultError,AttemptReportError,attemptDiagnostic,attemptDiagnosticMessage,type AttemptStage,type AttemptDiagnostic} from './attempt-diagnostics.js';

import { installDaytonaRuntime, configureDaytonaRuntime } from './daytona-runtime.js';
import { MAX_ARTIFACT_BYTES, MAX_PATCH_BYTES, MAX_TEST_OUTPUT_BYTES, MAX_TEST_RESULT_BYTES } from './artifact-limits.js';

type AttemptSandbox = Pick<Sandbox, 'id' | 'delete'> & {
  git: Pick<Sandbox['git'], 'clone'>;
  fs: {
    createFolder: Sandbox['fs']['createFolder'];
    uploadFile(file: Buffer, path: string, timeout: number): Promise<void>;
    downloadFileStream(path: string, options: { timeout: number; signal: AbortSignal }): Promise<Readable>;
  };
  process: Pick<Sandbox['process'], 'executeCommand'>;
};
type CreateSandbox = (params: CreateSandboxFromSnapshotParams | CreateSandboxFromImageParams, options: { timeout: number }) => Promise<AttemptSandbox>;
type Request = Pick<CreateSandboxFromSnapshotParams, 'secrets' | 'outboundProxyUrl'> & {
  snapshot?: string; domainAllowList?: string; repoUrl: string; commit?: string; goal: string;
  testCommand?: string[]; testTimeoutMs?: number;
};

export interface DaytonaTestResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface DaytonaAttemptChanges {
  baseCommit: string;
  patch: Buffer;
  testResult?: DaytonaTestResult;
  // Issued by the host only after the goal, tests, and sandbox deletion succeed.
  verification?: {
    // Missing on legacy artifacts, which the publisher must reject.
    version?: 2;
    repoUrl: string;
    baseCommit: string;
    patchSha256: string;
    testCommand: string[];
    goalCompleted: true;
    sandboxDeleted: true;
  };
}

export class DaytonaAttemptError extends AggregateError {
  // Keep retrieved changes available even if subsequent testing or deletion fails.
  changes?: DaytonaAttemptChanges;
  diagnostics: AttemptDiagnostic[] = [];
  cleanup: 'confirmed'|'unconfirmed' = 'unconfirmed';
  safeMessage():string {
    return `Attempt failed (${this.diagnostics.map(attemptDiagnosticMessage).join('; ') || 'diagnostic unavailable'}). Sandbox deletion ${this.cleanup}. No automatic retry.`;
  }
}

async function downloadBounded(sandbox: AttemptSandbox, path: string, limit: number): Promise<Buffer> {
  const controller = new AbortController();
  const stream = await sandbox.fs.downloadFileStream(path, {
    timeout: 30, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
  });
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for await (const chunk of stream) {
      if (!Buffer.isBuffer(chunk)) throw new Error('Invalid artifact stream');
      length += chunk.length;
      if (length > limit) throw new Error('Sandbox artifact exceeds its byte limit');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, length);
  } finally {
    // Stop the HTTP transfer as well as its consumer on overflow, timeout, or read failure.
    controller.abort();
    stream.destroy();
  }
}

// Use the built adapter (or provide a directory containing the built runtime files).
// Secret values stay outside Herbie; secrets contains existing Daytona Secret names only.
export async function runDaytonaAttempt(
  create: CreateSandbox, request: Request, report: (message: string) => void | Promise<void>,
  runtimeDirectory = new URL('.', import.meta.url),
): Promise<DaytonaAttemptChanges> {
  let stage:AttemptStage='sandbox_creation';
  const emit=async(message:string):Promise<void>=>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{await Promise.race([Promise.resolve().then(()=>report(message)),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Attempt event persistence timed out')),5000);})]);}
    catch(cause){throw new AttemptReportError('Attempt event persistence failed',{cause});}
    finally{clearTimeout(timer);}
  };
  const begin=async(next:AttemptStage):Promise<void>=>{stage=next;await emit(`Attempt stage: ${stage}`);};
  const repo = new URL(request.repoUrl);
  if (repo.protocol !== 'https:' || repo.username || repo.password || repo.search || repo.hash) {
    throw new Error('Use a public HTTPS repository URL without credentials, query, or fragment');
  }
  if ((request.snapshot !== undefined && !request.snapshot.trim())
    || (request.domainAllowList !== undefined && !request.domainAllowList.trim()) || !request.goal.trim()) {
    throw new Error('Goal and any supplied snapshot or domain allowlist must not be empty');
  }
  const testTimeoutMs = request.testTimeoutMs ?? 60_000;
  if (request.testCommand !== undefined && (!Array.isArray(request.testCommand) || !request.testCommand.length
    || request.testCommand.some(arg => typeof arg !== 'string' || arg.includes('\0')) || !request.testCommand[0].trim())) {
    throw new Error('Test command must contain an executable followed by literal arguments');
  }
  if (!Number.isInteger(testTimeoutMs) || testTimeoutMs < 1 || testTimeoutMs > 60_000) {
    throw new Error('Test timeout must be an integer from 1 to 60000 milliseconds');
  }
  const testCommand = request.testCommand?.slice();
  const runtime = await Promise.all([
    'codex-initialize.js', 'codex-thread.js', 'codex-turn.js', 'codex-process.js', 'daytona-runner.js', 'daytona-test-runner.js', 'artifact-limits.js', 'diagnostic-log.js',
  ].map(async name => ({ name, contents: await readFile(new URL(name, runtimeDirectory)) })));
  const name = `herbie-attempt-${randomUUID()}`;
  const directory = `/tmp/${name}`;
  const cwd = `${directory}/repo`;
  await begin('sandbox_creation');
  await emit(`Creating sandbox ${name}`);
  let sandbox: AttemptSandbox;
  try {
    sandbox = await create({
      name, ...(request.snapshot ? { snapshot: request.snapshot }
        : { image: 'ubuntu:22.04', resources: { cpu: 1, memory: 1, disk: 3 } }),
      ...(request.domainAllowList ? { domainAllowList: request.domainAllowList } : {}),
      secrets: request.secrets, outboundProxyUrl: request.outboundProxyUrl, ttlMinutes: 15,
    }, { timeout: 120 });
  } catch (cause) {
    const error=new DaytonaAttemptError([cause], `Creation failed for ${name}; cleanup is unconfirmed. Check Daytona by name.`, { cause });
    error.diagnostics=[attemptDiagnostic(cause,stage)];
    throw error;
  }
  const failures: Error[] = [];
  const diagnostics:AttemptDiagnostic[]=[];
  let cleanupConfirmed=false;
  let changes: DaytonaAttemptChanges | undefined;
  try {
    await emit(`Created sandbox ${sandbox.id}`);
    await begin('runtime_preparation');
    const preflight = await sandbox.process.executeCommand(
      (request.snapshot ? '' : installDaytonaRuntime) + configureDaytonaRuntime,
      undefined, undefined, request.snapshot ? 30 : 240,
    );
    if (preflight.exitCode !== 0) throw new AttemptCommandError(preflight.exitCode,preflight.result);
    await begin('runtime_upload');
    await sandbox.fs.createFolder(directory, '700');
    for (const file of runtime.filter(file => !['daytona-test-runner.js', 'artifact-limits.js'].includes(file.name))) {
      await sandbox.fs.uploadFile(file.contents, `${directory}/${file.name}`, 30);
    }
    await sandbox.fs.uploadFile(Buffer.from('{"type":"module"}'), `${directory}/package.json`, 30);
    await sandbox.fs.uploadFile(Buffer.from(JSON.stringify({ cwd, goal: request.goal })), `${directory}/attempt.json`, 30);
    await begin('repository_clone');
    await sandbox.git.clone(repo.href, cwd, undefined, request.commit);
    await begin('model_execution');
    await emit(`Running goal in sandbox ${sandbox.id}`);
    // Only the generated UUID path enters the shell. The goal and repo URL never do.
    const result = await sandbox.process.executeCommand(`chown -R compat:compat ${directory} && runuser -u compat -- env HOME=/home/compat PATH=/usr/local/bin:/usr/bin:/bin node ${directory}/daytona-runner.js`, directory, undefined, 240);
    if(result.exitCode!==0)throw new AttemptCommandError(result.exitCode,result.result);
    if(result.result!=='herbie-attempt-completed\n')throw new AttemptResultError('Invalid goal completion marker',result.result);
    await emit(`Goal completed in sandbox ${sandbox.id}`);
    await begin('artifact_download');
    const artifact: unknown = JSON.parse((await downloadBounded(sandbox, `${directory}/changes.json`, MAX_ARTIFACT_BYTES)).toString('utf8'));
    if (typeof artifact !== 'object' || artifact === null
      || !('baseCommit' in artifact) || typeof artifact.baseCommit !== 'string' || !/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(artifact.baseCommit)
      || !('patchBase64' in artifact) || typeof artifact.patchBase64 !== 'string') throw new Error('Invalid repository changes artifact');
    if (artifact.patchBase64.length > Math.ceil(MAX_PATCH_BYTES / 3) * 4) throw new Error('Repository patch exceeds its byte limit');
    const patch = Buffer.from(artifact.patchBase64, 'base64');
    if (patch.length > MAX_PATCH_BYTES) throw new Error('Repository patch exceeds its byte limit');
    if (patch.toString('base64') !== artifact.patchBase64) throw new Error('Invalid repository patch encoding');
    changes = { baseCommit: artifact.baseCommit, patch };
    await emit(`Changes retrieved from sandbox ${sandbox.id}`);
    if (testCommand) {
      // Never reuse agent-owned helpers, Git configuration, or working files. This
      // root-owned sibling cannot be modified by the compat coding user.
      await begin('verification_setup');
      const verificationDirectory = `/tmp/herbie-verification-${randomUUID()}`;
      await sandbox.fs.createFolder(verificationDirectory, '700');
      for (const file of runtime.filter(file => ['daytona-test-runner.js', 'artifact-limits.js', 'diagnostic-log.js'].includes(file.name))) {
        await sandbox.fs.uploadFile(file.contents, `${verificationDirectory}/${file.name}`, 30);
      }
      await sandbox.fs.uploadFile(Buffer.from('{"type":"module"}'), `${verificationDirectory}/package.json`, 30);
      await begin('verification_clone');
      await sandbox.git.clone(repo.href, `${verificationDirectory}/repo`, undefined, changes.baseCommit);
      await begin('verification_upload');
      await sandbox.fs.uploadFile(changes.patch, `${verificationDirectory}/recovered.patch`, 30);
      await sandbox.fs.uploadFile(Buffer.from(JSON.stringify({
        baseCommit: changes.baseCommit, command: testCommand, timeoutMs: testTimeoutMs,
      })), `${verificationDirectory}/test.json`, 30);
      await begin('testing');
      await emit(`Testing recovered changes in sandbox ${sandbox.id}`);
      // The supervisor runs as root; only Git and the test command drop privileges.
      const verification = await sandbox.process.executeCommand(`/usr/local/bin/node ${verificationDirectory}/daytona-test-runner.js`, verificationDirectory, undefined, 150);
      if(verification.exitCode!==0)throw new AttemptCommandError(verification.exitCode,verification.result);
      if(verification.result!=='herbie-tests-completed\n')throw new AttemptResultError('Invalid test completion marker',verification.result);
      await begin('test_result_download');
      const outcome: unknown = JSON.parse((await downloadBounded(sandbox, `${verificationDirectory}/test-result.json`, MAX_TEST_RESULT_BYTES)).toString('utf8'));
      if (typeof outcome !== 'object' || outcome === null
        || !('exitCode' in outcome) || typeof outcome.exitCode !== 'number' || !Number.isInteger(outcome.exitCode) || outcome.exitCode < 0
        || !('stdout' in outcome) || typeof outcome.stdout !== 'string'
        || !('stderr' in outcome) || typeof outcome.stderr !== 'string') throw new Error('Invalid repository test result');
      if (Buffer.byteLength(outcome.stdout) > MAX_TEST_OUTPUT_BYTES || Buffer.byteLength(outcome.stderr) > MAX_TEST_OUTPUT_BYTES) {
        throw new Error('Repository test output exceeds its byte limit');
      }
      changes.testResult = { exitCode: outcome.exitCode, stdout: outcome.stdout, stderr: outcome.stderr };
      if (outcome.exitCode !== 0) throw new AttemptCommandError(outcome.exitCode,outcome.stdout,outcome.stderr);
      await emit(`Repository tests passed in sandbox ${sandbox.id}`);
    }
  } catch (cause) {
    diagnostics.push(attemptDiagnostic(cause,stage));
    failures.push(new Error(`Attempt failed in sandbox ${sandbox.id}`, { cause }));
  } finally {
    // A failed event write must never prevent sandbox cleanup.
    try {await begin('sandbox_deletion');}catch(cause){
      diagnostics.push(attemptDiagnostic(cause,'sandbox_deletion'));
      failures.push(new Error('Cleanup stage could not be persisted',{cause}));
    }
    try {
      await sandbox.delete(60, true);
      cleanupConfirmed=true;
      await emit(`Deletion confirmed for sandbox ${sandbox.id}`);
    } catch (cause) {
      diagnostics.push(attemptDiagnostic(cause,'sandbox_deletion'));
      failures.push(new Error(cleanupConfirmed?'Deletion confirmation event could not be persisted':`Deletion unconfirmed for sandbox ${sandbox.id}; check Daytona before retrying`, { cause }));
    }
  }
  if (!failures.length && changes) {
    if (testCommand && changes.testResult?.exitCode === 0) {
      changes.verification = {
        version: 2,
        repoUrl: repo.href, baseCommit: changes.baseCommit,
        patchSha256: createHash('sha256').update(changes.patch).digest('hex'),
        testCommand, goalCompleted: true, sandboxDeleted: true,
      };
    }
    return changes;
  }
  const error = new DaytonaAttemptError(failures, failures.map(error => error.message).join('; '));
  error.changes = changes;
  error.diagnostics=diagnostics;
  error.cleanup=cleanupConfirmed?'confirmed':'unconfirmed';
  throw error;
}
