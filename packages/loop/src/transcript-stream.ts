import { StringDecoder } from "node:string_decoder";
import type { Environment } from "./environment.js";
import { retryObservation } from "./observation.js";

// One read-only helper per connection. Rotation bounds provider output buffers
// and the lifetime of a reader orphaned by a lost connection.
const reader = String.raw`
const fs = require("node:fs");
const { setTimeout: delay } = require("node:timers/promises");
const { once } = require("node:events");
const [directory, start] = process.argv.slice(1);
let offset = Number(start), sent = 0;
async function emit(value) {
  if (!process.stdout.write(value + "\n")) await once(process.stdout, "drain");
}
(async () => {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline && sent < 1024 * 1024) {
    const finished = fs.existsSync(directory + "/exit");
    let count = 0;
    const buffer = Buffer.alloc(48 * 1024);
    try {
      const file = fs.openSync(directory + "/transcript.jsonl", "r");
      try {
        if (fs.fstatSync(file).size < offset) throw new Error("Transcript truncated");
        count = fs.readSync(file, buffer, 0, buffer.length, offset);
      } finally { fs.closeSync(file); }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (count) {
      await emit(buffer.subarray(0, count).toString("base64"));
      offset += count;
      sent += count;
    } else if (finished) { await emit("done"); return; }
    else await delay(200);
  }
  await emit("more");
})().catch(() => { process.exitCode = 1; });
`;

export function transcriptReaderCommand(directory: string, offset: number): string {
  if (
    !/^\/tmp\/herbie-attempt-[a-f0-9-]+$/.test(directory) ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  )
    throw new Error("Invalid transcript cursor");
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  return `node -e ${quote(reader)} ${quote(directory)} ${offset}`;
}

export async function followAgentTranscript(
  stream: NonNullable<Environment["streamCommand"]>,
  directory: string,
  report: (message: string, offset: number) => Promise<void>,
  signal: AbortSignal,
  startOffset = 0,
): Promise<void> {
  let offset = startOffset;
  let cursor = offset;
  let decoder = new StringDecoder("utf8");
  let pending = "";
  for (;;) {
    let fatal = false;
    let connections = 0;
    const complete = await retryObservation(
      async () => {
        // Normal rotation retains partial records; a failed connection replays
        // from the last acknowledgement, including any split UTF-8 character.
        if (connections++) {
          cursor = offset;
          decoder = new StringDecoder("utf8");
          pending = "";
        }
        let frames = "";
        let ending: string | undefined;
        await stream(
          transcriptReaderCommand(directory, cursor),
          async (chunk) => {
            try {
              signal.throwIfAborted();
              frames += chunk;
              let end: number;
              while ((end = frames.indexOf("\n")) !== -1) {
                const frame = frames.slice(0, end);
                frames = frames.slice(end + 1);
                if (ending) throw new Error("Data after transcript end");
                if (frame === "done" || frame === "more") {
                  ending = frame;
                  continue;
                }
                if (frame.length > 65536) throw new Error("Transcript frame exceeds limit");
                const bytes = Buffer.from(frame, "base64");
                if (!frame || bytes.toString("base64") !== frame)
                  throw new Error("Invalid transcript frame");
                cursor += bytes.length;
                pending += decoder.write(bytes);
                let newline: number;
                while ((newline = pending.indexOf("\n")) !== -1) {
                  const record = pending.slice(0, newline);
                  JSON.parse(record);
                  const next = offset + Buffer.byteLength(record + "\n");
                  await report(record, next);
                  offset = next;
                  pending = pending.slice(newline + 1);
                }
                if (pending.length > 32 * 1024 * 1024)
                  throw new Error("Transcript record exceeds limit");
              }
              if (frames.length > 65536) throw new Error("Transcript frame exceeds limit");
            } catch (error) {
              fatal = true;
              throw error;
            }
          },
          signal,
        );
        if (!ending || frames) throw new Error("Transcript stream ended unexpectedly");
        if (ending === "done" && (pending || decoder.end())) {
          fatal = true;
          throw new Error("Incomplete agent transcript");
        }
        return ending === "done";
      },
      signal,
      () => !fatal,
    );
    if (complete) return;
  }
}
