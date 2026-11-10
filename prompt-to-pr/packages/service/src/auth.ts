import { betterAuth } from "better-auth";
import { bearer, deviceAuthorization } from "better-auth/plugins";
import type { Pool } from "pg";
import { ApiError } from "@prompt-to-pr/contracts";
import type { Config } from "./config.js";

export function createIdentity(config: Config, pool: Pool) {
  const allowed = new Set(config.ALLOWED_GITHUB_IDS.split(","));
  const identity = betterAuth({
    appName: "Prompt to PR",
    baseURL: config.PUBLIC_URL,
    basePath: "/api/auth",
    secret: config.AUTH_SECRET,
    database: pool,
    trustedOrigins: [config.PUBLIC_URL],
    emailAndPassword: { enabled: false },
    logger: { disabled: true },
    socialProviders: {
      github: {
        clientId: config.GITHUB_CLIENT_ID,
        clientSecret: config.GITHUB_CLIENT_SECRET,
        redirectURI: `${config.PUBLIC_URL}/api/auth/callback`,
        mapProfileToUser: (profile) => ({
          githubId: String(profile.id),
          login: profile.login,
          email: profile.email || `${profile.id}@users.noreply.github.com`,
        }),
      },
    },
    user: {
      additionalFields: {
        githubId: { type: "string", required: true, input: false },
        login: { type: "string", required: true, input: false },
      },
      validateUserInfo({ user }) {
        if (typeof user.githubId !== "string" || !allowed.has(user.githubId))
          return {
            error: "beta_access",
            errorDescription: "This account is not enabled for the private beta",
          };
      },
    },
    account: { encryptOAuthTokens: true, accountLinking: { enabled: false } },
    session: { expiresIn: 28_800, disableSessionRefresh: true, cookieCache: { enabled: false } },
    advanced: {
      useSecureCookies: config.PUBLIC_URL.startsWith("https:"),
      database: { validateSchema: false },
    },
    plugins: [
      bearer(),
      deviceAuthorization({
        verificationUri: `${config.PUBLIC_URL}/device`,
        expiresIn: "10m",
        interval: "2s",
        validateClient: (id) => id === "prompt-to-pr-cli",
      }),
    ],
  });
  return {
    identity,
    async session(headers: Headers) {
      const session = await identity.api.getSession({ headers });
      if (!session || !allowed.has(session.user.githubId))
        throw new ApiError(401, "login_required", "Sign in with GitHub");
      return { id: session.user.id, login: session.user.login };
    },
    async userToken(userId: string) {
      const context = await identity.$context;
      const user = await context.adapter.findOne<{ githubId: string }>({
        model: "user",
        where: [{ field: "id", value: userId }],
      });
      if (!user || !allowed.has(user.githubId))
        throw new ApiError(403, "beta_access", "Account is no longer enabled");
      const account = (await context.internalAdapter.findAccounts(userId)).find(
        (account) => account.providerId === "github",
      );
      if (!account) throw new ApiError(401, "github_login_required", "Sign in with GitHub again");
      const token = await identity.api.getAccessToken({ body: { accountId: account.id, userId } });
      if (
        !token.accessToken ||
        (token.accessTokenExpiresAt && token.accessTokenExpiresAt.getTime() <= Date.now())
      )
        throw new ApiError(
          401,
          "github_login_required",
          "GitHub authorization expired; sign in again",
        );
      return token.accessToken;
    },
  };
}
export type Identity = ReturnType<typeof createIdentity>;
