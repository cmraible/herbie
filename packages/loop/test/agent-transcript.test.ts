import assert from "node:assert/strict";
import { test } from "node:test";
import { streamAgentTranscript } from "../src/agent-transcript.js";

test("streams partial UTF-8 records once, in order, and drains after completion", async () => {
  const records = [JSON.stringify({ delta: "Hello 🌳" }), JSON.stringify({ status: "failed" })];
  const bytes = Buffer.from(records.join("\n") + "\n");
  const offsets: number[] = [];
  const received: string[] = [];
  await streamAgentTranscript(
    async (offset) => {
      offsets.push(offset);
      return bytes.subarray(offset, offset + 1);
    },
    async (record) => {
      received.push(record);
    },
    () => true,
  );
  assert.deepEqual(received, records);
  assert.equal(offsets.at(-1), bytes.length);
});

test("records activity before execution completes and drains the final write", async () => {
  let done = false;
  let source = Buffer.from('{"delta":"first"}\n');
  const received: string[] = [];
  await streamAgentTranscript(
    async (offset) => source.subarray(offset),
    async (record) => {
      received.push(record);
      if (received.length === 1) {
        assert.equal(done, false);
        source = Buffer.concat([source, Buffer.from('{"delta":"last"}\n')]);
        done = true;
      }
    },
    () => done,
  );
  assert.deepEqual(received, ['{"delta":"first"}', '{"delta":"last"}']);
});

test("rejects truncated transcripts and persistence failures", async () => {
  await assert.rejects(
    streamAgentTranscript(
      async (offset) => Buffer.from('{"x":').subarray(offset),
      async () => {},
      () => true,
    ),
    /Incomplete/,
  );
  await assert.rejects(
    streamAgentTranscript(
      async () => Buffer.from("{}\n"),
      async () => {
        throw new Error("Database unavailable");
      },
      () => true,
    ),
    /Database unavailable/,
  );
});
