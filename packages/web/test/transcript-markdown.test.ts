import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TranscriptMarkdown } from "../src/TranscriptMarkdown.js";

test("sandbox PR links download metadata from the selected run", () => {
  const html = renderToStaticMarkup(
    createElement(TranscriptMarkdown, {
      children:
        "[Title](/tmp/herbie-attempt-id/pr-title.txt) [Description](file:///tmp/herbie-attempt-id/pr-description.md)",
      pullRequest: { title: "Saved title", body: "Saved description" },
    }),
  );
  assert.match(html, /download="pr-title.txt"/);
  assert.match(html, /download="pr-description.md"/);
  assert.doesNotMatch(html, /href="(?:\/tmp|file:)/);
});

test("missing PR metadata and repository file links explain unavailability", () => {
  const html = renderToStaticMarkup(
    createElement(TranscriptMarkdown, {
      children:
        "[Title](../pr-title.txt) [Description](/tmp/run/pr-description.md) [Source](/workspace/repo/file.ts:42)",
    }),
  );
  assert.doesNotMatch(html, /<a[ >]/);
  assert.equal(html.match(/\(sandbox file unavailable\)/g)?.length, 3);
});

test("external PR filenames remain normal links and unsafe protocols stay filtered", () => {
  const html = renderToStaticMarkup(
    createElement(TranscriptMarkdown, {
      children:
        "[External](https://example.com/pr-title.txt) [CDN](//example.com/pr-description.md) [Unsafe](javascript:alert%281%29)",
      pullRequest: { title: "Saved title", body: "Saved description" },
    }),
  );
  assert.match(html, /href="https:\/\/example.com\/pr-title.txt"/);
  assert.match(html, /href="\/\/example.com\/pr-description.md"/);
  assert.doesNotMatch(html, /download=|href="javascript:/);
});

test("encoded artifact paths work while file images stay filtered", () => {
  const html = renderToStaticMarkup(
    createElement(TranscriptMarkdown, {
      children: "[Title](/tmp/run/pr%2Dtitle.txt) ![Private](file:///etc/passwd)",
      pullRequest: { title: "Saved title" },
    }),
  );
  assert.match(html, /download="pr-title.txt"/);
  assert.doesNotMatch(html, /src="file:/);
});
