import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSign, generateKeyPairSync } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { readConfig } from "../src/config.js";

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const live = {
  HERBIE_MODE: "live",
  HERBIE_ALLOWED_GITHUB_USER_ID: "7",
  HERBIE_HOST: "0.0.0.0",
  HERBIE_PUBLIC_URL: "https://herbie.example",
  DATABASE_URL: "postgresql://fixture:fixture@database.example/postgres",
  HERBIE_CREDENTIAL_KEY: Buffer.alloc(32, 1).toString("base64"),
  GITHUB_APP_ID: "fixture",
  GITHUB_CLIENT_ID: "fixture",
  GITHUB_CLIENT_SECRET: "fixture",
  GITHUB_PRIVATE_KEY: privateKey,
  GITHUB_WEBHOOK_SECRET: "fixture",
  OPENAI_API_KEY: "fixture-key",
};

test("hosted live configuration accepts an injected private key and leaves execution disabled by default", async () => {
  const config = await readConfig({
    ...live,
    HERBIE_DEPLOYMENT_ID: "config-revision",
    HERBIE_IMAGE_REVISION: "image-revision",
  });
  assert.equal(config.executionEnabled, false);
  assert.equal(config.github?.privateKey, privateKey.trim());
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.deploymentId, "config-revision");
  assert.equal(config.imageRevision, "image-revision");
});

test("live startup requires one canonical immutable owner ID and rejects demo mode", async () => {
  for (const id of [undefined, "", "owner-login", "0", "01", "7,8", " 7", "7\n"]) {
    await assert.rejects(readConfig({ ...live, HERBIE_ALLOWED_GITHUB_USER_ID: id }));
  }
  assert.equal((await readConfig(live)).allowedGithubUserId, "7");
  await assert.rejects(
    readConfig({
      HERBIE_MODE: "demo",
      DATABASE_URL: "postgresql://fixture:fixture@localhost/db",
    }),
  );
});

test("reports multiple configuration problems without including their values", async () => {
  await assert.rejects(
    readConfig({
      ...live,
      HERBIE_PORT: "99999",
      HERBIE_CREDENTIAL_KEY: "secret-canary",
      DAYTONA_API_URL: "secret-canary",
    }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /HERBIE_PORT/);
      assert.match(error.message, /HERBIE_CREDENTIAL_KEY/);
      assert.match(error.message, /DAYTONA_API_URL/);
      assert.doesNotMatch(error.message, /secret-canary/);
      return true;
    },
  );
});

test("validates live execution credentials before creating a runtime", async () => {
  await assert.rejects(readConfig({ ...live, HERBIE_EXECUTION_ENABLED: "true" }), (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /DAYTONA_API_KEY/);
    assert.match(error.message, /HERBIE_DAYTONA_OPENAI_SECRET/);
    return true;
  });
  const config = await readConfig({
    ...live,
    HERBIE_EXECUTION_ENABLED: "true",
    DAYTONA_API_KEY: "key",
    HERBIE_DAYTONA_OPENAI_SECRET: "secret",
  });
  assert.equal(config.daytona?.apiKey, "key");
});

test("rejects invalid origins, database URLs, conflicting sources, and unreadable files", async () => {
  for (const overrides of [
    { HERBIE_PUBLIC_URL: "ftp://herbie.example" },
    { HERBIE_PUBLIC_URL: "https://herbie.example/path" },
    { DATABASE_URL: "https://example.com" },
    { GITHUB_PRIVATE_KEY: "not-a-private-key" },
    { HERBIE_DATABASE_CA: "ca", HERBIE_DATABASE_CA_FILE: "file" },
    { GITHUB_PRIVATE_KEY_FILE: "/missing/key.pem" },
    { GITHUB_PRIVATE_KEY: undefined, GITHUB_PRIVATE_KEY_FILE: "/missing/key.pem" },
  ])
    await assert.rejects(readConfig({ ...live, ...overrides }));
});

test("missing database configuration is rejected by the schema", async () => {
  await assert.rejects(readConfig({}), /DATABASE_URL: Must be a PostgreSQL URL/);
});

test("OpenAI credentials are required in live mode even when execution is disabled", async () => {
  await assert.rejects(readConfig({ DATABASE_URL: live.DATABASE_URL }));
  assert.equal(
    (await readConfig({ ...live, OPENAI_API_KEY: "fixture-key" })).openaiApiKey,
    "fixture-key",
  );
  await assert.rejects(
    readConfig({ DATABASE_URL: live.DATABASE_URL, OPENAI_API_KEY: "fixture-key" }),
  );
  for (const value of [undefined, "", "   "]) {
    for (const execution of ["true", "false"])
      await assert.rejects(
        readConfig({
          ...live,
          HERBIE_EXECUTION_ENABLED: execution,
          DAYTONA_API_KEY: "key",
          HERBIE_DAYTONA_OPENAI_SECRET: "secret",
          OPENAI_API_KEY: value,
        }),
        /OPENAI_API_KEY/,
      );
  }
});

test("rejects unsupported Daytona URLs during environment validation", async () => {
  const environment = {
    ...live,
    HERBIE_EXECUTION_ENABLED: "true",
    DAYTONA_API_KEY: "key",
    HERBIE_DAYTONA_OPENAI_SECRET: "secret",
  };
  for (const url of [
    "http://daytona.example/api",
    "https://user:password@daytona.example/api",
    "https://daytona.example/api?query=1",
    "https://daytona.example/api#fragment",
  ]) {
    await assert.rejects(
      readConfig({ ...environment, DAYTONA_API_URL: url }),
      /DAYTONA_API_URL: Must use HTTPS/,
    );
  }
  assert.equal(
    (await readConfig({ ...environment, DAYTONA_API_URL: "https://daytona.example/api" })).daytona
      ?.apiUrl,
    "https://daytona.example/api",
  );
});

test("normalizes file-based private keys before passing them to GitHub", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "herbie-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "key.pem");
  await writeFile(path, `  \n${privateKey}  \n`);
  const config = await readConfig({
    ...live,
    GITHUB_PRIVATE_KEY: undefined,
    GITHUB_PRIVATE_KEY_FILE: path,
  });
  assert.equal(config.github?.privateKey, privateKey.trim());
  assert.ok(createSign("RSA-SHA256").update("jwt").sign(config.github!.privateKey).length);
});

test("E2B selection requires its API key and secret without requiring Daytona credentials", async () => {
  const env = {
    ...live,
    HERBIE_EXECUTION_ENABLED: "true",
    HERBIE_ENVIRONMENT_PROVIDER: "e2b",
    E2B_API_KEY: "e2b-key",
    HERBIE_E2B_TEMPLATE: "runtime",
    HERBIE_E2B_OPENAI_SECRET: "openai",
  };
  const config = await readConfig(env);
  assert.equal(config.environmentProvider, "e2b");
  assert.equal(config.e2b?.template, "runtime");
  assert.equal(config.daytona, undefined);
  const automatic = await readConfig({ ...env, HERBIE_E2B_TEMPLATE: undefined });
  assert.equal(automatic.e2b?.apiKey, "e2b-key");
  assert.equal(automatic.e2b?.template, undefined);
  for (const field of ["E2B_API_KEY", "HERBIE_E2B_OPENAI_SECRET"])
    await assert.rejects(readConfig({ ...env, [field]: undefined }));
  await assert.rejects(readConfig({ ...env, HERBIE_ENVIRONMENT_PROVIDER: "unknown" }));
});
