// Public loopback-only test fixtures. This module must never be imported by product code.
export function testEnv() {
  const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:55433/postgres";
  if (!["127.0.0.1", "localhost"].includes(new URL(url).hostname))
    throw new Error("Tests require a loopback-only disposable database");
  return {
    APP_ORIGIN: "http://localhost:8790",
    DATABASE_URL: url,
    BETTER_AUTH_SECRET: "local-only-subscription-test-secret-32-characters",
    EMAIL_API_URL: "http://127.0.0.1:8791/emails",
    EMAIL_API_KEY: "local-only",
    EMAIL_FROM: "test@example.test",
    STRIPE_SECRET_KEY: "sk_test_local_only",
    STRIPE_WEBHOOK_SECRET: "whsec_local_only",
    STRIPE_PRICE_ID: "price_local",
    STRIPE_API_URL: "http://127.0.0.1:8792",
    BILLING_MODE: "test",
    GOOGLE_CLIENT_ID: "local-test-client",
    GOOGLE_CLIENT_SECRET: "local-test-secret",
    GITHUB_CLIENT_ID: "local-test-client",
    GITHUB_CLIENT_SECRET: "local-test-secret",
  };
}
