import type { Interface } from 'node:readline';

type TerminalStatus = 'completed' | 'failed' | 'interrupted';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// One turn per initialized connection, after startCodexThread. Request IDs 2 and 3 are reserved.
// The caller owns transport/process cleanup; send enqueues synchronously or throws.
// Transport failures must close/error lines. A terminal event does not confirm descendant exit.
export function runCodexTurn(
  lines: Interface, send: (message: unknown) => void, threadId: string, goal: string,
  { timeoutMs = 60_000, signal, interruptTimeoutMs = 5_000, disposableDaytona = false }: {
    timeoutMs?: number; signal?: AbortSignal; interruptTimeoutMs?: number; disposableDaytona?: boolean;
  } = {},
): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error('Codex turn cancelled'));
  return new Promise((resolve, reject) => {
    let turnId: string | undefined;
    let cancellation: Error | undefined;
    let interruptSent = false;
    let settled = false;
    let interruptTimer: ReturnType<typeof setTimeout> | undefined;
    // A completion notification may precede the turn/start response that identifies our turn.
    const completions = new Map<string, TerminalStatus>();
    const spendingFailures = new Map<string, Error>();
    const timer = setTimeout(() => cancel(new Error('Codex turn timed out')), timeoutMs);
    const finish = (error?: Error, terminal = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(interruptTimer);
      signal?.removeEventListener('abort', onAbort);
      lines.off('line', onLine);
      lines.off('close', onClose);
      lines.off('error', onError);
      completions.clear();
      spendingFailures.clear();
      if (cancellation && !terminal) reject(new AggregateError(
        error ? [cancellation, error] : [cancellation],
        `${cancellation.message}; Codex turn termination unconfirmed`,
      ));
      else if (cancellation || error) reject(cancellation ?? error);
      else resolve();
    };
    const interrupt = () => {
      if (settled || !cancellation || turnId === undefined || interruptSent) return;
      interruptSent = true;
      try {
        send({ id: 3, method: 'turn/interrupt', params: { threadId, turnId } });
      } catch { onError(); }
    };
    const cancel = (error: Error) => {
      if (settled || cancellation) return;
      cancellation = error;
      clearTimeout(timer);
      // Includes time waiting for a late turn/start response; never guess the active turn ID.
      interruptTimer = setTimeout(() => finish(new Error('Codex interrupt timed out')), interruptTimeoutMs);
      interrupt();
    };
    const onAbort = () => cancel(new Error('Codex turn cancelled'));
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
        } else if (message.id === 3 && interruptSent) {
          if ('error' in message || !isObject(message.result)) throw new Error();
          // Acknowledgement alone does not confirm that the turn has stopped.
        } else if (disposableDaytona && message.method === 'thread/tokenUsage/updated') {
          if (!isObject(message.params)) throw new Error();
          if (message.params.threadId !== threadId) return;
          const usageTurnId = message.params.turnId;
          if (typeof usageTurnId !== 'string' || !usageTurnId.trim()) throw new Error();
          if (turnId !== undefined && usageTurnId !== turnId) return;
          const usage = isObject(message.params.tokenUsage) ? message.params.tokenUsage.total : undefined;
          if (!isObject(usage) || typeof usage.inputTokens !== 'number' || typeof usage.outputTokens !== 'number'
            || !Number.isSafeInteger(usage.inputTokens) || usage.inputTokens < 0
            || !Number.isSafeInteger(usage.outputTokens) || usage.outputTokens < 0) {
            spendingFailures.set(usageTurnId, new Error('Codex spending cutoff: invalid usage'));
          } else if ((usage.inputTokens * 0.125 + usage.outputTokens * 0.5) / 1_000_000 >= 0.005) {
            // Cumulative totals: do not add successive notifications. Charge all input at
            // the highest standard input price (cache writes), ignoring cache discounts.
            spendingFailures.set(usageTurnId, new Error('Codex spending cutoff reached'));
          }
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
        const spendingFailure = turnId === undefined ? undefined : spendingFailures.get(turnId);
        if (spendingFailure) cancel(spendingFailure);
        const status = turnId === undefined ? undefined : completions.get(turnId);
        if (status !== undefined) finish(status === 'completed' ? undefined : new Error(`Codex turn ${status}`), true);
        else interrupt();
      } catch {
        finish(new Error('Codex turn failed: invalid or rejected response'));
      }
    };
    lines.on('line', onLine);
    lines.once('close', onClose);
    lines.once('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      send({ id: 2, method: 'turn/start', params: {
        threadId, input: [{ type: 'text', text: goal }],
        ...(disposableDaytona ? {
          model: 'gpt-6-luna', effort: 'low', serviceTierForTurn: 'default', approvalPolicy: 'never',
          sandboxPolicy: { type: 'externalSandbox', networkAccess: 'restricted' },
        } : {}),
      } });
    } catch {
      onError();
    }
  });
}
