import { StringDecoder } from "node:string_decoder";

// Read bounded byte ranges so polling never re-downloads an expanding transcript.
export async function streamAgentTranscript(
  read: (offset: number) => Promise<Buffer>,
  report: (message: string, offset: number) => Promise<void>,
  finished: () => boolean,
): Promise<void> {
  const decoder = new StringDecoder("utf8");
  let offset = 0;
  let pending = "";
  let recordedOffset = 0;
  for (;;) {
    const finalRead = finished();
    const chunk = await read(offset);
    offset += chunk.length;
    pending += decoder.write(chunk);
    let end: number;
    while ((end = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      try {
        JSON.parse(line); // Never persist a corrupt or partial protocol record.
      } catch {
        throw new Error("Invalid agent transcript record");
      }
      recordedOffset += Buffer.byteLength(line + "\n");
      await report(line, recordedOffset);
    }
    if (chunk.length === 0) {
      if (finalRead) {
        if (pending || decoder.end()) throw new Error("Incomplete agent transcript");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}
