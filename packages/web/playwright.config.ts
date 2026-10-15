import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 2,
  timeout: 30_000,
  expect: { timeout: 15_000 },
  reporter: "list",
  use: {
    baseURL: process.env.HERBIE_E2E_URL ?? "http://127.0.0.1:8787",
    headless: true,
    launchOptions: process.env.HERBIE_PLAYWRIGHT_EXECUTABLE
      ? { executablePath: process.env.HERBIE_PLAYWRIGHT_EXECUTABLE }
      : {},
    viewport: { width: 1440, height: 1000 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
