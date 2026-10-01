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
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:8790/health",
    timeout: 120000,
    reuseExistingServer: !process.env.CI,
  },
});
