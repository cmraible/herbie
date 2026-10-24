import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { installEnvironmentRuntime } from "../src/environment-runtime.js";

test("runtime shell prints valid apt sources and checksum records", async () => {
  const lines = installEnvironmentRuntime.split("\n");
  const source = lines.find((line) => line.startsWith("printf 'deb "))!;
  const { stdout } = await promisify(execFile)("bash", ["-c", source.split(" > ")[0]], {
    env: { ...process.env, VERSION_CODENAME: "noble" },
  });
  assert.match(
    stdout,
    /^deb \[arch=\S+ signed-by=\/etc\/apt\/keyrings\/docker.asc\] https:\/\/download.docker.com\/linux\/ubuntu noble stable\n$/,
  );
  const checksum = lines.find((line) => line.startsWith("printf '%s"))!;
  const result = await promisify(execFile)("bash", ["-c", checksum.split(" | ")[0]]);
  assert.match(result.stdout, /^[a-f0-9]{64}  node.tar.xz\n$/);
});
