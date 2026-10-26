import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

for (const scenario of ["success", "push-fails", "sign-fails", "verify-fails", "superseded"]) {
  test(`release announcement: ${scenario}`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), "herbie-signing-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const revision = "a".repeat(40);
    const digest = `ghcr.io/example/herbie@sha256:${"b".repeat(64)}`;
    const mocks = {
      flux: `
echo "flux $*" >> "$TRACE"
if [[ "$1" == push ]]; then
  [[ "$SCENARIO" != push-fails ]] || exit 1
  printf '{"repository":"ghcr.io/example/herbie","digest":"sha256:%s"}\\n' '${"b".repeat(64)}'
fi`,
      cosign: `
echo "cosign $*" >> "$TRACE"
[[ "$SCENARIO" != "$1-fails" ]]`,
      gh: `
echo "gh $*" >> "$TRACE"
if [[ "$SCENARIO" == superseded ]]; then echo other; else echo '${revision}'; fi`,
    };
    for (const [name, script] of Object.entries(mocks)) {
      writeFileSync(join(dir, name), `#!/usr/bin/env bash\nset -eu\n${script}\n`, { mode: 0o755 });
    }
    const result = spawnSync(
      "bash",
      [
        new URL("publish-release-artifact.sh", import.meta.url).pathname,
        "ghcr.io/example/herbie",
        "42",
        revision,
        dir,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          TRACE: join(dir, "trace"),
          SCENARIO: scenario,
        },
      },
    );
    const trace = readFileSync(join(dir, "trace"), "utf8");
    assert.equal(result.status === 0, scenario === "success", result.stderr);
    assert.equal(trace.includes("flux tag artifact"), scenario === "success", trace);
    assert.match(trace, /flux push artifact oci:\/\/ghcr.io\/example\/herbie:release-/);
    assert.ok(!trace.includes("push artifact oci://ghcr.io/example/herbie:0.0."));
    if (scenario === "success") {
      assert.ok(trace.indexOf("cosign sign") < trace.indexOf("cosign verify"));
      assert.ok(trace.indexOf("cosign verify") < trace.indexOf("flux tag artifact"));
      assert.ok(trace.includes(`cosign sign --yes ${digest}`));
      assert.ok(
        trace.includes(
          "--certificate-identity https://github.com/example/herbie/.github/workflows/portable-image.yml@refs/heads/main",
        ),
      );
      assert.ok(
        trace.includes("--certificate-oidc-issuer https://token.actions.githubusercontent.com"),
      );
      assert.ok(trace.includes(`flux tag artifact oci://${digest} --tag 0.0.42`));
    }
  });
}
