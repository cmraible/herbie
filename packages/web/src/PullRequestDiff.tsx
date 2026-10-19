import { useEffect, useState } from "react";
import { createClient } from "@herbie/contracts/client";
import { DiffCode } from "./DiffCode.js";

const api = createClient();

export function PullRequestDiff({ projectId, number }: { projectId: string; number: number }) {
  const [diff, setDiff] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setDiff(null);
    setError(false);
    api.pullRequestDiff(projectId, number).then(
      ({ diff }) => {
        if (active) setDiff(diff);
      },
      () => {
        if (active) setError(true);
      },
    );
    return () => {
      active = false;
    };
  }, [projectId, number, revision]);

  return (
    <section className="pr-diff pr-description" aria-label="Files changed">
      <h3>Files changed</h3>
      {error ? (
        <p role="status">
          Could not load the diff. <button onClick={() => setRevision(revision + 1)}>Retry</button>
        </p>
      ) : diff === null ? (
        <p role="status">Loading diff…</p>
      ) : !diff.trim() ? (
        <p>No changes in this pull request.</p>
      ) : (
        diff
          .split(/(?=^diff --git )/m)
          .filter(Boolean)
          .map((file, index) => (
            <details className="diff-file" key={index} open>
              <summary>{file.split("\n", 1)[0].replace(/^diff --git /, "")}</summary>
              <pre tabIndex={0} aria-label={`File diff ${index + 1}`}>
                <DiffCode className="language-diff">{file}</DiffCode>
              </pre>
            </details>
          ))
      )}
    </section>
  );
}
