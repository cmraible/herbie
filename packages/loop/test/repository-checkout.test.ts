import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";
import { runAgentAttempt, SessionDetached, type AttemptCheckpoint } from "../src/agent-attempt.js";
import type { Environment } from "../src/environment.js";
import { agentNodePath } from "../src/environment-runtime.js";

const exec = promisify(execFile);
const token = "ghs_checkout-fixture";
const repoUrl = "https://github.com/example/private.git";
const helper = fileURLToPath(new URL("../dist/repository-checkout.js", import.meta.url));

test("authenticated checkout rejects a non-GitHub destination before minting credentials", async () => {
  await assert.rejects(
    runAgentAttempt(
      {
        name: "fixture",
        create: async () => assert.fail("Must not provision a sandbox"),
      },
      {
        repoUrl: "https://example.com/owner/repo.git",
        project: "Private work",
        checkoutToken: async () => assert.fail("Must not issue a token for another host"),
      },
      () => {},
    ),
    /GitHub repository URL/,
  );
});

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "herbie-checkout-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (args: string[]) => exec("git", args, { cwd: root });
  await git(["init", "-b", "main", "source"]);
  await writeFile(join(root, "source/file.txt"), "initial\n");
  const identity = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid"];
  await git(["-C", "source", "add", "."]);
  await git(["-C", "source", ...identity, "commit", "-m", "Initial"]);
  const initial = (await git(["-C", "source", "rev-parse", "HEAD"])).stdout.trim();
  await git(["-C", "source", "checkout", "-b", "herbie/review"]);
  await writeFile(join(root, "source/file.txt"), "review\n");
  await git(["-C", "source", ...identity, "commit", "-am", "Review"]);
  const head = (await git(["-C", "source", "rev-parse", "HEAD"])).stdout.trim();
  await git(["-C", "source", "checkout", "main"]);
  const realGit = (await exec("which", ["git"])).stdout.trim();
  const bin = join(root, "bin");
  await mkdir(bin);
  // Stand in for GitHub transport while using real Git objects and checkout. Check
  // Git's actual URL matching and that no credential reaches argv or the worktree.
  await writeFile(
    join(bin, "git"),
    `#!${process.execPath}
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const args = process.argv.slice(2);
const realGit = ${JSON.stringify(realGit)};
const root = ${JSON.stringify(root)};
const token = ${JSON.stringify(token)};
const repoUrl = ${JSON.stringify(repoUrl)};
assert.ok(!args.join(" ").includes(token));
const clone = args[0] === "clone";
const expectedHeader = "Authorization: Basic " + Buffer.from("x-access-token:" + token).toString("base64");
const configured = execFileSync(realGit, ["config", "--get-urlmatch", "http.extraHeader", repoUrl + "/info/refs"], { encoding: "utf8" }).trim();
assert.equal(configured, clone ? expectedHeader : "");
assert.throws(() => execFileSync(realGit, ["config", "--get-urlmatch", "http.extraHeader", "https://github.com/other/repo.git"], { stdio: "pipe" }));
if (clone) {
  fs.appendFileSync(root + "/clones", "clone");
  assert.ok(args.includes("--no-checkout"));
  assert.equal(args.at(-2), repoUrl);
  if (process.env.CHECKOUT_FAIL) {
    process.stderr.write("remote: rejected " + token + " " + expectedHeader);
    process.exit(1);
  }
  const requested = args.at(-2);
  args[args.length - 2] = root + "/source";
  execFileSync(realGit, args, { stdio: "pipe" });
  assert.equal(fs.existsSync(args.at(-1) + "/file.txt"), false);
  execFileSync(realGit, ["-C", args.at(-1), "remote", "set-url", "origin", requested]);
} else {
  assert.equal(configured, "");
  execFileSync(realGit, args, { stdio: "pipe" });
}
`,
  );
  await chmod(join(bin, "git"), 0o755);
  return { root, initial, head, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, git };
}

for (const pinned of [false, true]) {
  test(`authenticated checkout ${pinned ? "pins a review commit" : "uses the default branch"} without retaining credentials`, async (t) => {
    const { root, initial, head, env, git } = await fixture(t);
    const input = join(root, "credentials.json");
    await writeFile(
      input,
      JSON.stringify({
        token,
        repoUrl,
        cwd: join(root, "checkout"),
        ...(pinned ? { branch: "herbie/review", commit: initial } : {}),
      }),
    );
    const result = await exec(process.execPath, [helper, input], { env });
    assert.equal(result.stdout, "");
    await assert.rejects(access(input));
    assert.equal((await git(["-C", "checkout", "rev-parse", "HEAD"])).stdout.trim(), initial);
    assert.equal(await readFile(join(root, "checkout/file.txt"), "utf8"), "initial\n");
    assert.equal(
      (await git(["-C", "checkout", "rev-parse", "origin/herbie/review"])).stdout.trim(),
      head,
    );
    const config = await readFile(join(root, "checkout/.git/config"), "utf8");
    assert.ok(config.includes(repoUrl));
    assert.doesNotMatch(config, /extraHeader|credential|ghs_checkout|Authorization/i);
  });
}

