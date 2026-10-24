import { useState } from "react";
import { createClient } from "@herbie/contracts/client";
import type { Project } from "@herbie/contracts";

const api = createClient();

export function PullRequestActions({
  projectId,
  pr,
}: {
  projectId: string;
  pr: NonNullable<Project["pullRequest"]>;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [approved, setApproved] = useState(false);
  const [merged, setMerged] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [method, setMethod] = useState<"squash" | "merge" | "rebase">("squash");
  const [error, setError] = useState<string | null>(null);
  async function act(action: "approve" | "merge") {
    if (pending || !pr.headSha) return;
    setPending(action);
    setError(null);
    try {
      await api.pullRequestAction(projectId, pr.number, action, pr.headSha, method);
      if (action === "approve") setApproved(true);
      else {
        setMerged(true);
        setConfirming(false);
      }
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Could not complete this action. Please retry.",
      );
    } finally {
      setPending(null);
    }
  }
  if (merged) return <p role="status">Pull request merged.</p>;
  const disabled = !!pending || !pr.headSha || !!pr.draft;
  return (
    <section className="pr-actions" aria-label="Pull request actions">
      <div className="pr-action-buttons">
        <button disabled={disabled || approved} onClick={() => void act("approve")}>
          {pending === "approve" ? "Approving…" : approved ? "Approved" : "Approve"}
        </button>
        <button disabled={disabled || confirming} onClick={() => setConfirming(true)}>
          Merge…
        </button>
      </div>
      {pr.draft && (
        <p>Approval and merging are available when the pull request is ready for review.</p>
      )}
      {!pr.headSha && <p>Refresh to load the latest commit before approving or merging.</p>}
      {approved && <p role="status">Your approval was submitted.</p>}
      {confirming && (
        <div className="pr-merge-confirmation">
          <p>Merge pull request #{pr.number} into its target branch?</p>
          <label>
            Merge method{" "}
            <select
              value={method}
              disabled={!!pending}
              onChange={(event) => setMethod(event.target.value as typeof method)}
            >
              <option value="squash">Squash and merge</option>
              <option value="merge">Create a merge commit</option>
              <option value="rebase">Rebase and merge</option>
            </select>
          </label>
          <div className="pr-action-buttons">
            <button disabled={disabled} onClick={() => void act("merge")}>
              {pending === "merge" ? "Merging…" : "Confirm merge"}
            </button>
            <button disabled={!!pending} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
