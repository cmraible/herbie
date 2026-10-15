---
name: shipit
description: Ship current local changes through a pull request, CI, code review, feedback fixes, and merge. Use when the user asks to ship changes end to end; a request only to open or review a PR does not authorize merging.
---

# Ship it

Carry the current work through to a verified merge. A user request to run `$shipit` authorizes committing, pushing, creating or updating the PR, replying to review feedback, making scoped fixes, and merging once the gates below pass. Preserve any narrower user constraints. Automatic skill selection alone does not grant that authorization.

## Prepare the PR

1. Read applicable repository instructions. Inspect staged, unstaged, and untracked changes, branch commits, remotes, and any existing PR. Establish the intended base branch and the full diff being shipped. If there is no diff to ship and no open PR to continue, report that and stop. Preserve concurrent or unrelated work; ask only when scope or target is genuinely ambiguous.
2. Run the repository's relevant local checks and fix failures caused by the change. If on the base branch or detached HEAD, create and switch to a feature branch using repository conventions before committing. Commit the intended changes on the feature branch.
3. Push and reuse the branch's open PR, or create one following repository title/body conventions. Mark it ready when prepared so CI and review can run. Attach its URL to the chat when the app supports it.

## Wait, review, and repair

Use the repository's configured CI and review process. Discover how review is requested or triggered and initiate it when needed. If there is no established reviewer or review mechanism, ask the user which to use; do not substitute self-review for completed PR review.

Poll in bounded intervals, keeping the user informed of meaningful progress. Inspect check runs, submitted reviews, inline review threads, and PR comments, including bot feedback. A green check list, an empty comment list, or an old approval does not prove review of the latest changes is complete.

For each actionable finding or CI failure:

- Verify it against the code, make the smallest correct fix, and run relevant checks. Keep unrelated refactors out of the shipping loop.
- Commit and push fixes without asking again. Reply to feedback with the fix and validation; for feedback that does not apply, explain why with evidence. Resolve threads only when addressed and repository practice permits it. A disputed blocking finding needs reviewer agreement or user direction.
- After every push or conflict resolution, wait for CI and review of the new head. Use the configured re-review mechanism when necessary; earlier results cannot certify new changes.

Stop and report the blocker if credentials or permissions are missing, feedback requires a product decision or scope expansion, or the same failure persists after three repair attempts. By default, after 30 minutes with no CI or review progress, leave the PR open and report what is pending; honor a user-specified waiting window. Never turn a timeout or missing result into approval.

## Merge and verify

Immediately before merging, fetch fresh PR state and confirm:

- The remote head matches the commit whose checks and review were inspected.
- Required checks passed, other relevant CI has no unresolved failures, and expected checks have actually appeared and finished. Accept skipped or neutral results only when repository policy permits them.
- The configured review completed for the latest changes, required approvals are present, and actionable feedback is addressed with no outstanding change requests or blocking threads.
- The PR is ready and mergeable into the intended base under repository protections.

Merge using the repository's preferred allowed method, with a head-SHA guard when supported. Respect merge queues and branch protections; do not bypass them with admin overrides. If the head changes, repeat the gates. If merging is queued, wait for actual completion before claiming success.

Verify the PR is merged and report its URL, merge commit, and a brief summary of validation and feedback addressed. If blocked, report the PR URL, completed work, and the specific next action needed. Leave branch deletion and other cleanup to repository policy or an explicit user request.