test("clone failures remove the credential and redact Git output", async (t) => {
  const { root, env } = await fixture(t);
  const input = join(root, "credentials.json");
  await writeFile(input, JSON.stringify({ token, repoUrl, cwd: join(root, "checkout") }));
  const error = await exec(process.execPath, [helper, input], {
    env: { ...env, CHECKOUT_FAIL: "1" },
  }).then(
    () => assert.fail("Expected checkout failure"),
    (error) => error,
  );
  assert.equal(error.code, 1);
  assert.match(error.stdout, /sandbox-repository-checkout/);
  assert.ok(!error.stdout.includes(token));
  assert.ok(!error.stdout.includes(Buffer.from(`x-access-token:${token}`).toString("base64")));
  await assert.rejects(access(input));
});

for (const mode of ["legacy", "durable", "reconnected"]) {
  test(`${mode} attempt removes checkout credentials before starting the agent`, async (t) => {
    const durable = mode !== "legacy";
    const { root, env, initial } = await fixture(t);
    let interrupted = false;
    let directory = "";
    let minted = 0;
    let destroyed = false;
    const commands: string[] = [];
    const checkpoints: AttemptCheckpoint[] = [];
    const environment: Environment = {
      id: "local-checkout-fixture",
      prepare: async () => {},
      mkdir: (path) => mkdir(path, { mode: 0o700 }),
      writeFile: async (contents, path) => {
        if (path.endsWith("-git-auth/input.json"))
          assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
        await writeFile(path, contents);
      },
      clone: async () => {
        assert.fail("Authenticated checkout must bypass SDK clone");
      },
      exec: async (command, options) => {
        commands.push(command);
        if (mode === "reconnected" && !interrupted && command.startsWith("rm -rf")) {
          interrupted = true;
          throw new SessionDetached("Observer disconnected after checkout");
        }
        if (command.includes("chown -R")) {
          await assert.rejects(access(`${directory}-git-auth`));
          assert.ok(!(await readFile(`${directory}/attempt.json`, "utf8")).includes(token));
          assert.equal(await readFile(`${directory}/repo/file.txt`, "utf8"), "initial\n");
          if (!command.includes("nohup"))
            return { exitCode: 0, result: "herbie-attempt-completed\n" };
          command = command.replace(
            /chown -R[\s\S]*?agent-runner\.js/,
            "echo herbie-attempt-completed",
          );
        }
        // Run durable launches synchronously to avoid polling delays in this fixture.
        command = command.replaceAll(agentNodePath, process.execPath);
        const executable = command.includes("nohup")
          ? command.replace("nohup ", "").replace(/ &$/, "")
          : command;
        try {
          const result = await exec("sh", ["-c", executable], { env, timeout: options.timeoutMs });
          return { exitCode: 0, result: result.stdout + result.stderr };
        } catch (error) {
          const failed = error as { code: number; stdout: string; stderr: string };
          return { exitCode: failed.code, result: failed.stdout + failed.stderr };
        }
      },
      readFile: async () =>
        Readable.from([
          Buffer.from(
            JSON.stringify({
              baseCommit: initial,
              patchBase64: Buffer.from("patch").toString("base64"),
              pullRequestTitle: "Private fix",
              pullRequestBody: "Private repository work",
            }),
          ),
        ]),
      destroy: async () => {
        destroyed = true;
      },
    };
    const provider = {
      name: "fixture",
      connect: async () => environment,
      create: async ({ name }: { name: string }) => {
        directory = `/tmp/${name}`;
        t.after(() =>
          Promise.all([
            rm(directory, { recursive: true, force: true }),
            rm(`${directory}-git-auth`, { recursive: true, force: true }),
          ]),
        );
        return environment;
      },
    };
    let checkpoint: AttemptCheckpoint = {
      version: 1,
      name: `herbie-attempt-${crypto.randomUUID()}`,
      phase: "created",
      deadline: Date.now() + 60_000,
    };
    const run = () =>
      runAgentAttempt(
        provider,
        {
          repoUrl,
          project: "Fix private repository",
          checkoutToken: async () => {
            minted++;
            return token;
          },
          ...(durable
            ? {
                durable: {
                  checkpoint,
                  save: async (state: AttemptCheckpoint) => {
                    checkpoint = structuredClone(state);
                    checkpoints.push(checkpoint);
                  },
                },
              }
            : {}),
        },
        () => {},
        new URL("../dist/", import.meta.url),
      );
    if (mode === "reconnected") {
      await assert.rejects(run(), SessionDetached);
      assert.equal(destroyed, false);
    }
    const result = await run();
    assert.equal(result.patch.toString(), "patch");
    assert.equal(minted, mode === "reconnected" ? 2 : 1);
    assert.equal(await readFile(join(root, "clones"), "utf8"), "clone");
    assert.equal(destroyed, true);
    assert.ok(!JSON.stringify({ commands, checkpoints, result }).includes(token));
  });
}
