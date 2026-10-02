# One repository, one goal, one draft

First slice: a one-shot CLI using your existing authenticated `codex` and `gh`.
Run locally or in an SSH shell. No service or provider setup.

```sh
pnpm install
pnpm --filter @herbie/loop start /absolute/path/to/target-repo "Improve error messages"
# or, after pnpm build:
node packages/loop/dist/index.js /absolute/path/to/target-repo "Improve error messages"
```

Use a **trusted repository**, a clean checkout matching current `origin/main`,
and a GitHub `origin` (HTTPS or SSH). Git commit identity must already be configured.
The target may differ from this repository. Only one process/checkout installation
should manage a target repository; a local lock cannot coordinate separate hosts/clones.

## Tiny use cases

| Situation | Behavior |
| --- | --- |
| Clean current main, no open PR | Propose one problem; validate a tiny patch; push a new branch; create a draft |
| Dirty/stale checkout, open PR, malformed/large patch | Stop; preserve checkout and recovery state |
| Concurrent process or interrupted run | Durable claim prevents another generation/publication |
| Restart with exactly one matching PR | Report OPEN/CLOSED/MERGED; no new work |
| PR creation might have succeeded but response was lost | Look up saved branch; never blindly retry creation |
| Closed without merging | Remain paused |
| Human merged | Report merge; advancing is a future increment |

## What the script does

`src/index.ts` is the whole controller. Zod validates CLI output and saved state.
Codex runs a fresh, ephemeral, read-only session with user config ignored and shell
environment inheritance disabled. Existing Codex authentication is retained.
Its structured response is a problem description and a Git patch, not shell commands.
The controller applies that patch to an alternate Git index and permits only
modifications to existing regular `.ts`, `.js`, `.md`, or `.txt` files: at most
3 files and 120 added/deleted lines. Hidden, credential, configuration and agent
instruction paths are rejected. No new files, deletions, renames or mode changes.
Git creates the commit directly from that index; the checkout stays unchanged.
The draft explicitly says generated code has **not been executed or tested**.

This deliberately narrow proof of concept cannot mechanically prove a patch solves
one problem or contains no sensitive text. Human review is required. Use trusted
repository contents; the Codex sandbox is not a general secret isolation boundary.
No review comments or CI logs are consumed yet, so they cannot supply commands or
expand scope. No merge or auto-merge command exists. The controller itself never
executes generated code, repository test scripts or commit hooks.

## Recovery

State lives in `herbie-once/` under `git rev-parse --git-common-dir`, shared across
linked worktrees. The directory is the exclusive durable claim; `state.json` records
the goal, repository, base SHA and unique branch. The proposal, alternate index and
PR body remain available for inspection. Failures intentionally retain the claim.

Rerun the same command to inspect the remote PR by the saved branch, including closed
and merged PRs. Missing/corrupt state or ambiguous/missing PR results stop safely.
To recover manually, first ensure no Herbie/Codex process is running, inspect the
saved state and local/remote branch, and check GitHub for that branch in **all** PR
states. A pushed branch without a PR may be published manually after review; a PR
that already exists must be reused. Do not remove the claim while publication is
uncertain, while a PR is open, or after a closed-unmerged PR. There is intentionally
no automatic reset or next-iteration command in this slice.

CLI interfaces inspected: Codex `0.159.0-alpha.3` (`exec --help`) and gh `2.46.0`
(`pr create/list --help`). Older Codex versions may not support these flags and will
fail closed. No live Codex improvement run is part of the tests.

## Next increment

Add one explicit `reconcile` tick: check the same PR's head, review comments and CI,
accept only bounded feedback relevant to the saved goal, and update that same branch.
Treat review text/logs as untrusted data, never commands or new authority. Then a
small watch loop can repeat ticks, pause on closed-unmerged, and allow the next tiny
improvement only after a verified human merge. Add these behaviors one test at a time.
