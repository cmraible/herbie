import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "scripts/hosting.ts", "scripts/migrate.ts", "scripts/cleanup.ts"],
      reporter: ["text", "json-summary", "html"],
      reportsDirectory: "coverage/unit",
    },
  },
});
