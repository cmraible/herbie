import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

for (const scenario of [
  "missing",
  "existing",
  "build-fails",
  "smoke-fails",
  "push-fails",
  "mismatched",
  "cached-missing",
  "cached-build-fails",
  "cached-smoke-fails",
]) {
  test(`image promotion: ${scenario}`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), "herbie-promotion-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, "scripts"));
    mkdirSync(join(dir, "bin"));
    for (const script of ["promote-portable-image.sh", "build-portable-image.sh"]) {
      copyFileSync(new URL(script, import.meta.url), join(dir, "scripts", script));
    }
    const git = (...args) => {
      const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git("init", "--quiet");
    writeFileSync(join(dir, "payload"), "merged contents");
    git("add", "payload");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "Merged",
    );
    const tree = git("rev-parse", "HEAD^{tree}");
    const revision = git("rev-parse", "HEAD");
    writeFileSync(
      join(dir, "bin", "docker"),
      `#!/usr/bin/env bash
set -eu
echo "$*" >> "$TRACE"
case "$*" in
  'buildx imagetools inspect '*'.Manifest}}')
    [[ "$SCENARIO" == existing || "$SCENARIO" == mismatched || -f uploaded ]] || exit 1
    printf '{"digest":"sha256:%064d"}\\n' 0 ;;
  'buildx imagetools inspect '*'.Image}}')
    label="$TREE"
    [[ "$SCENARIO" != mismatched ]] || label=wrong
    printf '{"config":{"Labels":{"io.herbie.source-tree":"%s"}}}\\n' "$label" ;;
  'build '*) [[ "$SCENARIO" != build-fails ]] ;;
  'buildx create '*) echo fixture-builder ;;
  'buildx build '*) [[ "$SCENARIO" != cached-build-fails ]] ;;
  'push '*) [[ "$SCENARIO" != push-fails ]] && touch uploaded ;;
esac
`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(dir, "scripts", "test-portable-container.sh"),
      'echo "smoke $*" >> "$TRACE"\n[[ "$SCENARIO" != smoke-fails && "$SCENARIO" != cached-smoke-fails ]]\n',
    );
    const result = spawnSync(
      "bash",
      ["scripts/promote-portable-image.sh", "registry.invalid/herbie", tree, revision, "42"],
      {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${join(dir, "bin")}:${process.env.PATH}`,
          TRACE: join(dir, "trace"),
          TREE: tree,
          SCENARIO: scenario,
          REPOSITORY_URL: "https://github.com/example/herbie",
          HERBIE_BUILD_CACHE: scenario.startsWith("cached-")
            ? "registry.invalid/herbie:buildcache"
            : "",
        },
      },
    );
    const trace = readFileSync(join(dir, "trace"), "utf8");
    const succeeds = ["missing", "existing", "cached-missing"].includes(scenario);
    assert.equal(result.status === 0, succeeds, result.stderr);
    assert.equal(trace.includes("imagetools create"), succeeds, trace);
    if (scenario === "missing") {
      assert.match(
        trace,
        new RegExp(`build .*io.herbie.source-tree=${tree}.*HERBIE_RUNTIME_REVISION=${revision}`),
      );
      assert.ok(trace.indexOf("smoke ") < trace.indexOf("push "), trace);
      assert.match(result.stdout.trim(), /^registry\.invalid\/herbie@sha256:[0-9a-f]{64}$/);
    }
    if (scenario === "build-fails") assert.match(trace, /build --/);
    if (scenario === "smoke-fails") assert.match(trace, /smoke /);
    if (scenario === "push-fails") assert.match(trace, /push /);
    if (["existing", "mismatched"].includes(scenario))
      assert.ok(!trace.includes("build --"), trace);
    if (["build-fails", "smoke-fails"].includes(scenario))
      assert.ok(!trace.includes("push "), trace);
    if (scenario.startsWith("cached-")) {
      assert.match(trace, /buildx build --builder .* --load/);
      assert.match(trace, /--cache-from type=registry,ref=registry.invalid\/herbie:buildcache/);
      assert.match(
        trace,
        /--cache-to type=registry,ref=registry.invalid\/herbie:buildcache,mode=max,ignore-error=true/,
      );
      assert.match(trace, /buildx rm herbie-cache-/);
      if (scenario === "cached-missing")
        assert.ok(trace.indexOf("smoke ") < trace.indexOf("push "), trace);
      else assert.ok(!trace.includes("push "), trace);
    } else assert.ok(!trace.includes("--cache-to"), trace);
  });
}
