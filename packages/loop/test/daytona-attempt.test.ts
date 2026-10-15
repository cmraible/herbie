import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { MAX_ARTIFACT_BYTES, MAX_PATCH_BYTES } from "../src/artifact-limits.js";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { test, mock, type TestContext } from "node:test";
import { DaytonaAttemptError, runDaytonaAttempt } from "../src/daytona-attempt.js";
import { createArithmeticFixture } from "./fixtures/arithmetic.js";

type Create = Parameters<typeof runDaytonaAttempt>[0];
type Sandbox = Awaited<ReturnType<Create>>;
const request = {
  snapshot: "approved-codex-runtime",
  domainAllowList: "github.com,api.openai.com",
  outboundProxyUrl: "http://proxy.example:8080",
  secrets: { OPENAI_API_KEY: "existing-codex-secret" },
  repoUrl: "https://github.com/example/repo.git",
  commit: "0123456789abcdef",
  goal: "Fix addition; $(do-not-execute) `nor-this` 'quoted'\nsecond line",
};
const runtimeNames = [
  "codex-initialize",
  "codex-thread",
  "codex-turn",
  "codex-process",
  "daytona-runner",
  "diagnostic-log",
];
const pullRequestTitle = "Fix addition totals";
const pullRequestBody =
  "Fixed addition to sum both operands so totals are correct. Verified with arithmetic tests.";
const changes = {
  pullRequestTitle,
  pullRequestBody,
  baseCommit: "a".repeat(40),
  patch: Buffer.from("diff --git a/file.txt b/file.txt\n"),
};
const completedChanges = {
  ...changes,
  verification: {
    version: 3,
    repoUrl: request.repoUrl,
    baseCommit: changes.baseCommit,
    patchSha256: "fb6f3d476ca7ea43d75e41b36690c464b706e56179dacf4f1a72208ea895d6b4",
    goalCompleted: true,
    sandboxDeleted: true,
  },
};
const artifact = Buffer.from(
  JSON.stringify({
    pullRequestTitle,
    pullRequestBody,
    baseCommit: changes.baseCommit,
    patchBase64: changes.patch.toString("base64"),
  }),
);
const runtime = await Promise.all(
  runtimeNames.map(async (name) => ({
    name: `${name}.js`,
    code: stripTypeScriptTypes(
      await readFile(new URL(`../src/${name}.ts`, import.meta.url), "utf8"),
    ),
  })),
);

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "herbie-daytona-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await Promise.all(runtime.map((file) => writeFile(join(directory, file.name), file.code)));
  const sandbox = {
    id: "attempt-sandbox",
    fs: {
      createFolder: mock.fn<Sandbox["fs"]["createFolder"]>(async () => {}),
      uploadFile: mock.fn<Sandbox["fs"]["uploadFile"]>(async () => {}),
      downloadFileStream: mock.fn<Sandbox["fs"]["downloadFileStream"]>(async () =>
        Readable.from([artifact]),
      ),
    },
    git: { clone: mock.fn<Sandbox["git"]["clone"]>(async () => {}) },
    process: {
      executeCommand: mock.fn<Sandbox["process"]["executeCommand"]>(async () => ({
        exitCode: 0,
        result: "herbie-attempt-completed\n",
      })),
    },
    delete: mock.fn<Sandbox["delete"]>(async () => {}),
  };
  const create = mock.fn<Create>(async () => sandbox);
  const reports: string[] = [];
  const report = (message: string) => {
    reports.push(message);
  };
  const run = (
    options: Partial<Parameters<typeof runDaytonaAttempt>[1]> = {},
    reporter: Parameters<typeof runDaytonaAttempt>[2] = report,
  ) =>
    runDaytonaAttempt(create, { ...request, ...options }, reporter, pathToFileURL(directory + "/"));
  return { directory, sandbox, create, reports, run };
}

