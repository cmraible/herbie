import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { getMigrations } from "better-auth/db/migration";
import { createIdentity } from "../src/auth.js";
import { createHandler } from "../src/http.js";
import { Store } from "../src/store.js";

const cookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");

test("GitHub OAuth callback creates a real session and rejects unapproved identities", async (t) => {
  assert.ok(process.env.TEST_DATABASE_URL);
  const schema = `oauth_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    options: `-c search_path=${schema}`,
  });
  const config = {
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    DATABASE_SCHEMA: schema,
    PUBLIC_URL: "http://localhost:8787",
    PORT: 8787,
    AUTH_SECRET: "test-only-secret-with-at-least-32-characters",
    GITHUB_APP_ID: "1",
    GITHUB_APP_SLUG: "test-bot",
    GITHUB_CLIENT_ID: "test-client",
    GITHUB_CLIENT_SECRET: "test-secret",
    GITHUB_PRIVATE_KEY: "test-key",
    ALLOWED_GITHUB_IDS: "123",
    AGENT_MODEL: "test",
  };
  let profileId = 123;
  let profileEmail = "octocat@example.com";
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.href === "https://github.com/login/oauth/access_token") {
      assert.equal(init?.method, "POST");
      return Response.json({
        access_token: "test-provider-token",
        token_type: "bearer",
        scope: "read:user,user:email",
      });
    }
    if (url.href === "https://api.github.com/user")
      return Response.json({
        id: profileId,
        login: "octocat",
        name: "Octocat",
        email: profileEmail,
      });
    if (url.href === "https://api.github.com/user/emails")
      return Response.json([{ email: profileEmail, primary: true, verified: true }]);
    throw new Error(`Unexpected external request: ${url.origin}${url.pathname}`);
  });
  try {
    const auth = createIdentity(config, pool);
    await (await getMigrations(auth.identity.options)).runMigrations();
    const handler = createHandler(
      new Store(pool),
      auth,
      {
        repositories: async () => [],
        authorize: async () => {
          throw new Error("Not used");
        },
      },
      config,
    );
    const call = (path: string, init?: RequestInit) =>
      handler(new Request(config.PUBLIC_URL + path, init));
    async function login(extra: Record<string, unknown> = {}) {
      const start = await call("/api/auth/sign-in/social", {
        method: "POST",
        headers: { "content-type": "application/json", origin: config.PUBLIC_URL },
        body: JSON.stringify({
          provider: "github",
          callbackURL: config.PUBLIC_URL + "/",
          ...extra,
        }),
      });
      assert.equal(start.status, 200);
      const authorization = new URL((await start.json()).url);
      assert.equal(
        authorization.searchParams.get("redirect_uri"),
        config.PUBLIC_URL + "/api/auth/callback",
      );
      return call(
        `/api/auth/callback?code=test-code&state=${authorization.searchParams.get("state")}`,
        {
          headers: { cookie: cookies(start) },
        },
      );
    }
    const callback = await login();
    assert.equal(callback.status, 302);
    assert.equal(
      callback.headers.get("location"),
      config.PUBLIC_URL + "/",
      "OAuth should finish sign-in instead of redirecting to MISSING_FIELD",
    );
    const sessionCookies = cookies(callback);
    const me = await call("/api/v1/me", { headers: { cookie: sessionCookies } });
    assert.equal(me.status, 200);
    const user = await me.json();
    assert.equal(user.login, "octocat");
    assert.equal(await auth.userToken(user.id), "test-provider-token");
    assert.equal((await pool.query('SELECT "githubId" FROM "user"')).rows[0].githubId, "123");
    assert.equal((await login()).headers.get("location"), config.PUBLIC_URL + "/");
    for (const path of ["/api/auth/update-user", "/api/auth/sign-up/email"]) {
      assert.equal(
        (
          await call(path, {
            method: "POST",
            headers: {
              cookie: sessionCookies,
              origin: config.PUBLIC_URL,
              "content-type": "application/json",
            },
            body: JSON.stringify({ githubId: "999", login: "spoofed" }),
          })
        ).status,
        404,
      );
    }
    profileId = 999;
    const sameEmail = await login({ githubId: "123" });
    assert.match(sameEmail.headers.get("location") ?? "", /error=account_not_linked/);
    profileEmail = "outsider@example.com";
    const denied = await login({ githubId: "123", additionalData: { githubId: "123" } });
    assert.match(denied.headers.get("location") ?? "", /error=beta_access/);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM "user"')).rows[0].count, 1);
    const errorPage = await call("/api/auth/error?error=beta_access");
    assert.equal(errorPage.status, 200);
    assert.match(errorPage.headers.get("content-type") ?? "", /text\/html/);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
