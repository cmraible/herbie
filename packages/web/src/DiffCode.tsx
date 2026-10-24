import { type ComponentProps } from "react";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const languages = {
  bash,
  css,
  go,
  javascript,
  json,
  markdown,
  python,
  rust,
  sql,
  typescript,
  xml,
  yaml,
};

for (const [name, language] of Object.entries(languages)) hljs.registerLanguage(name, language);

const extensions: Record<string, keyof typeof languages> = {
  bash: "bash",
  sh: "bash",
  zsh: "bash",
  css: "css",
  scss: "css",
  go: "go",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  md: "markdown",
  mdx: "markdown",
  py: "python",
  rs: "rust",
  sql: "sql",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  html: "xml",
  htm: "xml",
  svg: "xml",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
};

function diffLanguage(diff: string): keyof typeof languages | undefined {
  const path =
    diff.match(/^\+\+\+ b\/(.+)$/m)?.[1] ?? diff.match(/^diff --git a\/.+ b\/(.+)$/m)?.[1];
  const extension = path?.split("/").pop()?.split(".").pop()?.toLowerCase();
  return extension ? extensions[extension] : undefined;
}

export function DiffCode({ className, children }: ComponentProps<"code">) {
  if (className !== "language-diff" || typeof children !== "string") {
    return <code className={className}>{children}</code>;
  }
  const language = diffLanguage(children);
  return (
    <code className={className}>
      {children.split(/(?<=\n)/).map((line, index) => {
        const changed = !/^(?:\+\+\+|---) (?:[ab]\/|\/dev\/null)/.test(line) && /^[ +-]/.test(line);
        const className = line.startsWith("@@")
          ? "diff-hunk"
          : changed && line.startsWith("+")
            ? "diff-addition"
            : changed && line.startsWith("-")
              ? "diff-deletion"
              : undefined;
        const code = changed ? line.slice(1) : "";
        return (
          <span key={index} className={className}>
            {changed ? line[0] : null}
            {language && code ? (
              <span
                className="diff-source"
                dangerouslySetInnerHTML={{ __html: hljs.highlight(code, { language }).value }}
              />
            ) : changed ? (
              code
            ) : (
              line
            )}
          </span>
        );
      })}
    </code>
  );
}
