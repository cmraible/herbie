// Root-only bootstrap; credentials are deleted before checkout or repository code executes.
import { readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

try {
  const input = JSON.parse(await readFile("/root/checkout.json", "utf8"));
  await rm("/root/checkout.json");
  if (!/^[\w.-]+\/[\w.-]+$/.test(input.repository) || !/^[a-f0-9]{40}$/.test(input.baseSha))
    throw new Error("Invalid checkout");
  const url = `https://github.com/${input.repository}.git`;
  const env = {
    PATH: process.env.PATH,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "4",
    GIT_CONFIG_KEY_0: `http.${url}.extraHeader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${input.token}`).toString("base64")}`,
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: "",
    GIT_CONFIG_KEY_2: "core.hooksPath",
    GIT_CONFIG_VALUE_2: "/dev/null",
    GIT_CONFIG_KEY_3: "http.followRedirects",
    GIT_CONFIG_VALUE_3: "false",
  };
  const execute = promisify(execFile);
  await execute("git", ["clone", "--no-checkout", "--template=", "--", url, "/work/repo"], {
    env,
    timeout: 120_000,
  });
  env.GIT_CONFIG_VALUE_0 = "";
  await execute("git", ["-C", "/work/repo", "checkout", "--detach", input.baseSha, "--"], {
    env,
    timeout: 30_000,
  });
} catch {
  process.stderr.write("Repository checkout failed\n");
  process.exitCode = 1;
}
