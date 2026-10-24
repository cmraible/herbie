import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { configureEnvironmentDocker } from "../src/environment-runtime.js";
import { setupScriptCommand } from "../src/setup-script.js";

test("setup executes literal multiline Bash and stops on failure", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "herbie-setup-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // Docker is tested through the provider preflight; exercise only the script
  // wrapper here, in a disposable directory without elevated privileges.
  const run = (script: string) =>
    promisify(execFile)("bash", [
      "-c",
      setupScriptCommand(script)
        .slice(configureEnvironmentDocker.length)
        .replace("cd /home/compat", `cd '${directory}'`),
    ]);
  const literal = "quotes ' \" ` $(false) $HOME";
  await run(`cat > result <<'END'\n${literal}\nEND\n`);
  assert.equal(await readFile(join(directory, "result"), "utf8"), literal + "\n");
  await assert.rejects(run("false\nprintf 'unexpected' > after-failure\n"));
  await assert.rejects(readFile(join(directory, "after-failure")), { code: "ENOENT" });
  await assert.rejects(run('echo "$UNDEFINED_SETUP_TEST_VARIABLE"'));
  assert.equal(setupScriptCommand(""), "");
  assert.throws(() => setupScriptCommand("echo\0bad"), /Invalid setup script/);
});
