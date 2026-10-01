import { writeFile } from "node:fs/promises";
// Public local-only fixtures, never use for a hosted deployment.
await writeFile(
  ".dev.vars",
  [
    'APP_ORIGIN="http://localhost:8790"',
    'DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:55432/postgres"',
    'BETTER_AUTH_SECRET="local-only-subscription-test-secret-32-characters"',
    'EMAIL_API_URL="http://127.0.0.1:8791/emails"',
    'EMAIL_API_KEY="local-only"',
    'EMAIL_FROM="test@example.test"',
  ].join("\n"),
  { mode: 0o600 },
);
