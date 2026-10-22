import { createHmac, randomBytes } from "node:crypto";
import { betterAuth } from "better-auth";
import { bearer, deviceAuthorization } from "better-auth/plugins";
import type { Pool } from "pg";
import { z } from "zod";
import { logFailure, registerDiagnosticSecret } from "./diagnostic-log.js";
import { AuthError, type AuthConfig } from "./auth.js";
import { createInstallationAuth, type InstallationIdentity } from "./installation-auth.js";
import { PgAuthStore } from "./auth-store.js";
import type { Github, GithubConfig } from "./github.js";
import { cliConsentPage, cliConsentResult, consentCsp } from "./cli-consent-page.js";

const clientId = "herbie-cli";
const basePath = "/api/identity";
const sessionCookie = (token: string) =>
  `herbie_session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=28800`;
const json = (value: unknown, status = 200, headers?: Headers) =>
  Response.json(value, { status, headers });
const cookie = (headers: Headers, name: string) =>
  headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);

export function createBetterAuth(
  config: AuthConfig & { github: GithubConfig },
  pool: Pool,
  github: Github,
) {
  if (
    config.mode !== "live" ||
    new URL(config.publicUrl).protocol !== "https:" ||
    !config.allowedGithubUserId ||
    !/^[1-9][0-9]*$/.test(config.allowedGithubUserId)
  )
    throw new Error("Live auth requires HTTPS and a numeric GitHub owner ID");
  const credentialKey = Buffer.from(config.credentialKey, "base64");
  if (credentialKey.length !== 32 || credentialKey.toString("base64") !== config.credentialKey)
    throw new Error("Credential key must be 32 bytes encoded as base64");
  // Domain separation lets us reuse the existing high-entropy deployment secret.
  const secret = createHmac("sha256", Buffer.from(config.credentialKey, "base64"))
    .update("herbie-better-auth-v1")
    .digest("base64");
  const identity = betterAuth({
    appName: "Herbie",
    baseURL: config.publicUrl,
    basePath,
    secret,
    database: pool,
    trustedOrigins: [config.publicUrl],
    logger: {
      level: "warn",
      log(_level, message) {
        // Provider diagnostics can include OAuth state or credential payloads.
        logFailure(new Error(message), { component: "better-auth" });
      },
    },
    emailAndPassword: { enabled: false },
    socialProviders: {
      github: {
        clientId: config.github.clientId,
        clientSecret: config.github.clientSecret,
        redirectURI: config.github.callbackUrl,
        mapProfileToUser: (profile) => ({
          githubId: String(profile.id),
          login: profile.login,
          // GitHub Apps without email-read permission can still identify the owner.
          // This placeholder is never used for email sign-in or account linking.
          email: profile.email || `${profile.id}@users.noreply.github.com`,
        }),
      },
    },
    user: {
      modelName: "identity_users",
      // Only our server-owned GitHub profile mapping can supply these fields;
      // user mutation and registration endpoints are not mounted.
      additionalFields: {
        githubId: { type: "string", required: true },
        login: { type: "string", required: true },
      },
      validateUserInfo({ user }) {
        if (user.githubId !== config.allowedGithubUserId)
          return {
            error: "owner_only",
            errorDescription: "Access is restricted to the configured owner",
          };
      },
    },
    session: {
      modelName: "identity_sessions",
      expiresIn: 28_800,
      disableSessionRefresh: true,
      cookieCache: { enabled: false },
    },
    account: {
      modelName: "identity_accounts",
      encryptOAuthTokens: true,
      accountLinking: { enabled: false },
    },
    verification: { modelName: "identity_verifications" },
    advanced: {
      useSecureCookies: true,
      // Startup runs the version-pinned migration before accepting requests.
      database: { validateSchema: false },
    },
    plugins: [
      bearer(),
      deviceAuthorization({
        verificationUri: `${config.publicUrl}/api/auth/cli`,
        expiresIn: "10m",
        interval: "2s",
        validateClient: (id) => id === clientId,
        generateUserCode: () => {
          const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
          const value = [...randomBytes(8)].map((byte) => alphabet[byte % 32]).join("");
          return `${value.slice(0, 4)}-${value.slice(4)}`;
        },
        schema: { deviceCode: { modelName: "identity_device_codes" } },
      }),
    ],
  });
  const headersFor = (token: string) => new Headers({ authorization: `Bearer ${token}` });
  function owner(id: string) {
    if (id !== config.allowedGithubUserId)
      throw new AuthError(403, "Access is restricted to the configured owner");
  }
  // Only installation coordination is shared with the demo/legacy adapter.
  const auth = {
    ...createInstallationAuth(
      config,
      new PgAuthStore(pool),
      github,
      (): InstallationIdentity => auth,
    ),
    async session(token: string) {
      const result = await identity.api.getSession({ headers: headersFor(token) });
      if (!result || result.user.githubId !== config.allowedGithubUserId) return null;
      return {
        mode: "live" as const,
        user: { id: result.user.githubId, login: result.user.login },
      };
    },
    async logout(token: string) {
      await identity.api.signOut({ headers: headersFor(token) });
    },
    async userToken(userId: string) {
      owner(userId);
      const ctx = await identity.$context;
      const user = await ctx.adapter.findOne<{ id: string }>({
        model: "user",
        where: [{ field: "githubId", value: userId }],
      });
      if (!user) throw new AuthError(401, "Sign in with GitHub before continuing");
      const accounts = await ctx.internalAdapter.findAccounts(user.id);
      const account = accounts.find((account) => account.providerId === "github");
      if (!account) throw new AuthError(401, "GitHub connection is missing; sign in again");
      const token = await identity.api.getAccessToken({
        body: { accountId: account.id, userId: user.id },
      });
      if (
        !token.accessToken ||
        (token.accessTokenExpiresAt && token.accessTokenExpiresAt.getTime() <= Date.now())
      )
        throw new AuthError(401, "GitHub login expired; sign in again");
      registerDiagnosticSecret(token.accessToken);
      return token.accessToken;
    },
    async handleRequest(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const headers = request.headers;
      const call = (path: string, body?: unknown) =>
        identity.handler(
          new Request(`${config.publicUrl}${basePath}${path}`, {
            method: body === undefined ? "GET" : "POST",
            headers: new Headers({
              ...Object.fromEntries(headers),
              // Browser navigation to CLI login has no Origin; this is a server-created request.
              origin: headers.get("origin") ?? config.publicUrl,
              "content-type": "application/json",
            }),
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        );
      const signIn = (callbackURL: string) =>
        call("/sign-in/social", { provider: "github", callbackURL });
      if (url.pathname === "/api/auth/start" && request.method === "POST") {
        const { client } = z
          .object({ client: z.enum(["web", "cli"]).default("web") })
          .parse(await request.json());
        if (client === "web") return signIn(`${config.publicUrl}${basePath}/complete`);
        const response = await call("/device/code", { client_id: clientId });
        if (!response.ok) return response;
        const result = await response.json();
        return json({
          url: `${config.publicUrl}/api/auth/cli`,
          pollToken: result.device_code,
          userCode: result.user_code,
        });
      }
      if (url.pathname === "/api/auth/poll" && request.method === "GET") {
        const token = z.string().min(20).max(200).parse(url.searchParams.get("token"));
        const response = await call("/device/token", {
          device_code: token,
          client_id: clientId,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        });
        const result = await response.json();
        if (response.ok) {
          if (!(await auth.session(result.access_token))) return json({ status: "rejected" });
          return json({ status: "complete", token: result.access_token });
        }
        if (result.error === "authorization_pending" || result.error === "slow_down")
          return json({ status: "pending" });
        if (result.error === "access_denied") return json({ status: "rejected" });
        if (["expired_token", "invalid_grant", "invalid_request"].includes(result.error))
          return json({ status: "expired" });
        return response.status === 429
          ? json({ status: "pending" })
          : json({ error: "CLI sign-in failed; start again" }, response.status);
      }
      if (url.pathname === `${basePath}/complete` && request.method === "GET") {
        const session = await identity.api.getSession({ headers });
        if (!session) throw new AuthError(401, "Sign in again");
        owner(session.user.githubId);
        return new Response(null, {
          status: 303,
          headers: {
            location: "/",
            "set-cookie": sessionCookie(session.session.token),
          },
        });
      }
      if (url.pathname === "/api/auth/cli" && ["GET", "POST"].includes(request.method)) {
        const session = await identity.api.getSession({ headers });
        if (!session) {
          if (request.method !== "GET") throw new AuthError(401, "Sign in again");
          const response = await signIn(`${config.publicUrl}/api/auth/cli`);
          if (!response.ok) return response;
          const result = await response.json();
          const next = new Headers(response.headers);
          next.set("location", result.url);
          return new Response(null, { status: 303, headers: next });
        }
        owner(session.user.githubId);
        const next = new Headers({
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": consentCsp,
          "referrer-policy": "same-origin",
        });
        if (request.method === "GET") {
          const csrfToken = randomBytes(32).toString("base64url");
          next.set(
            "set-cookie",
            `herbie_cli_csrf=${csrfToken}; HttpOnly; Secure; SameSite=Strict; Path=/api/auth/cli; Max-Age=600`,
          );
          next.append("set-cookie", sessionCookie(session.session.token));
          return new Response(
            cliConsentPage({
              login: session.user.login,
              expiresAt: new Date(Date.now() + 600_000),
              csrfToken,
              origin: config.publicUrl,
              deviceFlow: true,
            }),
            { headers: next },
          );
        }
        if (headers.get("origin") !== config.publicUrl)
          throw new AuthError(403, "Request origin is not allowed");
        const fields = new URLSearchParams(await request.text());
        const csrf = fields.get("csrfToken");
        if (!csrf || csrf !== cookie(headers, "herbie_cli_csrf"))
          throw new AuthError(403, "Invalid approval; reload this page");
        const decision = z.enum(["approve", "reject"]).parse(fields.get("decision"));
        const userCode = z.string().min(1).max(20).parse(fields.get("userCode"));
        const verified = await call(`/device?user_code=${encodeURIComponent(userCode)}`);
        if (!verified.ok) return verified;
        const response = await call(decision === "approve" ? "/device/approve" : "/device/deny", {
          userCode,
        });
        if (!response.ok) return response;
        next.set(
          "set-cookie",
          "herbie_cli_csrf=; HttpOnly; Secure; SameSite=Strict; Path=/api/auth/cli; Max-Age=0",
        );
        return new Response(cliConsentResult(decision === "approve"), { headers: next });
      }
      if (url.pathname === `${basePath}/error` && request.method === "GET")
        return new Response(
          '<!doctype html><html lang="en"><title>Sign-in failed · Herbie</title><h1>Sign-in failed</h1><p>Sign in with the configured GitHub owner account. <a href="/">Return to Herbie</a> to try again.</p></html>',
          { status: 401, headers: { "content-type": "text/html; charset=utf-8" } },
        );
      if (url.pathname === "/api/auth/callback" && request.method === "GET") {
        const callback = new URL(request.url);
        callback.pathname = `${basePath}/callback/github`;
        return identity.handler(new Request(callback, request));
      }
      // Expose only the OAuth callback. Provider tokens and account mutations stay server-side.
      if (url.pathname === `${basePath}/callback/github` && request.method === "GET")
        return identity.handler(request);
      return json({ error: "Not found" }, 404);
    },
  };
  return {
    auth,
    async migrate() {
      const { getMigrations } = await import("better-auth/db/migration");
      const connection = await pool.connect();
      try {
        await connection.query("SELECT pg_advisory_lock(hashtext('herbie-better-auth-v1'))");
        const { runMigrations } = await getMigrations(identity.options);
        await runMigrations();
      } finally {
        try {
          await connection.query("SELECT pg_advisory_unlock(hashtext('herbie-better-auth-v1'))");
        } finally {
          connection.release();
        }
      }
    },
  };
}
