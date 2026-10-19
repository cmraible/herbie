import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { executeDurably, SessionDetached } from "../src/durable-execution.js";

test("idle execution does not poll twice a second and observer abort leaves the command alone", async () => {
  const controller = new AbortController();
  let launches = 0,
    reads = 0;
  const work = executeDurably(
    {
      exec: async (command) => {
        if (command.includes("nohup")) launches++;
        else reads++;
        return { exitCode: 0, result: command.includes("nohup") ? "" : "running" };
      },
    },
    "/tmp/herbie-attempt-test",
    "paid-command",
    Date.now() + 60_000,
    controller.signal,
  );
  await delay(650);
  controller.abort(new SessionDetached("Observer stopped"));
  await assert.rejects(work, SessionDetached);
  assert.equal(launches, 1);
  assert.equal(reads, 1);
});

test("transient status failure retries observation without relaunching the command", async () => {
  let launches = 0,
    reads = 0;
  const result = await executeDurably(
    {
      exec: async (command) => {
        if (command.includes("nohup")) {
          launches++;
          return { exitCode: 0, result: "" };
        }
        if (command.includes("printf running")) {
          if (++reads === 1) throw new Error("Connection reset");
          return { exitCode: 0, result: "0" };
        }
        return { exitCode: 0, result: "completed" };
      },
    },
    "/tmp/herbie-attempt-test",
    "paid-command",
    Date.now() + 60_000,
  );
  assert.equal(launches, 1);
  assert.equal(reads, 2);
  assert.deepEqual(result, { exitCode: 0, result: "completed" });
});

// Use a disposable Linux container to test the actual nohup/flock protocol,
// including a command that remains alive when its host observer disappears.
test("lost observer and launch acknowledgement reconnect to one remote execution", async (t) => {
  const container = process.env.HERBIE_TEST_EXECUTION_CONTAINER;
  if (!container)
    return t.skip("Set HERBIE_TEST_EXECUTION_CONTAINER to a disposable Linux container with flock");
  const directory = `/tmp/herbie-attempt-${randomUUID()}`;
  const exec = async (command: string) => {
    const { stdout } = await promisify(execFile)("docker", [
      "exec",
      container,
      "sh",
      "-c",
      command,
    ]);
    return { exitCode: 0, result: stdout };
  };
  t.after(() => exec(`rm -rf ${directory}`));
  const sandbox = { exec };
  const controller = new AbortController();
  let acknowledge = false;
  const first = {
    exec: async (command: string) => {
      const result = await exec(command);
      if (!acknowledge) {
        acknowledge = true;
        throw new Error("Lost launch response");
      }
      return result;
    },
  };
  const command = `printf x >> ${directory}/calls; sleep 2; printf 'same-session\\n'`;
  await assert.rejects(
    executeDurably(first, directory, command, Date.now() + 10_000),
    SessionDetached,
  );
  const observing = executeDurably(
    sandbox,
    directory,
    command,
    Date.now() + 10_000,
    controller.signal,
  );
  controller.abort(new SessionDetached("Deployment"));
  await assert.rejects(observing, SessionDetached);
  const result = await executeDurably(sandbox, directory, command, Date.now() + 10_000);
  assert.deepEqual(result, { exitCode: 0, result: "same-session\n" });
  assert.equal((await exec(`cat ${directory}/calls`)).result, "x");
  assert.deepEqual(await executeDurably(sandbox, directory, "exit 9", Date.now() + 10_000), result);
});
