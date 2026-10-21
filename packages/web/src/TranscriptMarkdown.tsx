import { useEffect, useState, type ReactNode } from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";

export type TranscriptPullRequest = { title?: string; body?: string | null };

function localPath(url: string): string | null {
  if (!url || url.startsWith("//")) return null;
  if (/^[a-z][a-z\d+.-]*:/i.test(url) && !url.startsWith("file:")) return null;
  try {
    return decodeURIComponent(url.replace(/^file:\/\//, "").split(/[?#]/)[0]);
  } catch {
    return url;
  }
}

function ArtifactLink({
  name,
  content,
  children,
}: {
  name: string;
  content: string;
  children: ReactNode;
}) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const objectUrl = URL.createObjectURL(
      new Blob([content], { type: "text/plain;charset=utf-8" }),
    );
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [content]);
  return (
    <a
      href={url}
      download={name}
      title={`Download saved PR ${name === "pr-title.txt" ? "title" : "description"}`}
    >
      {children}
    </a>
  );
}

export function TranscriptMarkdown({
  children,
  pullRequest,
}: {
  children: string;
  pullRequest?: TranscriptPullRequest;
}) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      // Preserve file URLs only for our link renderer. Keep Markdown's normal
      // protocol filtering for external links and images.
      urlTransform={(url, key) =>
        key === "href" && localPath(url) !== null ? url : defaultUrlTransform(url)
      }
      components={{
        a: ({ href, children, title }) => {
          const path = localPath(href ?? "");
          if (path === null)
            return (
              <a href={href} title={title}>
                {children}
              </a>
            );
          const name = path.split("/").pop();
          const content =
            name === "pr-title.txt"
              ? pullRequest?.title
              : name === "pr-description.md"
                ? pullRequest?.body
                : undefined;
          if (content != null)
            return (
              <ArtifactLink name={name!} content={content}>
                {children}
              </ArtifactLink>
            );
          return (
            <span title="Sandbox file unavailable; this path is not a website link.">
              {children} (sandbox file unavailable)
            </span>
          );
        },
      }}
    >
      {children}
    </Markdown>
  );
}
