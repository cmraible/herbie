import assert from "node:assert/strict";
import test from "node:test";
import { parsePortableChangeArtifact } from "../src/portable-change-artifact.js";

const encoded = (bytes: number[]) => btoa(String.fromCharCode(...bytes));

test("portable change artifacts preserve binary bytes, modes, and deletions", () => {
  const artifact = parsePortableChangeArtifact({
    version: 1,
    changes: [
      {
        path: "image.bin",
        expectedBase: null,
        final: { mode: "100644", contentBase64: encoded([0, 255, 1]) },
      },
      {
        path: "run.sh",
        expectedBase: { mode: "100644", objectId: "a".repeat(40) },
        final: { mode: "100755", contentBase64: "" },
      },
      { path: "old.txt", expectedBase: { mode: "100644", objectId: "b".repeat(40) }, final: null },
      {
        path: "link",
        expectedBase: null,
        final: { mode: "120000", contentBase64: encoded([...new TextEncoder().encode("target")]) },
      },
    ],
  });
  assert.equal(artifact.changes.length, 4);
  assert.equal(artifact.changes[0]?.final?.contentBase64, encoded([0, 255, 1]));
  assert.equal(artifact.changes[1]?.final?.mode, "100755");
  assert.equal(artifact.changes[2]?.final, null);
  assert.equal(artifact.changes[3]?.final?.mode, "120000");
});

test("portable change artifacts reject unsafe, duplicate, malformed, and unsupported entries", () => {
  const change = { path: "file", expectedBase: null, final: { mode: "100644", contentBase64: "" } };
  for (const bad of [
    { version: 2, changes: [change] },
    { version: 1, changes: [{ ...change, path: "../escape" }] },
    { version: 1, changes: [change, change] },
    { version: 1, changes: [{ ...change, final: { mode: "160000", contentBase64: "" } }] },
    { version: 1, changes: [{ ...change, final: { mode: "100644", contentBase64: "***" } }] },
    { version: 1, changes: [{ path: "empty", expectedBase: null, final: null }] },
  ])
    assert.throws(() => parsePortableChangeArtifact(bad));
});
