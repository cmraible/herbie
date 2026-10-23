import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ main: "test/worker-runtime-entry.ts" })],
  test: {
    include: ["test/worker-runtime.workers.ts"],
  },
});
