import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/e2e",
  workers: 1,
  fullyParallel: false,
  timeout: 45000,
  use: {
    baseURL: "http://localhost:8790",
    trace: "retain-on-failure",
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  },
  reporter: [["list"], ["html", { open: "never" }]],
  webServer: [
    {
      command: "pnpm exec tsx scripts/email-fixture.ts",
      url: "http://127.0.0.1:8791/health",
      reuseExistingServer: !process.env.CI,
    },
    {
      command: "pnpm exec tsx scripts/stripe-fixture.ts",
      url: "http://127.0.0.1:8792/health",
      reuseExistingServer: !process.env.CI,
    },
    {
      command: "pnpm dev",
      url: "http://localhost:8790/health",
      timeout: 120000,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
