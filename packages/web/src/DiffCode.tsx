import { type ComponentProps } from "react";

export function DiffCode({ className, children }: ComponentProps<"code">) {
  if (className !== "language-diff" || typeof children !== "string") {
    return <code className={className}>{children}</code>;
  }
  return (
    <code className={className}>
      {children.split(/(?<=\n)/).map((line, index) => (
        <span
          key={index}
          className={
            line.startsWith("@@")
              ? "diff-hunk"
              : line.startsWith("+")
                ? "diff-addition"
                : line.startsWith("-")
                  ? "diff-deletion"
                  : undefined
          }
        >
          {line}
        </span>
      ))}
    </code>
  );
}
