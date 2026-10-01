import { betterAuth } from "better-auth";
import { organization, twoFactor, genericOAuth } from "better-auth/plugins";
import { passkey } from "@better-auth/passkey";
import { PostgresDialect } from "kysely";
import type { Pool } from "pg";
import type { Env } from "./env";
export async function sendEmail(
  env: Omit<Env, "ASSETS">,
  to: string,
  subject: string,
  text: string,
) {
  const endpoint = env.EMAIL_API_URL ?? "https://api.resend.com/emails";
  if (!env.EMAIL_API_KEY || !env.EMAIL_FROM) throw new Error("Email delivery is not configured");
  if (
    !endpoint.startsWith("https://") &&
    !(env.APP_ORIGIN === "http://localhost:8790" && endpoint === "http://127.0.0.1:8791/emails")
  )
    throw new Error("Unsafe email endpoint");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: "Bearer " + env.EMAIL_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject, text }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error("Email delivery failed");
}
export function authOptions(env: Omit<Env, "ASSETS">, pool: Pool) {
  return {
    appName: "Subscription template",
    baseURL: env.APP_ORIGIN,
    secret: env.BETTER_AUTH_SECRET,
    database: {
      dialect: new PostgresDialect({ pool }),
      type: "postgres" as const,
      schemaName: "subscription_auth",
    },
    trustedOrigins: [env.APP_ORIGIN],
    logger: { disabled: true },
    session: { expiresIn: 7 * 86400, cookieCache: { enabled: false } },
    advanced: {
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      useSecureCookies: env.APP_ORIGIN.startsWith("https://"),
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax" as const },
    },
    rateLimit: { enabled: true, storage: "database" as const, window: 60, max: 100 },
    account: { accountLinking: { enabled: false }, encryptOAuthTokens: true },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      requireEmailVerification: true,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }: { user: { email: string }; url: string }) =>
        sendEmail(env, user.email, "Reset your password", url),
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }: { user: { email: string }; url: string }) =>
        sendEmail(env, user.email, "Verify your email", url),
    },
    socialProviders: {
      ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } }
        : {}),
      ...(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
        ? { github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET } }
        : {}),
    },
    plugins: [
      organization({
        allowUserToCreateOrganization: (user) => user.emailVerified,
        requireEmailVerificationOnInvitation: true,
        async sendInvitationEmail(data) {
          await sendEmail(
            env,
            data.email,
            "Workspace invitation",
            env.APP_ORIGIN + "/?invitation=" + encodeURIComponent(data.id),
          );
        },
      }),
      twoFactor({ issuer: "Subscription template" }),
      passkey({
        rpID: new URL(env.APP_ORIGIN).hostname,
        rpName: "Subscription template",
        origin: env.APP_ORIGIN,
      }),
      genericOAuth({
        config: env.OPENAI_CLIENT_ID
          ? [
              {
                providerId: "chatgpt",
                clientId: env.OPENAI_CLIENT_ID,
                ...(env.OPENAI_CLIENT_SECRET
                  ? { clientSecret: env.OPENAI_CLIENT_SECRET }
                  : { tokenEndpointAuth: { method: "none" as const } }),
                discoveryUrl: "https://auth.openai.com/.well-known/openid-configuration",
                scopes: ["openid", "profile", "email"],
                pkce: true,
                requireIdTokenVerification: true,
                requireEmailVerification: true,
              },
            ]
          : [],
      }),
    ],
  } satisfies Parameters<typeof betterAuth>[0];
}
export const auth = (env: Omit<Env, "ASSETS">, pool: Pool) => betterAuth(authOptions(env, pool));
