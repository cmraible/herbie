import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import { initializeCodex } from './codex-initialize.js';
import { startCodexThread } from './codex-thread.js';
import { runCodexTurn } from './codex-turn.js';

type ProcessOptions = { signal?: AbortSignal; timeoutMs?: number; shutdownMs?: number };
type AttemptOptions = ProcessOptions & {
  cwd: string; goal: string; turnTimeoutMs?: number; interruptTimeoutMs?: number;
};

export function initializeCodexProcess(command: string, args: readonly string[], options: ProcessOptions = {}): Promise<void> {
  const { signal, timeoutMs, shutdownMs } = options;
  return runCodexProcess(command, args, { signal, timeoutMs, shutdownMs });
}

// One initialized thread and goal, followed by owned-group cleanup on every outcome.
export function runCodexAttempt(command: string, args: readonly string[], options: AttemptOptions): Promise<void> {
  return runCodexProcess(command, args, { ...options, cwd: resolve(options.cwd) });
}

// Owns a fresh POSIX group, not escaped descendants or remote turns.
async function runCodexProcess(
  command: string, args: readonly string[],
  options: ProcessOptions | AttemptOptions,
): Promise<void> {
  const { signal, timeoutMs = 10_000, shutdownMs = 1_000 } = options;
  if (signal?.aborted) throw new Error('Codex process cancelled');
  if (process.platform === 'win32') throw new Error('Codex process groups require POSIX');
  if (!Number.isFinite(shutdownMs) || shutdownMs < 0) throw new Error('Invalid Codex shutdown deadline');
  const child = spawn(command, args, {
    stdio: 'pipe', detached: true, cwd: 'cwd' in options ? options.cwd : undefined,
  });
  const groupId = child.pid;
  let groupGone = groupId === undefined;
  const signalGroup = (signal: NodeJS.Signals | 0): boolean => {
    if (groupGone || groupId === undefined) return false;
    try { process.kill(-groupId, signal); return true; }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
        groupGone = true; // Never signal this numeric ID again after observing its disappearance.
        return false;
      }
      throw error;
    }
  };
  const lines = createInterface({ input: child.stdout });
  const failure = Promise.withResolvers<never>();
  const failures: unknown[] = [];
  let stopping = false;
  let runningTurn = false;
  let closed = false;
  child.once('close', () => { closed = true; });
  child.once('exit', () => {
    if (!stopping) failure.reject(new Error('Codex process exited before work completed'));
  });
  const transportError = new Error('Codex process transport failed');
  const cancellation = new Error('Codex process cancelled');
  const fail = (error: Error) => {
    if (!failures.includes(error)) failures.push(error);
    failure.reject(error);
  };
  const onError = () => fail(transportError);
  const onAbort = () => {
    // Let runCodexTurn request interruption and await its bounded terminal confirmation.
    if (runningTurn) {
      if (!failures.includes(cancellation)) failures.push(cancellation);
    } else fail(cancellation);
  };
  child.on('error', onError);
  child.stdin.on('error', onError);
  child.stdout.on('error', onError);
  child.stderr.on('error', onError);
  lines.on('error', onError);
  child.stderr.resume(); // Drain diagnostics without logging potentially sensitive content.
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const send = (message: unknown) => {
    if (!child.stdin.writable) throw new Error('Codex stdin is closed');
    child.stdin.write(JSON.stringify(message) + '\n', error => { if (error) onError(); });
  };
  try {
    if (signal?.aborted) await failure.promise;
    await Promise.race([failure.promise, initializeCodex(lines, send, timeoutMs)]);
    if ('goal' in options) {
      if (signal?.aborted) throw cancellation;
      const threadId = await Promise.race([failure.promise, startCodexThread(lines, send, options.cwd, timeoutMs)]);
      if (signal?.aborted) throw cancellation;
      runningTurn = true;
      try {
        await Promise.race([failure.promise, runCodexTurn(lines, send, threadId, options.goal, {
          signal, timeoutMs: options.turnTimeoutMs, interruptTimeoutMs: options.interruptTimeoutMs,
        })]);
      } finally { runningTurn = false; }
    }
  } catch (error) {
    if (!failures.includes(error)) failures.push(error);
  } finally {
    stopping = true;
    lines.close(); // Also rejects any outstanding protocol wait after cancellation.
    child.stdout.resume(); // readline.close() pauses stdout; drain the child's shutdown output.
    for (const stop of [
      () => child.stdin.end(),
      () => signalGroup('SIGTERM'),
      () => signalGroup('SIGKILL'),
    ]) {
      try {
        if (!signalGroup(0) && closed) break;
        stop();
        const deadline = performance.now() + shutdownMs;
        while (signalGroup(0) || !closed) {
          const remaining = deadline - performance.now();
          if (remaining <= 0) break;
          await delay(Math.min(20, remaining));
        }
      } catch (error) { failures.push(error); }
    }
    if (!closed) failures.push(new Error('Codex process exit unconfirmed after shutdown deadline'));
    try {
      if (signalGroup(0)) failures.push(new Error('Codex process group exit unconfirmed after shutdown deadline'));
    } catch (error) {
      failures.push(new Error('Codex process group exit unconfirmed after shutdown deadline', { cause: error }));
    }
    if (closed && child.exitCode !== null && child.exitCode !== 0) {
      failures.push(new Error('Codex process exited unsuccessfully'));
    }
    signal?.removeEventListener('abort', onAbort);
    lines.off('error', onError);
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    child.off('error', onError);
    child.stdin.off('error', onError);
    child.stdout.off('error', onError);
    child.stderr.off('error', onError);
  }
  if (failures.length) throw new AggregateError(failures, 'Codex process execution or shutdown failed');
}
