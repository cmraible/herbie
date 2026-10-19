import { setTimeout as delay } from "node:timers/promises";

export const observationIntervalMs = 5000;

// These retries are only for reads or idempotent observation, never agent turns.
export async function retryObservation<T>(
  read: () => Promise<T>,
  signal?: AbortSignal,
  retryable: () => boolean = () => true,
  wait: (ms: number, signal?: AbortSignal) => Promise<void> = async (ms, signal) => {
    await delay(ms, undefined, { signal });
  },
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      return await read();
    } catch (error) {
      signal?.throwIfAborted();
      if (!retryable() || attempt === 4) throw error;
      await wait(1000 * 2 ** attempt, signal);
    }
  }
}
