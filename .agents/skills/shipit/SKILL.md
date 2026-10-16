---
name: shipit
description: Ship current local changes through local review, a pull request, and a verified merge after CI. Use for end-to-end shipping requests, including "ship it yolo" or standalone "yolo" and variations; YOLO skips code review. A request only to open or review a PR does not authorize merging.
---

# Ship it

Carry the current work through to a verified merge. A user request to run `$shipit` authorizes committing, pushing, creating or updating the PR, replying to review feedback, making scoped fixes, and merging once the gates below pass. Preserve any narrower user constraints. Automatic skill selection alone does not grant that authorization.

Before starting work, record `ship_started_at` in UTC from the triggering user message's receipt timestamp. If unavailable, capture the current time immediately and label the eventual duration approximate. Preserve this timestamp across retries, waits, and resumed turns for the same shipping run, in both normal and YOLO modes.

## Select the mode

Use normal mode by default. An explicit shipping instruction containing "yolo" (case-insensitive, including variations such as "YOLO ship it" or standalone "yolo") authorizes this workflow in YOLO mode. Mentions in quoted text, documentation, or requests to edit this skill are not invocations.

In YOLO mode, skip all code review: launch no review subagents, request no PR review, and skip every local review gate and re-review cycle below, including after fixes or conflict resolution. Use the locally checked commit wherever the workflow refers to a reviewed commit. Keep local checks, CI repair, head-SHA checks, and merge verification. Required repository approvals and branch protections still apply. Report that review was skipped by request.

## Prepare the changes

1. Read applicable repository instructions. Inspect staged, unstaged, and untracked changes, branch commits, remotes, and any existing PR. Establish the intended base branch and the full diff being shipped. If there is no diff to ship and no open PR to continue, report that and stop. Preserve concurrent or unrelated work; ask only when scope or target is genuinely ambiguous.
2. When continuing a selected existing PR, switch to its head branch while preserving local changes; use that branch for the remaining workflow. If on the base branch or detached HEAD, create and switch to a feature branch using repository conventions before committing. Commit the intended changes on the feature branch.
3. Always fetch the latest `main` from the base repository's remote and rebase the feature branch onto that fetched remote-tracking branch before running local checks or code review, in both normal and YOLO modes. Preserve unrelated local changes and resolve any rebase conflicts first. Run the repository's relevant local checks on the rebased changes, fix failures caused by the change, and commit any fixes.

## Review locally

Before pushing or opening a PR, launch a local code review subagent with fresh context (`fork_turns: "none"`). Give it the repository path, pinned base and head SHAs, the full diff command, applicable repository instructions, and the originating user requirements or spec. Supply raw requirements rather than the implementation agent's conclusions. Ask it to inspect the full diff for correctness, regressions, missing requirements, and repository standards, returning actionable findings with file/line references and the reviewed head SHA. Keep the reviewer read-only.

Verify each finding against the code, make the smallest correct fix, run relevant checks, and commit. Send the updated full diff to another fresh-context review subagent after any changes. Review is complete when the current head has been reviewed and all actionable findings are addressed; document evidence for findings that do not apply. A disputed blocking finding needs reviewer agreement or user direction. If subagents are unavailable, report that blocker.

## Open the PR and watch the merge

Push the reviewed head and reuse the branch's open PR, or create one following repository title/body conventions. Mark it ready and attach its URL to the chat when the app supports it. Run the deterministic watcher with the exact reviewed commit and original start timestamp:

```sh
node scripts/ship-watch.mjs --repo OWNER/REPO --pr NUMBER --head REVIEWED_SHA --started-at "$ship_started_at"
```

The watcher requires Herbie's protected `All tests passed` aggregate and every other required check to pass before requesting a squash merge with a head-SHA guard. It respects GitHub approvals and merge queues, handles already-mergeable PRs directly, and confirms the actual merge. Local review does not satisfy a repository-required approval. Keep the process running between tool calls; consume its JSON progress and terminal result instead of rebuilding a polling loop. Continue inspecting actionable PR feedback while it runs. To change the default 30-minute window without check or merge progress, pass `--timeout SECONDS`.

## Monitor CI and verify the merge

The watcher exits with check names and links on failure, or a specific blocker for a changed head, draft, closure, conflict, timeout, or API error. Stop the watcher before making repairs or addressing actionable feedback; disable any existing auto-merge while repairing. Make the smallest correct fix, run relevant checks, commit, and repeat fresh-context local review before pushing. Reply to PR feedback with the fix and validation when applicable. Restart the watcher with the new reviewed SHA and the original start timestamp. Apply the same review cycle after conflict resolution or an unexpected head change.

Stop and report the blocker if credentials or permissions are missing, feedback requires a product decision or scope expansion, or the same failure persists after three repair attempts. On timeout, leave the PR open and report pending checks and whether a merge was already requested (a queue request may remain active). Never turn a timeout or missing result into approval.

Verify the PR actually merged before claiming success; enabling auto-merge or entering a merge queue is not completion. Report its URL, merge commit, and a brief summary of local review and validation. If blocked, report the PR URL, completed work, and the specific next action needed. Leave branch deletion and other cleanup to repository policy or an explicit user request.

After verifying the merge, calculate total wall-clock time as the PR's actual merge timestamp (`mergedAt`) minus `ship_started_at`, including review, fixes, CI, and queue waits. Use the merge timestamp rather than the time polling detected it. Include the duration in the final output, for example: `Time from ship-it request to merge into main: 8m 42s` (use the actual base branch name). If either timestamp is unavailable, report timing as unavailable rather than inventing a duration.
