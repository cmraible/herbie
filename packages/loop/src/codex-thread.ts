import type { Interface } from 'node:readline';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// After initializeCodex, call once per connection. Request ID 1 is reserved here.
// The caller owns the transport; send enqueues synchronously or throws.
// Transport failures must close/error lines. Security settings remain server-owned.
export function startCodexThread(
  lines: Interface, send: (message: unknown) => void, cwd: string, timeoutMs = 10_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Codex thread start timed out')), timeoutMs);
    const finish = (result: string | Error) => {
      clearTimeout(timer);
      lines.off('line', onLine);
      lines.off('close', onClose);
      lines.off('error', onError);
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const onClose = () => finish(new Error('Codex thread start failed: connection closed'));
    const onError = () => finish(new Error('Codex thread start failed: transport error'));
    const onLine = (line: string) => {
      try {
        const response: unknown = JSON.parse(line);
        if (!isObject(response)) throw new Error();
        if (response.id !== 1) return;
        if ('error' in response || !isObject(response.result) || !isObject(response.result.thread)) {
          throw new Error();
        }
        const threadId = response.result.thread.id;
        if (typeof threadId !== 'string' || threadId.trim() === '') throw new Error();
        finish(threadId);
      } catch {
        finish(new Error('Codex thread start failed: invalid or rejected response'));
      }
    };
    lines.on('line', onLine);
    lines.once('close', onClose);
    lines.once('error', onError);
    try {
      send({ id: 1, method: 'thread/start', params: { cwd, ephemeral: true } });
    } catch {
      onError();
    }
  });
}