test("prepares runtime and repo, invokes the attempt, and waits for deletion using SDK contracts", async (t) => {
  const { sandbox, create, reports, run } = await fixture(t);
  let release = () => {};
  const deleting = new Promise<void>((resolve) => {
    release = resolve;
  });
  sandbox.delete.mock.mockImplementation(() => deleting);
  const done = run();
  while (!sandbox.delete.mock.callCount()) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    reports.some((message) => message.startsWith("Deletion confirmed")),
    false,
  );
  release();
  assert.deepEqual(await done, completedChanges);
  const [params, options] = create.mock.calls[0].arguments;
  assert.deepEqual(params, {
    name: params.name,
    snapshot: request.snapshot,
    domainAllowList: request.domainAllowList,
    secrets: request.secrets,
    outboundProxyUrl: request.outboundProxyUrl,
    ttlMinutes: 35,
  });
  assert.match(params.name ?? "", /^herbie-attempt-[0-9a-f-]+$/);
  assert.deepEqual(options, { timeout: 120 });
  const root = `/tmp/${params.name}`;
  assert.deepEqual(sandbox.fs.createFolder.mock.calls[0].arguments, [root, "700"]);
  assert.deepEqual(sandbox.git.clone.mock.calls[0].arguments, [
    request.repoUrl,
    `${root}/repo`,
    undefined,
    request.commit,
  ]);
  const uploads = sandbox.fs.uploadFile.mock.calls.map((call) => call.arguments);
  assert.deepEqual(
    uploads.map(([, path]) => path),
    [
      ...runtimeNames.map((name) => `${root}/${name}.js`),
      `${root}/package.json`,
      `${root}/attempt.json`,
    ],
  );
  assert.ok(uploads.every(([, , timeout]) => timeout === 30));
  const input = uploads.at(-1);
  assert.ok(input);
  assert.deepEqual(JSON.parse(input[0].toString()), { cwd: `${root}/repo`, goal: request.goal });
  assert.deepEqual(sandbox.process.executeCommand.mock.calls[1].arguments, [
    `chown -R compat:compat ${root} && runuser -u compat -- env HOME=/home/compat PATH=/usr/local/bin:/usr/bin:/bin:/home/compat/.local/bin node ${root}/daytona-runner.js`,
    root,
    undefined,
    22 * 60,
  ]);
  assert.equal(sandbox.process.executeCommand.mock.calls[0].arguments[3], 30);
  assert.equal(sandbox.fs.downloadFileStream.mock.calls[0].arguments[0], `${root}/changes.json`);
  assert.equal(sandbox.fs.downloadFileStream.mock.calls[0].arguments[1].timeout, 30);
  assert.ok(sandbox.fs.downloadFileStream.mock.calls[0].arguments[1].signal.aborted);
  assert.deepEqual(sandbox.delete.mock.calls[0].arguments, [60, true]);
  assert.equal(reports.at(-1), "Deletion confirmed for sandbox attempt-sandbox");
  assert.equal(sandbox.git.clone.mock.callCount(), 1);
  assert.equal(sandbox.process.executeCommand.mock.callCount(), 2);
  assert.equal(sandbox.fs.downloadFileStream.mock.callCount(), 1);
});

for (const phase of [
  "preflight",
  "upload",
  "clone",
  "execute",
  "nonzero",
  "wrong-output",
  "download",
  "invalid-json",
  "invalid-artifact",
  "invalid-base64",
  "delete",
  "execute-and-delete",
  "download-and-delete",
]) {
  test(`reports ${phase} failure and cleans up after acquiring the sandbox`, async (t) => {
    const { sandbox, reports, run } = await fixture(t);
    const fail = async () => {
      throw new Error("private SDK detail");
    };
    if (phase === "upload") sandbox.fs.uploadFile.mock.mockImplementation(fail);
    if (phase === "clone") sandbox.git.clone.mock.mockImplementation(fail);
    if (phase === "preflight") sandbox.process.executeCommand.mock.mockImplementation(fail);
    if (phase === "execute" || phase === "execute-and-delete")
      sandbox.process.executeCommand.mock.mockImplementationOnce(fail, 1);
    if (phase === "nonzero" || phase === "wrong-output") {
      sandbox.process.executeCommand.mock.mockImplementationOnce(
        async () => ({ exitCode: phase === "nonzero" ? 1 : 0, result: "private output" }),
        1,
      );
    }
    if (phase === "download" || phase === "download-and-delete")
      sandbox.fs.downloadFileStream.mock.mockImplementation(fail);
    if (phase === "invalid-json")
      sandbox.fs.downloadFileStream.mock.mockImplementation(async () =>
        Readable.from([Buffer.from("invalid JSON")]),
      );
    if (phase === "invalid-artifact")
      sandbox.fs.downloadFileStream.mock.mockImplementation(async () =>
        Readable.from([Buffer.from('{"baseCommit":"unknown","patch":null}')]),
      );
    if (phase === "invalid-base64")
      sandbox.fs.downloadFileStream.mock.mockImplementation(async () =>
        Readable.from([
          Buffer.from(
            JSON.stringify({ baseCommit: changes.baseCommit, patchBase64: "not base64!" }),
          ),
        ]),
      );
    if (phase === "delete" || phase.endsWith("-and-delete"))
      sandbox.delete.mock.mockImplementation(fail);
    await assert.rejects(run(), (error) => {
      assert.ok(error instanceof DaytonaAttemptError);
      assert.equal(error.errors.length, phase.endsWith("-and-delete") ? 2 : 1);
      assert.deepEqual(error.changes, phase === "delete" ? changes : undefined);
      assert.doesNotMatch(error.message, /private/);
      return true;
    });
    assert.equal(sandbox.delete.mock.callCount(), 1);
    if (phase === "delete" || phase.endsWith("-and-delete"))
      assert.equal(
        reports.some((message) => message.startsWith("Deletion confirmed")),
        false,
      );
    if (phase === "preflight" || phase === "upload")
      assert.equal(sandbox.git.clone.mock.callCount(), 0);
    if (phase === "clone") assert.equal(sandbox.process.executeCommand.mock.callCount(), 1);
  });
}

