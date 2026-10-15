import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { Pool } from "pg";
import { createBetterAuth } from "../src/better-auth.js";
import { createGithub } from "../src/github.js";
import { migrateAuth } from "../src/auth-store.js";
import { Store } from "../src/store.js";
import { createApiServer } from "../src/http.js";
import { createDemoAdapters } from "../src/demo.js";

const origin = "https://herbie.example";
async function fixture(t: TestContext) {
  const connectionString = process.env.HERBIE_TEST_DATABASE_URL;
  if (!connectionString) {
    t.skip("Set HERBIE_TEST_DATABASE_URL for PostgreSQL integration");
    return;
  }
  const schema = `better_auth_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  await migrateAuth(pool);
  const githubConfig = {
    appId: "fixture",
    clientId: "fixture",
    clientSecret: "fixture-secret",
    privateKey: "unused",
    callbackUrl: `${origin}/api/auth/callback`,
    webhookSecret: "fixture-secret",
  };
  const config = {
    mode: "live" as const,
    publicUrl: origin,
    credentialKey: Buffer.alloc(32, 1).toString("base64"),
    allowedGithubUserId: "7",
    github: githubConfig,
  };
  const { auth, migrate } = createBetterAuth(config, pool, createGithub(githubConfig));
  await migrate();
  await migrate(); // Restart migrations are idempotent.
  const store = new Store(pool);
  await store.migrate();
  const server = createApiServer({
    store,
    auth,
    adapters: { ...createDemoAdapters(), mode: "live" },
    publicUrl: origin,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  let githubUserId = 7;
  let privateEmail = false;
  const realFetch = globalThis.fetch;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === "https://github.com/login/oauth/access_token")
        return Response.json({
          access_token: "ghu_fixture",
          token_type: "bearer",
          expires_in: 28800,
        });
      if (url === "https://api.github.com/user")
        return Response.json({
          id: githubUserId,
          login: "alice",
          name: "Alice",
          email: privateEmail ? null : "alice@example.com",
          avatar_url: "https://example.com/avatar",
        });
      if (url === "https://api.github.com/user/emails" && privateEmail)
        return Response.json(
          { message: "Resource not accessible by integration" },
          { status: 403 },
        );
      if (url === "https://api.github.com/user/emails")
        return Response.json([{ email: "alice@example.com", primary: true, verified: true }]);
      return realFetch(input, init);
    },
  );
  const jar = new Map<string, string>();
  async function request(
    path: string,
    body?: unknown,
    options: { cookies?: boolean; origin?: string | null; form?: boolean } = {},
  ) {
    const headers = new Headers();
    if (options.origin !== null) headers.set("origin", options.origin ?? origin);
    if (options.cookies !== false)
      headers.set("cookie", [...jar].map(([name, value]) => `${name}=${value}`).join("; "));
    const response = await realFetch(`${baseUrl}${path}`, {
      redirect: "manual",
      method: body === undefined ? "GET" : "POST",
      headers: new Headers({
        ...Object.fromEntries(headers),
        "content-type": options.form ? "application/x-www-form-urlencoded" : "application/json",
      }),
      ...(body === undefined ? {} : { body: options.form ? String(body) : JSON.stringify(body) }),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0];
      const index = pair.indexOf("=");
      jar.set(pair.slice(0, index), pair.slice(index + 1));
    }
    return response;
  }
  async function login() {
    const start = await request("/api/auth/start", { client: "web" });
    assert.equal(start.status, 200, await start.clone().text());
    const url = new URL((await start.json()).url);
    assert.equal(url.origin, "https://github.com");
    assert.equal(url.searchParams.get("redirect_uri"), githubConfig.callbackUrl);
    assert.ok(url.searchParams.get("code_challenge"));
    const callback = await request(
      `/api/auth/callback?code=fixture&state=${url.searchParams.get("state")}`,
    );
    assert.equal(callback.status, 302, await callback.clone().text());
    assert.equal(callback.headers.get("location"), `${origin}/api/identity/complete`);
    const complete = await request("/api/identity/complete");
    assert.equal(complete.status, 303);
    return jar.get("herbie_session")!;
  }
  return {
    auth,
    pool,
    jar,
    request,
    login,
    hideEmail: () => {
      privateEmail = true;
    },
    setGithubUserId: (id: number) => {
      githubUserId = id;
    },
  };
}

test("Better Auth GitHub login preserves owner identity, encrypts provider tokens, and revokes sessions", async (t) => {
  const f = await fixture(t);
  if (!f) return;
  const token = await f.login();
  assert.deepEqual(await f.auth.session(token), {
    mode: "live",
    user: { id: "7", login: "alice" },
  });
  assert.equal(await f.auth.userToken("7"), "ghu_fixture");
  assert.deepEqual(await (await f.request("/api/session")).json(), {
    mode: "live",
    user: { id: "7", login: "alice" },
  });
  const stored = await f.pool.query('SELECT "accessToken" FROM identity_accounts');
  assert.notEqual(stored.rows[0].accessToken, "ghu_fixture");
  assert.equal(await f.auth.session("A".repeat(43)), null);
  assert.equal((await f.request("/api/auth/logout", {})).status, 200);
  assert.equal((await f.request("/api/session")).status, 401);
  assert.equal(await f.auth.session(token), null);
  const nextToken = await f.login();
  assert.ok(await f.auth.session(nextToken));
  await f.pool.query(
    "UPDATE identity_accounts SET \"accessTokenExpiresAt\" = now() - interval '1 minute'",
  );
  await assert.rejects(f.auth.userToken("7"), /expired/);
});

test("passwords and provider-token endpoints are unavailable; non-owner GitHub sign-in is rejected", async (t) => {
  const f = await fixture(t);
  if (!f) return;
  for (const path of [
    "sign-up/email",
    "sign-in/email",
    "request-password-reset",
    "get-access-token",
    "link-social",
    "update-user",
  ]) {
    assert.equal(
      (
        await f.request(`/api/identity/${path}`, {
          email: "alice@example.com",
          password: "password",
        })
      ).status,
      404,
    );
  }
  f.setGithubUserId(8);
  const start = await f.request("/api/auth/start", { client: "web" });
  const state = new URL((await start.json()).url).searchParams.get("state");
  const result = await f.request(`/api/auth/callback?code=fixture&state=${state}`);
  assert.notEqual(result.headers.get("location"), `${origin}/api/identity/complete`);
  assert.equal((await f.pool.query("SELECT count(*) FROM identity_sessions")).rows[0].count, "0");
  await assert.rejects(f.auth.userToken("8"), /restricted/);
});

test("OAuth callback needs the initiating browser and cannot be replayed", async (t) => {
  const f = await fixture(t);
  if (!f) return;
  const start = await f.request("/api/auth/start", { client: "web" });
  const state = new URL((await start.json()).url).searchParams.get("state");
  const path = `/api/auth/callback?code=fixture&state=${state}`;
  const result = await f.request(path, undefined, { cookies: false });
  assert.notEqual(result.headers.get("location"), `${origin}/api/identity/complete`);
  assert.equal((await f.pool.query("SELECT count(*) FROM identity_sessions")).rows[0].count, "0");
  await f.login();
  const replay = await f.request(path);
  assert.notEqual(replay.headers.get("location"), `${origin}/api/identity/complete`);
});

test("CLI receives a separate Better Auth session only after code entry and browser approval", async (t) => {
  const f = await fixture(t);
  if (!f) return;
  const start = await f.request("/api/auth/start", { client: "cli" });
  assert.equal(start.status, 200, await start.clone().text());
  const { pollToken, userCode, url } = await start.json();
  assert.equal(url, `${origin}/api/auth/cli`);
  assert.ok(!url.includes(userCode));
  const navigation = await f.request("/api/auth/cli", undefined, { origin: null });
  assert.equal(navigation.status, 303, await navigation.clone().text());
  assert.equal(new URL(navigation.headers.get("location")!).origin, "https://github.com");
  const authorization = new URL(navigation.headers.get("location")!);
  const callback = await f.request(
    `/api/auth/callback?code=fixture&state=${authorization.searchParams.get("state")}`,
  );
  assert.equal(callback.headers.get("location"), `${origin}/api/auth/cli`);
  const pending = await f.request(`/api/auth/poll?token=${pollToken}`);
  assert.equal((await pending.json()).status, "pending");
  const page = await f.request("/api/auth/cli");
  const html = await page.text();
  const browserToken = f.jar.get("herbie_session")!;
  assert.equal((await f.request("/api/session")).status, 200);
  assert.ok(!html.includes(userCode));
  const csrfToken = f.jar.get("herbie_cli_csrf")!;
  const form = new URLSearchParams({ csrfToken, userCode, decision: "approve" });
  assert.equal(
    (await f.request("/api/auth/cli", form, { form: true, origin: "https://attacker.example" }))
      .status,
    403,
  );
  const approved = await f.request("/api/auth/cli", form, { form: true });
  assert.equal(approved.status, 200, await approved.clone().text());
  assert.match(await approved.text(), /CLI authorized/);
  // Respect the protocol's polling interval without slowing the test clock.
  await f.pool.query('UPDATE identity_device_codes SET "lastPolledAt" = NULL');
  const complete = await f.request(`/api/auth/poll?token=${pollToken}`);
  const result = await complete.json();
  assert.equal(result.status, "complete", JSON.stringify(result));
  assert.notEqual(result.token, browserToken);
  assert.deepEqual(await f.auth.session(result.token), {
    mode: "live",
    user: { id: "7", login: "alice" },
  });
  const replay = await f.request(`/api/auth/poll?token=${pollToken}`);
  assert.equal((await replay.json()).status, "expired");
  await f.auth.logout(result.token);
  assert.equal(await f.auth.session(result.token), null);
  assert.ok(await f.auth.session(browserToken));
});

test("CLI rejection, expiry, and missing browser consent never release a session", async (t) => {
  const f = await fixture(t);
  if (!f) return;
  const first = await (await f.request("/api/auth/start", { client: "cli" })).json();
  const form = new URLSearchParams({
    csrfToken: "invalid",
    userCode: first.userCode,
    decision: "approve",
  });
  assert.equal((await f.request("/api/auth/cli", form, { form: true })).status, 401);
  await f.login();
  await f.request("/api/auth/cli");
  assert.equal((await f.request("/api/auth/cli", form, { form: true })).status, 403);
  form.set("csrfToken", f.jar.get("herbie_cli_csrf")!);
  form.set("decision", "reject");
  assert.equal((await f.request("/api/auth/cli", form, { form: true })).status, 200);
  assert.equal(
    (await (await f.request(`/api/auth/poll?token=${first.pollToken}`)).json()).status,
    "rejected",
  );
  const second = await (await f.request("/api/auth/start", { client: "cli" })).json();
  await f.pool.query(
    "UPDATE identity_device_codes SET \"expiresAt\" = now() - interval '1 minute'",
  );
  assert.equal(
    (await (await f.request(`/api/auth/poll?token=${second.pollToken}`)).json()).status,
    "expired",
  );
});

test("GitHub accounts with private email need no additional App permission", async (t) => {
  const f = await fixture(t);
  if (!f) return;
  f.hideEmail();
  const token = await f.login();
  assert.deepEqual(await f.auth.session(token), {
    mode: "live",
    user: { id: "7", login: "alice" },
  });
  assert.equal(await f.auth.userToken("7"), "ghu_fixture");
});
