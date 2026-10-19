import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, writeFile, appendFile, rm } from "node:fs/promises";
import test from "node:test";
import { followAgentTranscript } from "../src/transcript-stream.js";
import { retryObservation } from "../src/observation.js";
import type { Environment } from "../src/environment.js";

const frame = (bytes: Buffer | string) => Buffer.from(bytes).toString("base64") + "\n";
const directory = () => `/tmp/herbie-attempt-${randomUUID()}`;

test("one reader streams new records before completion and drains the final write", async (t) => {
  const path = directory();
  await mkdir(path);
  t.after(() => rm(path, { recursive: true, force: true }));
  await writeFile(path + "/transcript.jsonl", '{"first":"🌳"}\n');
  let requests = 0;
  const records: string[] = [];
  const stream: NonNullable<Environment["streamCommand"]> = async (command, receive, signal) => {
    requests++;
    const child = spawn("sh", ["-c", command], { signal });
    let pending = Promise.resolve();
    child.stdout.on("data", (chunk) => {
      pending = pending.then(() => receive(chunk.toString()));
    });
    await new Promise<void>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`Reader exit ${code}`)),
      );
    });
    await pending;
  };
  await followAgentTranscript(
    stream,
    path,
    async (record) => {
      records.push(record);
      if (records.length === 1) {
        await appendFile(path + "/transcript.jsonl", '{"last":true}\n');
        await writeFile(path + "/exit", "0");
      }
    },
    new AbortController().signal,
  );
  assert.equal(requests, 1);
  assert.deepEqual(records, ['{"first":"🌳"}', '{"last":true}']);
});

test("reconnect resumes at the persisted byte offset and replays partial UTF-8 safely", async () => {
  const first = '{"first":true}\n',
    last = '{"last":"🌳"}\n';
  const records: string[] = [],
    offsets: number[] = [];
  let connections = 0;
  await followAgentTranscript(
    async (command, receive) => {
      connections++;
      if (connections === 1) {
        assert.ok(command.endsWith(" 0"));
        await receive(frame(first));
        await receive(frame(Buffer.from(last).subarray(0, 11)));
        throw new Error("Connection reset");
      }
      assert.ok(command.endsWith(` ${Buffer.byteLength(first)}`));
      const output = frame(last) + "done\n";
      for (const character of output) await receive(character);
    },
    directory(),
    async (record, offset) => {
      records.push(record);
      offsets.push(offset);
    },
    new AbortController().signal,
  );
  assert.equal(connections, 2);
  assert.deepEqual(records, [first.trim(), last.trim()]);
  assert.deepEqual(offsets, [Buffer.byteLength(first), Buffer.byteLength(first + last)]);
});

test("rotation and worker recovery start at acknowledged record boundaries", async () => {
  let connections = 0;
  const offsets: number[] = [];
  await followAgentTranscript(
    async (command, receive) => {
      connections++;
      assert.ok(command.endsWith(` ${connections === 1 ? 42 : 45}`));
      await receive(frame("{}\n"));
      await receive(connections === 1 ? "more\n" : "done\n");
    },
    directory(),
    async (_, offset) => {
      offsets.push(offset);
    },
    new AbortController().signal,
    42,
  );
  assert.deepEqual(offsets, [45, 48]);
});

test("normal rotation carries a partial record across connections", async () => {
  const records: string[] = [];
  let connections = 0;
  await followAgentTranscript(
    async (command, receive) => {
      connections++;
      assert.ok(command.endsWith(connections === 1 ? " 0" : " 1"));
      await receive(frame(connections === 1 ? "{" : "}\n"));
      await receive(connections === 1 ? "more\n" : "done\n");
    },
    directory(),
    async (record) => {
      records.push(record);
    },
    new AbortController().signal,
  );
  assert.deepEqual(records, ["{}"]);
});

test("persistence and malformed transcript errors are not retried as network failures", async () => {
  for (const mode of ["persistence", "json", "truncated"] as const) {
    let connections = 0;
    await assert.rejects(
      followAgentTranscript(
        async (_, receive) => {
          connections++;
          await receive(frame(mode === "persistence" ? "{}\n" : mode === "json" ? "!\n" : "{"));
          await receive("done\n");
        },
        directory(),
        async () => {
          throw new Error("Database unavailable");
        },
        new AbortController().signal,
      ),
    );
    assert.equal(connections, 1);
  }
});

test("observation failures back off exponentially with bounded retries", async () => {
  const delays: number[] = [];
  let attempts = 0;
  await assert.rejects(
    retryObservation(
      async () => {
        attempts++;
        throw new Error("Network unavailable");
      },
      undefined,
      () => true,
      async (ms) => {
        delays.push(ms);
      },
    ),
    /Network unavailable/,
  );
  assert.equal(attempts, 5);
  assert.deepEqual(delays, [1000, 2000, 4000, 8000]);
});

test("cancellation interrupts reconnect backoff", async () => {
  const controller = new AbortController();
  let attempts = 0;
  const work = retryObservation(async () => {
    attempts++;
    throw new Error("Network unavailable");
  }, controller.signal);
  controller.abort(new Error("Observer stopped"));
  await assert.rejects(work, /Observer stopped/);
  assert.equal(attempts, 1);
});