test("waits for change retrieval before starting sandbox deletion", async (t) => {
  const { sandbox, run, reports } = await fixture(t);
  const download = Promise.withResolvers<Readable>();
  sandbox.fs.downloadFileStream.mock.mockImplementation(() => download.promise);
  const done = run();
  while (!sandbox.fs.downloadFileStream.mock.callCount())
    await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sandbox.delete.mock.callCount(), 0);
  download.resolve(Readable.from([artifact]));
  assert.deepEqual(await done, completedChanges);
  assert.equal(sandbox.delete.mock.callCount(), 1);
  assert.ok(reports.every((message) => !message.includes(changes.patch.toString())));
});

test("creation failure remains unconfirmed without retries or fake deletion", async (t) => {
  const { create, sandbox, run } = await fixture(t);
  create.mock.mockImplementation(async () => {
    throw new Error("private create failure");
  });
  await assert.rejects(run(), /Creation failed.*cleanup is unconfirmed/);
  assert.equal(create.mock.callCount(), 1);
  assert.equal(sandbox.delete.mock.callCount(), 0);
});

test("missing runtime and credential-bearing repo URLs fail before provisioning", async (t) => {
  const { create, directory } = await fixture(t);
  await assert.rejects(
    runDaytonaAttempt(
      create,
      { ...request, repoUrl: "https://user:secret@github.com/repo" },
      () => {},
    ),
    /public HTTPS/,
  );
  await rm(join(directory, "codex-process.js"));
  await assert.rejects(
    runDaytonaAttempt(create, request, () => {}, pathToFileURL(directory + "/")),
    /ENOENT/,
  );
  assert.equal(create.mock.callCount(), 0);
});

async function localFixture(t: TestContext, edits = "") {
  const { directory, sandbox, run } = await fixture(t);
  const bin = join(directory, "bin");
  await mkdir(bin);
  const record = join(directory, "protocol");
  const protocolFixture = fileURLToPath(new URL("./fixtures/goal-attempt.ts", import.meta.url));
  await writeFile(
    join(bin, "codex"),
    `#!/usr/bin/env node\n${edits}\n(await import('node:fs')).writeFileSync('../pr-title.txt', ${JSON.stringify(pullRequestTitle)});\n(await import('node:fs')).writeFileSync('../pr-description.md', ${JSON.stringify(pullRequestBody)});\nprocess.argv = [process.execPath, ${JSON.stringify(protocolFixture)}, 'success', ${JSON.stringify(record)}];\nawait import(${JSON.stringify(pathToFileURL(protocolFixture).href)});\n`,
    { mode: 0o700 },
  );
  sandbox.fs.createFolder.mock.mockImplementation(async (path) => {
    await mkdir(path, { mode: 0o700 });
    t.after(() => rm(path, { recursive: true, force: true }));
  });
  sandbox.fs.uploadFile.mock.mockImplementation(async (contents, path) => {
    await writeFile(path, contents);
  });
  sandbox.fs.downloadFileStream.mock.mockImplementation(async (path: string) =>
    createReadStream(path),
  );
  const baseRepo = join(directory, "base");
  const baseCommit = createArithmeticFixture(baseRepo).trim();
  sandbox.git.clone.mock.mockImplementation(async (_url, path) => {
    await promisify(execFile)("git", ["clone", "--no-hardlinks", baseRepo, path]);
  });
  sandbox.process.executeCommand.mock.mockImplementation(async (command, cwd) => {
    if (!cwd) return { exitCode: 0, result: "fixture preflight" };
    // Execute the uploaded coding runner with a local fake Codex.
    const prefix = `chown -R compat:compat ${cwd} && runuser -u compat -- env HOME=/home/compat PATH=/usr/local/bin:/usr/bin:/bin:/home/compat/.local/bin node `;
    const runner = command.slice(prefix.length);
    assert.equal(command, `${prefix}${cwd}/daytona-runner.js`);
    const { stdout } = await promisify(execFile)(process.execPath, [runner], {
      cwd,
      env: { PATH: `${bin}:${process.env.PATH}` },
      timeout: 8_000,
    });
    return { exitCode: 0, result: stdout };
  });
  sandbox.delete.mock.mockImplementation(async () => {
    for (const call of sandbox.fs.createFolder.mock.calls)
      await rm(call.arguments[0], { recursive: true });
  });
  return { directory, sandbox, run, record, baseRepo, baseCommit };
}

