import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DiffCode } from "../src/DiffCode.js";

function render(diff: string) {
  return renderToStaticMarkup(
    createElement(DiffCode, { className: "language-diff", children: diff }),
  );
}

test("highlights source in added, removed, and context lines of a TypeScript diff", () => {
  const html = render(
    "diff --git a/example.ts b/example.ts\n--- a/example.ts\n+++ b/example.ts\n@@ -1,2 +1,2 @@\n-const old = 1;\n+const next = 2;\n export { next };\n",
  );
  assert.match(
    html,
    /class="diff-deletion">-<span class="diff-source"><span class="hljs-keyword">const<\/span>/,
  );
  assert.match(
    html,
    /class="diff-addition">\+<span class="diff-source"><span class="hljs-keyword">const<\/span>/,
  );
  assert.match(html, /class="diff-source"><span class="hljs-keyword">export<\/span>/);
  assert.match(html, /class="diff-hunk">@@/);
  assert.doesNotMatch(html, /class="diff-addition">\+\+\+/);
});

test("unknown files stay plain text and highlighted HTML is escaped", () => {
  const plain = render("diff --git a/file.unknown b/file.unknown\n+x <script>\n");
  assert.match(plain, /class="diff-addition">\+x &lt;script&gt;/);
  assert.doesNotMatch(plain, /diff-source/);

  const highlighted = render("diff --git a/file.html b/file.html\n+<script>alert(1)</script>\n");
  assert.doesNotMatch(highlighted, /<script>/);
  assert.match(highlighted, /&lt;/);
});
