import { setTimeout as delay } from "node:timers/promises";
import type { Environment } from "./environment.js";

// Losing the observer is not cancellation of the remote agent.
export class SessionDetached extends Error {}

export interface AttemptCheckpoint {
  version: 1;
  name: string;
  environmentId?: string;
  provider?: string;
  phase: "created" | "prepared" | "running" | "collected" | "deleted";
  deadline: number;
  artifact?: string;
}
export interface DurableAttempt {
  checkpoint: AttemptCheckpoint;
  save(checkpoint: AttemptCheckpoint): Promise<void>;
}

/** The remote lock covers execution, and the exit file is committed atomically.
 * Repeating an ambiguous launch can only attach to the same command, never pay
 * for a second turn. All paths are generated UUID paths, not user input.
 */
export async function executeDurably(
  sandbox: Pick<Environment, "exec">,
  directory: string,
  command: string,
  deadline: number,
  signal?: AbortSignal,
): Promise<{ exitCode: number; result: string }> {
  const script = `if test -f ${directory}/started; then exit 0; fi
touch ${directory}/started
(
${command}
) >${directory}/output 2>&1
status=$?
printf "%s" "$status" >${directory}/exit.tmp
mv ${directory}/exit.tmp ${directory}/exit`;
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const launch = `mkdir -p ${directory} && nohup flock -n ${directory}/execution.lock sh -c ${quote(script)} </dev/null >/dev/null 2>&1 &`;
  try {
    signal?.throwIfAborted();
    if (Date.now() > deadline) return { exitCode: 124, result: "Agent session deadline exceeded" };
    const started = await sandbox.exec(launch, { timeoutMs: 30_000 });
    if (started.exitCode !== 0) throw new Error("Remote launch was not acknowledged");
    for (;;) {
      signal?.throwIfAborted();
      const status = await sandbox.exec(
        `if test -f ${directory}/exit; then cat ${directory}/exit; else printf running; fi`,
        { timeoutMs: 30_000 },
      );
      if (status.exitCode !== 0) throw new Error("Remote status unavailable");
      if (/^\d+$/.test(status.result)) {
        const output = await sandbox.exec(`head -c 65536 ${directory}/output`, {
          timeoutMs: 30_000,
        });
        if (output.exitCode !== 0) throw new Error("Remote output unavailable");
        return { exitCode: Number(status.result), result: output.result };
      }
      if (Date.now() > deadline)
        return { exitCode: 124, result: "Agent session deadline exceeded" };
      await delay(500, undefined, { signal });
    }
  } catch (cause) {
    // Provider/network failures leave the durable execution for another observer.
    if (signal?.aborted) throw signal.reason;
    throw new SessionDetached("Remote execution observer disconnected", { cause });
  }
}