test(
  "uploaded runner executes the connected attempt with a local fake Codex and preserves an empty patch",
  { skip: process.platform === "win32", timeout: 10_000 },
  async (t) => {
    const { sandbox, run, record, baseCommit } = await localFixture(t);
    const result = await run();
    assert.equal(result.pullRequestBody, pullRequestBody);
    assert.equal(result.pullRequestTitle, pullRequestTitle);
    assert.equal(result.baseCommit, baseCommit);
    assert.deepEqual(result.patch, Buffer.alloc(0));
    assert.equal(result.verification?.version, 3);
    const events: unknown[] = (await readFile(record, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.ok(
      events.some(
        (event) =>
          typeof event === "object" &&
          event !== null &&
          "params" in event &&
          JSON.stringify(event.params).includes("do-not-execute"),
      ),
    );
    const paramsFor = (method: string) => {
      const event = events.find(
        (event) =>
          typeof event === "object" &&
          event !== null &&
          "method" in event &&
          event.method === method,
      );
      assert.ok(typeof event === "object" && event !== null && "params" in event);
      return event.params;
    };
    assert.deepEqual(paramsFor("initialize"), {
      clientInfo: { name: "herbie", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    assert.deepEqual(paramsFor("thread/start"), {
      cwd: sandbox.git.clone.mock.calls[0].arguments[1],
      ephemeral: true,
      model: "gpt-6-luna",
      modelProvider: "daytona_openai",
    });
    assert.ok(JSON.stringify(paramsFor("turn/start")).includes("externalSandbox"));
    assert.match(JSON.stringify(paramsFor("turn/start")), /why you chose it/);
    assert.match(JSON.stringify(paramsFor("turn/start")), /pr-description.md/);
    assert.deepEqual(events.slice(-2), [{ completed: "completed" }, { eof: true }]);
    assert.equal(sandbox.delete.mock.callCount(), 1);
  },
);

for (const commitDuringAttempt of [false, true]) {
  test(
    `retrieved patch reproduces tracked, staged, new, binary and non-UTF-8 files after deletion (Codex commits: ${commitDuringAttempt})`,
    { skip: process.platform === "win32", timeout: 10_000 },
    async (t) => {
      const { directory, sandbox, run, baseRepo, baseCommit } = await localFixture(
        t,
        `
      import { writeFileSync, rmSync, chmodSync } from 'node:fs';
      import { execFileSync } from 'node:child_process';
      if (${commitDuringAttempt}) {
        writeFileSync('committed.txt', 'committed during the attempt\\n');
        execFileSync('git', ['add', 'committed.txt']);
        execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
          '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'Codex change']);
      }
      writeFileSync('add.mjs', Buffer.from('// café\\nexport const add = (a, b) => a + b;\\n', 'latin1'));
      chmodSync('add.mjs', 0o755);
      rmSync('add.test.mjs');
      writeFileSync('staged.txt', 'staged change\\n');
      execFileSync('git', ['add', 'staged.txt']);
      writeFileSync('new file.txt', 'new untracked file\\n');
      writeFileSync('empty.txt', '');
      writeFileSync('binary.dat', Buffer.from([0, 255, 1, 254]));
      writeFileSync('.gitignore', 'ignored.txt\\n');
      writeFileSync('ignored.txt', 'excluded build output');
    `,
      );
      const result = await run();
      assert.equal(result.baseCommit, baseCommit);
      const root = sandbox.fs.createFolder.mock.calls[0].arguments[0];
      await assert.rejects(readFile(join(root, "changes.json")), { code: "ENOENT" });
      const patch = join(directory, "retrieved.patch");
      await writeFile(patch, result.patch);
      await promisify(execFile)("git", ["-C", baseRepo, "apply", "--index", patch]);
      assert.deepEqual(
        await readFile(join(baseRepo, "add.mjs")),
        Buffer.from("// café\nexport const add = (a, b) => a + b;\n", "latin1"),
      );
      await assert.rejects(readFile(join(baseRepo, "add.test.mjs")), { code: "ENOENT" });
      assert.equal(await readFile(join(baseRepo, "staged.txt"), "utf8"), "staged change\n");
      assert.equal(await readFile(join(baseRepo, "new file.txt"), "utf8"), "new untracked file\n");
      assert.equal(await readFile(join(baseRepo, "empty.txt"), "utf8"), "");
      assert.deepEqual(await readFile(join(baseRepo, "binary.dat")), Buffer.from([0, 255, 1, 254]));
      await assert.rejects(readFile(join(baseRepo, "ignored.txt")), { code: "ENOENT" });
      const { stdout: mode } = await promisify(execFile)("git", [
        "-C",
        baseRepo,
        "ls-files",
        "--stage",
        "add.mjs",
      ]);
      assert.match(mode, /^100755 /);
      if (commitDuringAttempt)
        assert.equal(
          await readFile(join(baseRepo, "committed.txt"), "utf8"),
          "committed during the attempt\n",
        );
    },
  );
}

test(
  "runner patch extraction failure rejects and still deletes the sandbox",
  { skip: process.platform === "win32", timeout: 10_000 },
  async (t) => {
    const { sandbox, run } = await localFixture(
      t,
      `
    import { writeFileSync } from 'node:fs';
    writeFileSync('.git/index.lock', 'prevent extraction from staging changes');
  `,
    );
    await assert.rejects(run(), (error) => {
      assert.ok(error instanceof DaytonaAttemptError);
      assert.equal(error.changes, undefined);
      return true;
    });
    assert.equal(sandbox.fs.downloadFileStream.mock.callCount(), 0);
    assert.equal(sandbox.delete.mock.callCount(), 1);
  },
);

test("provisions a bounded Ubuntu runtime with default networking when no snapshot is supplied", async (t) => {
  const { create, sandbox, run } = await fixture(t);
  await run({ snapshot: undefined, domainAllowList: undefined });
  const [params] = create.mock.calls[0].arguments;
  assert.deepEqual(params, {
    name: params.name,
    image: "ubuntu:22.04",
    resources: { cpu: 1, memory: 1, disk: 3 },
    secrets: request.secrets,
    outboundProxyUrl: request.outboundProxyUrl,
    ttlMinutes: 35,
  });
  const [setup, cwd, , timeout] = sandbox.process.executeCommand.mock.calls[0].arguments;
  assert.equal(cwd, undefined);
  assert.equal(timeout, 240);
  assert.match(setup, /node-v24\.19\.0-linux-x64/);
  assert.match(setup, /codex-0\.159\.2-linux-x64/);
  assert.match(setup, /sha256sum -c/);
  assert.match(setup, /createHash\('sha512'\)/);
  assert.match(setup, /env_key = "OPENAI_API_KEY"/);
  assert.match(setup, /request_max_retries = 0/);
  assert.match(setup, /supports_websockets = false/);
  assert.doesNotMatch(setup, /existing-codex-secret|http:\/\/proxy\.example/);
});

test("fresh runtime setup failure deletes the sandbox before cloning or starting Codex", async (t) => {
  const { sandbox, run } = await fixture(t);
  sandbox.process.executeCommand.mock.mockImplementation(async () => ({
    exitCode: 1,
    result: "setup failure",
  }));
  await assert.rejects(run({ snapshot: undefined, domainAllowList: undefined }), /Attempt failed/);
  assert.equal(sandbox.git.clone.mock.callCount(), 0);
  assert.equal(sandbox.fs.uploadFile.mock.callCount(), 0);
  assert.equal(sandbox.delete.mock.callCount(), 1);
});

test("aborts an oversized artifact download and cleans up without issuing evidence", async (t) => {
  const { sandbox, run } = await fixture(t);
  const chunk = Buffer.alloc(64 * 1024);
  let bytesProduced = 0;
  const stream = Readable.from(
    (async function* () {
      while (bytesProduced < MAX_ARTIFACT_BYTES * 10) {
        bytesProduced += chunk.length;
        yield chunk;
      }
    })(),
    { highWaterMark: 1 },
  );
  sandbox.fs.downloadFileStream.mock.mockImplementationOnce(async () => stream);
  await assert.rejects(run(), (error) => error instanceof DaytonaAttemptError && !error.changes);
  assert.ok(stream.destroyed);
  assert.ok(sandbox.fs.downloadFileStream.mock.calls[0].arguments[1].signal.aborted);
  assert.ok(
    bytesProduced <= MAX_ARTIFACT_BYTES + chunk.length * 3,
    "overflow must stop producer instead of buffering the rest",
  );
  assert.equal(sandbox.delete.mock.callCount(), 1);
});

test("accepts the patch byte limit and rejects decoded overflow within the same base64 length", async (t) => {
  const { sandbox, run } = await fixture(t);
  for (const size of [MAX_PATCH_BYTES, MAX_PATCH_BYTES + 1]) {
    const patch = Buffer.alloc(size, "a");
    const encoded = Buffer.from(
      JSON.stringify({
        pullRequestTitle,
        pullRequestBody,
        baseCommit: changes.baseCommit,
        patchBase64: patch.toString("base64"),
      }),
    );
    assert.ok(encoded.length <= MAX_ARTIFACT_BYTES);
    sandbox.fs.downloadFileStream.mock.mockImplementation(async () => Readable.from([encoded]));
    if (size === MAX_PATCH_BYTES) assert.equal((await run()).patch.length, size);
    else
      await assert.rejects(
        run(),
        (error) => error instanceof DaytonaAttemptError && !error.changes,
      );
  }
  assert.equal(sandbox.delete.mock.callCount(), 2);
});

test("rejects an interrupted artifact stream and cancels its transport", async (t) => {
  const { sandbox, run } = await fixture(t);
  const stream = Readable.from(
    (async function* () {
      yield artifact.subarray(0, 10);
      throw new Error("transfer interrupted");
    })(),
  );
  sandbox.fs.downloadFileStream.mock.mockImplementation(async () => stream);
  await assert.rejects(run(), (error) => error instanceof DaytonaAttemptError && !error.changes);
  assert.ok(sandbox.fs.downloadFileStream.mock.calls[0].arguments[1].signal.aborted);
  assert.equal(sandbox.delete.mock.callCount(), 1);
});

for (const point of [
  "creation",
  "preparation",
  "folder",
  "upload",
  "clone",
  "preparation-exit",
] as const)
  test(`safe diagnostics identify ${point} and cleanup without exposing SDK details`, async (t) => {
    const { sandbox, create, run, reports } = await fixture(t);
    const secret = "DO-NOT-LOG-secret-command-output-account-id";
    const fail = async () => {
      throw Object.assign(new Error(secret), {
        name: "DaytonaTimeoutError",
        statusCode: 504,
        config: { headers: { authorization: secret } },
        response: { data: secret },
      });
    };
    if (point === "creation") create.mock.mockImplementation(fail);
    if (point === "preparation")
      sandbox.process.executeCommand.mock.mockImplementationOnce(fail, 0);
    if (point === "folder") sandbox.fs.createFolder.mock.mockImplementationOnce(fail, 0);
    if (point === "upload") sandbox.fs.uploadFile.mock.mockImplementationOnce(fail, 0);
    if (point === "clone") sandbox.git.clone.mock.mockImplementationOnce(fail, 0);
    if (point === "preparation-exit")
      sandbox.process.executeCommand.mock.mockImplementationOnce(
        async () => ({ exitCode: 23, result: secret }),
        0,
      );
    const stage =
      point === "creation"
        ? "sandbox_creation"
        : point === "clone"
          ? "repository_clone"
          : ["folder", "upload"].includes(point)
            ? "runtime_upload"
            : "runtime_preparation";
    await assert.rejects(run(), (error) => {
      assert.ok(error instanceof DaytonaAttemptError);
      assert.deepEqual(error.diagnostics, [
        point === "preparation-exit"
          ? { stage, cause: "command_failed", exitCode: 23 }
          : { stage, cause: "timeout", httpStatus: 504 },
      ]);
      assert.equal(error.cleanup, point === "creation" ? "unconfirmed" : "confirmed");
      assert.match(error.safeMessage(), new RegExp(stage));
      assert.doesNotMatch(error.safeMessage(), /DO-NOT-LOG|attempt-sandbox|https/);
      return true;
    });
    assert.equal(create.mock.callCount(), 1);
    assert.equal(sandbox.delete.mock.callCount(), point === "creation" ? 0 : 1);
    assert.ok(reports.includes("Attempt stage: " + stage));
    assert.ok(!reports.some((message) => message.startsWith("Running goal")));
  });

test("stage persistence is awaited before starting runtime preparation", async (t) => {
  const { sandbox, run } = await fixture(t);
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const result = run({}, async (message) => {
    if (message === "Attempt stage: runtime_preparation") {
      entered.resolve();
      await release.promise;
    }
  });
  await entered.promise;
  assert.equal(sandbox.process.executeCommand.mock.callCount(), 0);
  release.resolve();
  await result;
});

test("failed stage persistence still deletes the sandbox and reports confirmed cleanup", async (t) => {
  const { sandbox, run } = await fixture(t);
  await assert.rejects(
    run({}, async (message) => {
      if (message.startsWith("Attempt stage:") && !message.endsWith("sandbox_creation"))
        throw new Error("private database detail");
    }),
    (error) => {
      assert.ok(error instanceof DaytonaAttemptError);
      assert.equal(error.cleanup, "confirmed");
      assert.equal(error.diagnostics[0]?.cause, "event_persistence_failed");
      assert.doesNotMatch(error.safeMessage(), /private/);
      return true;
    },
  );
  assert.equal(sandbox.process.executeCommand.mock.callCount(), 0);
  assert.equal(sandbox.delete.mock.callCount(), 1);
});

test("a deletion failure retains the setup cause and marks cleanup unconfirmed", async (t) => {
  const { sandbox, run } = await fixture(t);
  sandbox.git.clone.mock.mockImplementation(async () => {
    throw Object.assign(new Error("secret URL"), { statusCode: 403 });
  });
  sandbox.delete.mock.mockImplementation(async () => {
    throw Object.assign(new Error("secret deletion details"), { name: "TimeoutError" });
  });
  await assert.rejects(run(), (error) => {
    assert.ok(error instanceof DaytonaAttemptError);
    assert.equal(error.cleanup, "unconfirmed");
    assert.deepEqual(error.diagnostics, [
      { stage: "repository_clone", cause: "http_error", httpStatus: 403 },
      { stage: "sandbox_deletion", cause: "timeout" },
    ]);
    assert.doesNotMatch(error.safeMessage(), /secret/);
    return true;
  });
});

test("runner transports nested original failures to the host with sandbox credentials and prompt redacted", async (t) => {
  const { directory } = await fixture(t);
  const cwd = join(directory, "runner-repo");
  createArithmeticFixture(cwd);
  const prompt = "private-prompt-fixture-do-not-log";
  const secret = "opaque-openai-fixture-do-not-log";
  await writeFile(join(directory, "attempt.json"), JSON.stringify({ cwd, goal: prompt }));
  await writeFile(
    join(directory, "codex-process.js"),
    `export async function runCodexAttempt(_bin,_args,{goal}) { throw new Error('adapter failed '+goal,{cause:Object.assign(new Error('original RPC failure '+process.env.OPENAI_API_KEY),{stderr:'useful runner failure context',signal:'SIGTERM'})}); }`,
  );
  let output = "";
  try {
    await promisify(execFile)(process.execPath, [join(directory, "daytona-runner.js")], {
      env: { PATH: process.env.PATH, OPENAI_API_KEY: secret },
    });
    assert.fail("Runner should fail");
  } catch (error) {
    assert.ok(error instanceof Error && "stdout" in error);
    output = String(error.stdout);
  }
  assert.match(output, /herbie-sandbox-failure:/);
  assert.match(output, /original RPC failure/);
  assert.match(output, /daytona-runner.js/);
  assert.ok(!output.includes(secret));
  assert.ok(!output.includes(prompt));
  assert.ok(Buffer.byteLength(output) < 32_800);
  const { AttemptCommandError } = await import("../src/attempt-diagnostics.js");
  const { diagnosticRecord } = await import("../src/diagnostic-log.js");
  const transported = new DaytonaAttemptError(
    [new Error("Attempt failed", { cause: new AttemptCommandError(1, output) })],
    "Attempt wrapper",
  );
  const host = JSON.stringify(
    diagnosticRecord(transported, { component: "attempt", stage: "model_execution" }),
  );
  assert.match(host, /original RPC failure/);
  assert.match(host, /useful runner failure context/);
  assert.match(host, /SIGTERM/);
  assert.match(host, /stack/);
  assert.ok(!host.includes(secret));
  assert.ok(!host.includes(prompt));
});

for (const deleteFails of [false, true])
  test(
    "cancellation interrupts model execution and retains honest deletion status: " + deleteFails,
    async (t) => {
      const { sandbox, run } = await fixture(t);
      const controller = new AbortController(),
        entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      sandbox.process.executeCommand.mock.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return { exitCode: 1, result: "interrupted" };
      }, 1);
      sandbox.delete.mock.mockImplementation(async () => {
        release.resolve();
        if (deleteFails) throw new Error("synthetic delete failure");
      });
      const work = run({ signal: controller.signal });
      await entered.promise;
      controller.abort();
      await assert.rejects(
        work,
        (error) =>
          error instanceof DaytonaAttemptError &&
          error.cleanup === (deleteFails ? "unconfirmed" : "confirmed"),
      );
      assert.equal(sandbox.delete.mock.callCount(), 1);
      assert.equal(sandbox.fs.downloadFileStream.mock.callCount(), 0);
    },
  );

test("cancellation during sandbox creation deletes the eventual sandbox without running a command", async (t) => {
  const { sandbox, create, run } = await fixture(t);
  const controller = new AbortController();
  create.mock.mockImplementation(async () => {
    controller.abort();
    return sandbox;
  });
  await assert.rejects(
    run({ signal: controller.signal }),
    (error) => error instanceof DaytonaAttemptError && error.cleanup === "confirmed",
  );
  assert.equal(sandbox.delete.mock.callCount(), 1);
  assert.equal(sandbox.process.executeCommand.mock.callCount(), 0);
});

for (const body of [undefined, "", "   ", 123, "x".repeat(60_001)]) {
  test(`rejects invalid agent description (${typeof body}, length ${String(body).length}) and deletes sandbox`, async (t) => {
    const { sandbox, run } = await fixture(t);
    sandbox.fs.downloadFileStream.mock.mockImplementation(async () =>
      Readable.from([
        Buffer.from(
          JSON.stringify({
            baseCommit: changes.baseCommit,
            patchBase64: changes.patch.toString("base64"),
            pullRequestTitle,
            pullRequestBody: body,
          }),
        ),
      ]),
    );
    await assert.rejects(run(), DaytonaAttemptError);
    assert.equal(sandbox.delete.mock.callCount(), 1);
  });
}

test("attempts for the same goal retain their own agent-authored titles and descriptions", async (t) => {
  const { sandbox, run } = await fixture(t);
  for (const body of [
    "Fixed addition so totals are accurate.",
    "Added empty-input handling so totals default to zero.",
  ]) {
    sandbox.fs.downloadFileStream.mock.mockImplementation(async () =>
      Readable.from([
        Buffer.from(
          JSON.stringify({
            baseCommit: changes.baseCommit,
            patchBase64: changes.patch.toString("base64"),
            pullRequestTitle: body,
            pullRequestBody: body,
          }),
        ),
      ]),
    );
    const result = await run();
    assert.equal(result.pullRequestBody, body);
    assert.equal(result.pullRequestTitle, body);
  }
});

for (const title of [undefined, "", "   ", 123, "x".repeat(257), "First\nSecond"]) {
  test(`rejects invalid agent title (${JSON.stringify(title)}) and deletes sandbox`, async (t) => {
    const { sandbox, run } = await fixture(t);
    sandbox.fs.downloadFileStream.mock.mockImplementation(async () =>
      Readable.from([
        Buffer.from(
          JSON.stringify({
            ...JSON.parse(artifact.toString()),
            pullRequestTitle: title,
          }),
        ),
      ]),
    );
    await assert.rejects(run(), DaytonaAttemptError);
    assert.equal(sandbox.delete.mock.callCount(), 1);
  });
}
