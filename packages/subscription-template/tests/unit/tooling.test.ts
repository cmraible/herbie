import { test, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
test("lint rejects explicit any, type assertions and TypeScript suppressions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "subscription-lint-"));
  try {
    for (const source of [
      "export const value: any = 1;",
      'export const value = JSON.parse("1") as string;',
      "// @" + "ts-ignore\nexport const value: string = 1;",
    ]) {
      const file = join(dir, "invalid.ts");
      await writeFile(file, source);
      const result = spawnSync(
        "node",
        ["node_modules/oxlint/bin/oxlint", "--config", resolve(".oxlintrc.json"), file],
        { encoding: "utf8" },
      );
      expect(result.status, result.stdout + result.stderr).not.toBe(0);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
