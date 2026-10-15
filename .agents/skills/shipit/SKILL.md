---
name: shipit
description: Ship current local changes through local review, a pull request, and auto-merge after CI. Use for end-to-end shipping requests, including "ship it yolo" or standalone "yolo" and variations; YOLO skips code review. A request only to open or review a PR does not authorize merging.
---

# Ship it

Carry the current work through to a verified merge. A user request to run `$shipit` authorizes committing, pushing, creating or updating the PR, replying to review feedback, making scoped fixes, and merging once the gates below pass. Preserve any narrower user constraints. Automatic skill selection alone does not grant that authorization.

## Select the mode

Use normal mode by default. An explicit shipping instruction containing "yolo" (case-insensitive, including variations such as "YOLO ship it" or standalone "yolo") authorizes this workflow in YOLO mode. Mentions in quoted text, documentation, or requests to edit this skill are not invocations.

In YOLO mode, skip all code review: launch no review subagents, request no PR review, and skip every local review gate and re-review cycle below, including after fixes or conflict resolution. Use the locally checked commit wherever the workflow refers to a reviewed commit. Keep local checks, CI repair, head-SHA checks, auto-merge, and merge verification. Required repository approvals and branch protections still apply. Report that review was skipped by request.

## Prepare the changes

1. Read applicable repository instructions. Inspect staged, unstaged, and untracked changes, branch commits, remotes, and any existing PR. Establish the intended base branch and the full diff being shipped. If there is no diff to ship and no open PR to continue, report that and stop. Preserve concurrent or unrelated work; ask only when scope or target is genuinely ambiguous.
2. When continuing a selected existing PR, switch to its head branch while preserving local changes; use that branch for the remaining workflow. Run the repository's relevant local checks and fix failures caused by the change. If on the base branch or detached HEAD, create and switch to a feature branch using repository conventions before committing. Commit the intended changes on the feature branch.

## Review locally

Before pushing or opening a PR, launch a local code review subagent with fresh context (`fork_turns: "none"`). Give it the repository path, pinned base and head SHAs, the full diff command, applicable repository instructions, and the originating user requirements or spec. Supply raw requirements rather than the implementation agent's conclusions. Ask it to inspect the full diff for correctness, regressions, missing requirements, and repository standards, returning actionable findings with file/line references and the reviewed head SHA. Keep the reviewer read-only.

Verify each finding against the code, make the smallest correct fix, run relevant checks, and commit. Send the updated full diff to another fresh-context review subagent after any changes. Review is complete when the current head has been reviewed and all actionable findings are addressed; document evidence for findings that do not apply. A disputed blocking finding needs reviewer agreement or user direction. If subagents are unavailable, report that blocker.

## Open the PR and enable auto-merge

Push the reviewed head and reuse the branch's open PR, or create one following repository title/body conventions. Mark it ready and attach its URL to the chat when the app supports it. Confirm repository protections gate merging on all relevant CI checks; wait for any uncovered checks to appear and pass before enabling auto-merge. Confirm the remote head matches the locally reviewed commit, then immediately enable auto-merge using the repository's preferred allowed method and a head-SHA guard when supported, so it merges as soon as required CI and branch protections permit. Respect merge queues and required approvals; never bypass protections with admin overrides. Local review replaces the skill's PR-review wait, but does not satisfy a repository-required approval. If auto-merge is unavailable, report the limitation rather than changing repository settings.

## Monitor CI and verify the merge

Poll in bounded intervals, keeping the user informed of meaningful progress. Inspect CI failures and any incoming actionable PR feedback. For a failure or finding that needs changes, disable auto-merge while repairing, make the smallest correct fix, run relevant checks, commit, and repeat fresh-context local review before pushing. Reply to PR feedback with the fix and validation when applicable. Confirm the new remote head was reviewed locally and re-enable auto-merge. Apply the same review cycle after conflict resolution or an unexpected head change.

Stop and report the blocker if credentials or permissions are missing, feedback requires a product decision or scope expansion, or the same failure persists after three repair attempts. By default, after 30 minutes with no CI or merge progress, leave the PR open and report what is pending and whether auto-merge remains enabled; honor a user-specified waiting window. Never turn a timeout or missing result into approval.

Verify the PR actually merged before claiming success; enabling auto-merge or entering a merge queue is not completion. Report its URL, merge commit, and a brief summary of local review and validation. If blocked, report the PR URL, completed work, and the specific next action needed. Leave branch deletion and other cleanup to repository policy or an explicit user request.
