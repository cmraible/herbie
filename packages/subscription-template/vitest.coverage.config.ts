import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config";
export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: ["tests/unit/**/*.test.ts", "tests/instrumentation/**/*.test.ts"],
      coverage: { reportsDirectory: "coverage/http" },
    },
  }),
);
