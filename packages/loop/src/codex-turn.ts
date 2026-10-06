import type { Interface } from 'node:readline';

type TerminalStatus = 'completed' | 'failed' | 'interrupted';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// One turn per initialized connection, after startCodexThread. Request ID 2 is reserved.
// The caller owns transport/cancellation; send enqueues synchronously or throws.
// Transport failures must close/error lines. A local timeout does not cancel remote work.
export function runCodexTurn(
  lines: Interface, send: (message: unknown) => void, threadId: string, goal: string, timeoutMs = 60_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let turnId: string | undefined;
    // A completion notification may precede the turn/start response that identifies our turn.
    const completions = new Map<string, TerminalStatus>();
    const timer = setTimeout(() => finish(new Error('Codex turn timed out')), timeoutMs);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      lines.off('line', onLine);
      lines.off('close', onClose);
      lines.off('error', onError);
      completions.clear();
      if (error) reject(error);
      else resolve();
    };
    const onClose = () => finish(new Error('Codex turn failed: connection closed'));
    const onError = () => finish(new Error('Codex turn failed: transport error'));
    const onLine = (line: string) => {
      try {
        const message: unknown = JSON.parse(line);
        if (!isObject(message)) throw new Error();
        if (message.id === 2 && turnId === undefined) {
          if ('error' in message || !isObject(message.result) || !isObject(message.result.turn)) throw new Error();
          const id = message.result.turn.id;
          if (typeof id !== 'string' || id.trim() === '') throw new Error();
          turnId = id;
        } else if (message.method === 'turn/completed') {
          if (!isObject(message.params)) throw new Error();
          if (message.params.threadId !== threadId) return;
          const turn = message.params.turn;
          if (!isObject(turn) || typeof turn.id !== 'string' || turn.id.trim() === '') throw new Error();
          if (turnId !== undefined && turn.id !== turnId) return;
          const status = turn.status;
          if (status !== 'completed' && status !== 'failed' && status !== 'interrupted') throw new Error();
          completions.set(turn.id, status);
        }
        const status = turnId === undefined ? undefined : completions.get(turnId);
        if (status !== undefined) finish(status === 'completed' ? undefined : new Error(`Codex turn ${status}`));
      } catch {
        finish(new Error('Codex turn failed: invalid or rejected response'));
      }
    };
    lines.on('line', onLine);
    lines.once('close', onClose);
    lines.once('error', onError);
    try {
      send({ id: 2, method: 'turn/start', params: { threadId, input: [{ type: 'text', text: goal }] } });
    } catch {
      onError();
    }
  });
}
