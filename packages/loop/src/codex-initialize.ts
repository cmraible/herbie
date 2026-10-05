import type { Interface } from 'node:readline';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Call once on a fresh connection. The caller owns the transport and its lifetime.
// send must enqueue the message or throw; transport failures must close/error lines.
export function initializeCodex(
  lines: Interface, send: (message: unknown) => void, timeoutMs = 10_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Codex initialization timed out')), timeoutMs);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      lines.off('line', onLine);
      lines.off('close', onClose);
      lines.off('error', onError);
      if (error) reject(error);
      else resolve();
    };
    const onClose = () => finish(new Error('Codex initialization failed: connection closed'));
    const onError = () => finish(new Error('Codex initialization failed: transport error'));
    const onLine = (line: string) => {
      try {
        const response: unknown = JSON.parse(line);
        if (!isObject(response)) throw new Error();
        if (response.id !== 0) return;
        if ('error' in response || !isObject(response.result) || typeof response.result.userAgent !== 'string') {
          throw new Error();
        }
      } catch {
        finish(new Error('Codex initialization failed: invalid or rejected response'));
        return;
      }
      try {
        send({ method: 'initialized' });
        finish();
      } catch {
        onError();
      }
    };
    lines.on('line', onLine);
    lines.once('close', onClose);
    lines.once('error', onError);
    try {
      send({ id: 0, method: 'initialize', params: { clientInfo: { name: 'herbie', version: '0.1.0' } } });
    } catch {
      onError();
    }
  });
}
