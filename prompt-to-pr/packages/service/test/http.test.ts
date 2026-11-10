import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { getMigrations } from "better-auth/db/migration";
import { Store } from "../src/store.js";
import { createHandler } from "../src/http.js";
import { createIdentity } from "../src/auth.js";

test("HTTP + real auth sessions + Postgres enforce login, ownership, CSRF, and idempotency", async () => {
  assert.ok(process.env.TEST_DATABASE_URL);
  // This test owns the public schema of the disposable database; store tests use isolated schemas.
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  try {
    const config = {
      DATABASE_URL: process.env.TEST_DATABASE_URL!,
      PUBLIC_URL: "http://localhost:8787",
      DATABASE_SCHEMA: "public",
      AUTH_SECRET: "test-only-secret-with-at-least-32-characters",
      GITHUB_APP_ID: "1",
      GITHUB_APP_SLUG: "test-bot",
      GITHUB_CLIENT_ID: "test-client",
      GITHUB_CLIENT_SECRET: "test-secret",
      GITHUB_PRIVATE_KEY: "test-key",
      ALLOWED_GITHUB_IDS: "123,456",
      AGENT_MODEL: "test",
      PORT: 8787,
    };
    const store = new Store(pool);
    await store.migrate();
    const auth = createIdentity(config, pool);
    await (await getMigrations(auth.identity.options)).runMigrations();
    const context = await auth.identity.$context;
    const alice = (await context.adapter.create({
      model: "user",
      data: {
        name: "Alice",
        email: "alice@example.com",
        emailVerified: false,
        githubId: "123",
        login: "alice",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    })) as { id: string };
    const bob = (await context.adapter.create({
      model: "user",
      data: {
        name: "Bob",
        email: "bob@example.com",
        emailVerified: false,
        githubId: "456",
        login: "bob",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    })) as { id: string };
    const aliceSession = await context.internalAdapter.createSession(alice.id);
    const bobSession = await context.internalAdapter.createSession(bob.id);
    assert.ok(aliceSession);
    assert.ok(bobSession);
    const repositories = [
      { id: 1, fullName: "alice/repo", defaultBranch: "main", installationId: 10 },
    ];
    const handler = createHandler(
      store,
      { ...auth, userToken: async () => "test-provider-token" },
      {
        repositories: async () => repositories,
        authorize: async () => repositories[0],
      },
      config,
    );
    const call = (path: string, token?: string, init: RequestInit = {}) =>
      handler(
        new Request(`${config.PUBLIC_URL}${path}`, {
          ...init,
          headers: {
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...Object.fromEntries(new Headers(init.headers)),
          },
        }),
      );
    assert.equal((await call("/api/v1/runs")).status, 401);
    assert.equal((await call("/api/v1/me", aliceSession.token)).status, 200);
    const key = randomUUID();
    const request = {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({ repositoryId: 1, prompt: "Fix bug" }),
    };
    const created = await call("/api/v1/runs", aliceSession.token, request);
    assert.equal(created.status, 202);
    const run = await created.json();
    assert.equal(
      (await (await call("/api/v1/runs", aliceSession.token, request)).json()).id,
      run.id,
    );
    assert.equal((await call(`/api/v1/runs/${run.id}`, bobSession.token)).status, 404);
    assert.equal((await call(`/api/v1/runs/${run.id}/events`, bobSession.token)).status, 404);
    assert.equal(
      (
        await call("/api/v1/runs", aliceSession.token, {
          ...request,
          headers: { ...request.headers, cookie: "anything=x", origin: "https://evil.example" },
        })
      ).status,
      403,
    );
    assert.equal(
      (await call("/api/auth/get-access-token", aliceSession.token, { method: "POST", body: "{}" }))
        .status,
      404,
    );
    assert.equal((await call("/api/v1/runs/not-a-uuid", aliceSession.token)).status, 400);
    const device = await call("/api/auth/device/code", undefined, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: "prompt-to-pr-cli" }),
    });
    assert.equal(device.status, 200);
    const codes = await device.json();
    assert.ok(codes.device_code);
    assert.ok(codes.user_code);
    const approved = await call("/api/auth/device/approve", aliceSession.token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userCode: codes.user_code }),
    });
    assert.equal(approved.status, 200);
    const exchanged = await call("/api/auth/device/token", undefined, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: "prompt-to-pr-cli",
        device_code: codes.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    assert.equal(exchanged.status, 200);
    assert.equal((await call("/api/v1/me", (await exchanged.json()).access_token)).status, 200);
  } finally {
    await pool.end();
  }
});
