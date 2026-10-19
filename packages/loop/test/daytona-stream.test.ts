import assert from "node:assert/strict";
import test from "node:test";
import { createDaytonaProvider } from "../src/daytona-attempt.js";

for (const cancel of [false, true]) {
  test(`Daytona reader ${cancel ? "cancellation" : "completion"} deletes only its observation session`, async () => {
    const controller = new AbortController();
    let session = "",
      deleted = "",
      destroyed = false;
    const records: string[] = [];
    const provider = createDaytonaProvider(
      async () => ({
        id: "original",
        git: {} as never,
        fs: {} as never,
        delete: async () => {
          destroyed = true;
        },
        process: {
          executeCommand: async () => {
            throw new Error("Must not execute agent");
          },
          createSession: async (id) => {
            session = id;
          },
          executeSessionCommand: async (id, options) => {
            assert.equal(id, session);
            assert.equal(options.command, "reader");
            assert.equal(options.runAsync, true);
            return { cmdId: "reader-id" } as never;
          },
          getSessionCommandLogs: (async (
            id: string,
            cmdId: string,
            onStdout: (value: string) => void,
          ) => {
            assert.equal(id, session);
            assert.equal(cmdId, "reader-id");
            onStdout("first");
            onStdout("last");
            if (cancel) await new Promise(() => {});
          }) as never,
          deleteSession: async (id) => {
            deleted = id;
          },
        },
      }),
      { snapshot: "fixture" },
    );
    const environment = await provider.create({ name: "test", timeoutMs: 60_000 });
    const work = environment.streamCommand!(
      "reader",
      async (chunk) => {
        records.push(chunk);
        if (cancel) controller.abort(new Error("Observer detached"));
      },
      controller.signal,
    );
    if (cancel) await assert.rejects(work, /Observer detached/);
    else {
      await work;
      assert.deepEqual(records, ["first", "last"]);
    }
    assert.match(session, /^herbie-transcript-/);
    assert.equal(deleted, session);
    assert.equal(destroyed, false);
  });
}
