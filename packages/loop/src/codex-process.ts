import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { initializeCodex } from './codex-initialize.js';

// start must create one fresh process. Initialization probe only: direct-child shutdown does not cancel descendants or remote turns.
export async function initializeCodexProcess(
  start: () => ChildProcessWithoutNullStreams,
  { signal, timeoutMs = 10_000, shutdownMs = 1_000 }: {
    signal?: AbortSignal; timeoutMs?: number; shutdownMs?: number;
  } = {},
): Promise<void> {
  if (signal?.aborted) throw new Error('Codex process cancelled');
  const child = start();
  const lines = createInterface({ input: child.stdout });
  const failure = Promise.withResolvers<never>();
  const failures: unknown[] = [];
  let stopping = false;
  let closed = false;
  const exited = new Promise<void>(resolve => {
    child.once('close', () => {
      closed = true;
      resolve();
      if (!stopping) failure.reject(new Error('Codex process exited before initialization completed'));
    });
  });
  const transportError = new Error('Codex process transport failed');
  const cancellation = new Error('Codex process cancelled');
  const fail = (error: Error) => {
    if (!failures.includes(error)) failures.push(error);
    failure.reject(error);
  };
  const onError = () => fail(transportError);
  const onAbort = () => fail(cancellation);
  child.on('error', onError);
  child.stdin.on('error', onError);
  child.stdout.on('error', onError);
  child.stderr.on('error', onError);
  lines.on('error', onError);
  child.stderr.resume(); // Drain diagnostics without logging potentially sensitive content.
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try {
    if (signal?.aborted) await failure.promise;
    await Promise.race([
      failure.promise,
      initializeCodex(lines, message => {
        if (!child.stdin.writable) throw new Error('Codex stdin is closed');
        child.stdin.write(JSON.stringify(message) + '\n', error => { if (error) onError(); });
      }, timeoutMs),
    ]);
  } catch (error) {
    if (!failures.includes(error)) failures.push(error);
  } finally {
    stopping = true;
    lines.close(); // Also rejects any outstanding protocol wait after cancellation.
    for (const stop of [
      () => child.stdin.end(),
      () => child.kill('SIGTERM'),
      () => child.kill('SIGKILL'),
    ]) {
      if (closed) break;
      try { stop(); } catch (error) { failures.push(error); }
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([exited, new Promise<void>(resolve => { timer = setTimeout(resolve, shutdownMs); })]);
      clearTimeout(timer);
    }
    if (!closed) failures.push(new Error('Codex process exit unconfirmed after shutdown deadline'));
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
  if (failures.length) throw new AggregateError(failures, 'Codex process initialization or shutdown failed');
}
