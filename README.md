# Herbie

Herbie runs ongoing coding goals through a durable service. The React web UI and
CLI use the same authenticated API; a separate worker continues after either client
exits. Postgres owns goals, attempts, jobs, captured artifacts, PRs and events.

## Service, web UI and CLI

Run **`pnpm verify`** for all CI validation locally, including PostgreSQL,
browser, CLI and production container checks. Docker provisions the test tools
and disposable databases. After the initial tool/image downloads, runs target
under two minutes. See [local CI requirements and logs](docs/github-actions.md).

Requires Node.js 24+, pnpm 10, and Postgres 17 (Docker is convenient locally).

```sh
pnpm install
cp .env.example .env
docker compose up -d postgres
pnpm build
pnpm service   # terminal 1: API + built React UI at http://127.0.0.1:8787
pnpm worker    # terminal 2: separate durable worker
```

Open http://127.0.0.1:8787 and choose **Enter local demo**. Demo mode is explicit,
loopback-only, and deterministic: it calls no model, Daytona, GitHub, or host Git.
Its simulated PRs use `demo.invalid`, and its artifacts cannot pass the live
publisher. The UI can simulate a failure, merge, or unmerged close.

Use another terminal for the same service:

```sh
pnpm cli login --url http://127.0.0.1:8787 --demo
pnpm cli repositories
pnpm cli start --repo demo/example --name "Fix addition" --prompt "Fix addition and test the change" --max-wip 1
pnpm cli status
pnpm cli status GOAL_ID
pnpm cli rename GOAL_ID --name "Improve arithmetic"
pnpm cli edit GOAL_ID --prompt "Also cover subtraction with regression tests"
pnpm cli logs GOAL_ID
pnpm cli pause GOAL_ID
pnpm cli resume GOAL_ID
pnpm cli cancel GOAL_ID
```

`maxWip` defaults to 1 and limits each goal's outstanding work: open PRs plus
any queued or running attempt. Attempts run sequentially, filling available
capacity without waiting for merges. Each merge frees capacity for the next
attempt. For example, `--max-wip 2` keeps up to two PRs outstanding until the
goal is paused, cancelled, or stopped by a failure or an unmerged close.
The goal view lists every published PR. Use **Edit goal** to update its name,
prompt, and maximum work in progress together. Prompt changes apply to future
attempts; lowering the limit keeps existing work and delays new attempts until
capacity is available. The repository stays fixed for the life of the goal.

CLI responses are JSON. Login stores only a Herbie bearer session in a private
0600 file (`HERBIE_CONFIG` or `~/.config/herbie/session.json`). For an interrupted
start, repeat the same input with the request ID printed to stderr using
`--request-id UUID`; the service returns the original goal. The browser retains
its request ID for retries too. `pnpm cli logout` revokes the session.

See [service operations and live setup](docs/service.md) for recovery behavior,
testing, security boundaries, and the precise one-time GitHub App/Daytona setup.
No live execution or public deployment is enabled by the demo configuration.

Environment configuration is validated together by the Zod schema in
`packages/service/src/config.ts` before connecting to PostgreSQL. Errors name the
variables that need fixing without displaying their values. Live mode requires
`OPENAI_API_KEY`, including when execution is disabled. Automatic naming must succeed
before a goal is queued; provider errors and invalid responses fail the request
without saving a goal or job. Demo naming is deterministic and makes no model calls.
Live execution also
requires `DAYTONA_API_KEY` and `HERBIE_DAYTONA_OPENAI_SECRET` at this stage.

With `pnpm service`, `NODE_ENV` defaults to `development`. Invalid configuration
serves a detailed error page on the service's loopback address (normally
http://127.0.0.1:8787), returning HTTP 503 even for health checks. An invalid port
falls back to 8787 for this diagnostic page. Correct `.env` or the shell environment,
then restart the service and reload. `NODE_ENV=production` exits with status 1
instead of starting a diagnostic server. The hosted entrypoint and standalone
worker always exit on invalid configuration.

The [portable deployment runbook](docs/portable-deployment.md) describes the
Node container, private Supabase database, and automatic GHCR → Flux OCI → k3s delivery.
Production releases use [GitHub Actions](docs/github-actions.md), with verification,
environment approval and disabled execution until separately approved.

## Earlier local experiments

The workspace retains the original foreground experiments:

- **`@herbie/loop`** (`packages/loop`): runs one foreground Codex improvement attempt for a local repository and goal.
- **`@herbie/demo`** (`packages/demo`): the local ChatGPT sign-in and streaming demo. See its [README](packages/demo/README.md).

### Foreground experiment setup

Requires Node.js 24+ and pnpm.

```sh
pnpm install
pnpm start --repo /path/to/checkout --goal "Improve error messages"
pnpm demo    # Run the web demo at http://127.0.0.1:3210
```

The CLI requires `codex` on PATH, already configured and authenticated. It asks Codex
for one small change and proportionate tests, streams its output, and exits. It uses
Codex's `workspace-write` sandbox without approval-bypass flags. Changes stay local;
there is no PR publication, persistence, or automatic repetition.
The command preserves Codex's exit code and exits nonzero if it cannot start or is
terminated by a signal. Use `pnpm start --help` for usage.

Press Ctrl+C to stop either process. Demo credentials remain in `.herbie/` at the workspace root.

## Development

```sh
pnpm typecheck
pnpm test
pnpm build
```

These commands run across the workspace. To target one package, use `pnpm --filter @herbie/demo test` or `pnpm --filter @herbie/loop build`.

Run `pnpm lint` and `pnpm format:check` to check the repo with Oxlint and Oxfmt.
Use `pnpm lint:fix` and `pnpm format` to apply fixes and formatting. Both tools use their default configurations.
CI checks lint and formatting. `pnpm install` installs a pre-commit hook that formats
staged files with Oxfmt, preserving unstaged changes through lint-staged.

The internal app-server helpers are not wired into the CLI. After building, one
complete attempt can be called with:

```js
import { runCodexAttempt } from "./packages/loop/dist/codex-process.js";

const controller = new AbortController();
await runCodexAttempt("codex", ["app-server"], {
  cwd: "/path/to/checkout",
  goal: "Fix the failing addition test",
  signal: controller.signal, // optional AbortController owned by the caller
});
```

This starts Codex in the checkout, initializes it, creates one ephemeral thread,
runs the goal, waits for terminal completion, and cleans up its process group.
It resolves only after successful completion and cleanup; either failure rejects.
`timeoutMs` bounds each initialization/thread-start phase (default ten seconds),
`turnTimeoutMs` bounds the turn (default sixty seconds), and `interruptTimeoutMs`
bounds cancellation confirmation (default five seconds). Abort during a turn uses
the interrupt handshake before process cleanup. This does not run repository tests,
publish changes, or provision a sandbox; launching real Codex consumes quota.

`runCodexTurn` accepts
`{ timeoutMs, signal, interruptTimeoutMs }` as its fifth argument. Timeout or abort
requests `turn/interrupt` once the start response supplies a turn ID, then waits up
to `interruptTimeoutMs` (default five seconds) for the matching terminal event.
An interrupt acknowledgement alone is insufficient. Cancellation always rejects;
failure to observe termination also reports `Codex turn termination unconfirmed`.
Transport/protocol failures still require owner cleanup. A terminal turn event
does not prove descendant processes have exited.

`initializeCodexProcess(command, args, options)` owns its spawn on Linux/macOS:
it creates a [new process group](https://nodejs.org/api/child_process.html#optionsdetached)
without a shell, closes stdin, then escalates to group `SIGTERM` and `SIGKILL`.
Each shutdown stage waits up to `shutdownMs` (default one second). Success requires
both the direct child's streams to close and the group to disappear, even if the
parent exits first. A failed probe or deadline reports unconfirmed cleanup.
Descendants remaining in that group are covered; descendants that call `setsid`
or change groups, remote work, and termination of Herbie itself are not. Unreaped
zombies can keep group cleanup unconfirmed. Windows is rejected before spawning.
The eventual disposable Daytona sandbox needs confirmed deletion as the stronger
boundary for escaped descendants. `initializeCodexProcess` remains an initialization
probe; `runCodexAttempt` adds the thread and goal using the same process owner.

### Opt-in real Codex smoke test

On Linux or macOS, with dependencies installed and `git`, `pnpm`, and an authenticated
`codex` on PATH, run:

```sh
codex login status
pnpm test:e2e
```

This launches **real Codex and consumes your quota**. It is excluded from `pnpm test`
and CI; its TypeScript is checked by `pnpm typecheck`. It does not change authentication
or Codex sandbox settings and does not retry a failed run.

The test creates a temporary local Git repository with no remote, commits an arithmetic
bug and two tests, and confirms both tests fail. It runs `pnpm start --repo … --goal …`,
then independently requires exit 0, both tests passing, byte-for-byte unchanged tests,
unchanged HEAD, and only the expected one-line subtraction-to-addition edit. Extra
tracked, untracked, or ignored files also fail verification.

The real CLI has a 10-minute timeout. On timeout or Ctrl+C, the test kills its separate
process group so the launched processes cannot keep editing the fixture. Setup and
verification commands have 30-second limits. Failed runs retain their temporary
directory, printed on startup and failure, with the fixture, test output, CLI log,
invocation, and available exit/diff evidence. Logs may contain account metadata;
inspect them before sharing. Successful runs remove only their own temporary directory.

After building:

```sh
node packages/loop/dist/index.js --repo /path/to/checkout --goal "Improve error messages"
node packages/demo/dist/index.js
```

### Opt-in Daytona lifecycle smoke

`pnpm test:daytona` creates a real, billable Daytona sandbox, runs a fixed `printf`
probe, and waits for deletion. Run it only after approving the spend and configuring
`DAYTONA_API_KEY` in the host environment with sandbox create/execute/delete access.
The SDK also honors its standard `DAYTONA_API_URL` and `DAYTONA_TARGET` settings.
No host environment or secrets are passed into the sandbox; no OpenAI key is needed.
This does not clone a repository or run Codex.

The pinned `@daytona/sdk` 0.220.0 supports the options used here. We request
`ubuntu:22.04` with the documented minimum 1 vCPU, 1 GiB RAM, and 1 GiB disk,
block sandbox network access, and set a five-minute server-side TTL. Explicit
resource sizing uses image-based creation; Daytona may build/cache an image snapshot.
This smoke deletes its sandbox, not provider-managed image caches. Capacity, image
availability, and fit within the minimum disk remain subject to a live check.
See the [resource limits](https://www.daytona.io/docs/en/sandboxes/#resources) and
[SDK lifecycle options](https://www.daytona.io/docs/en/typescript-sdk/daytona/).

Creation has a 120-second timeout; the command has a 10-second server-side timeout;
deletion waits up to 60 seconds for destruction. Other HTTP requests have a 30-second
client timeout. After obtaining a sandbox, cleanup runs even when the command fails.
Command and cleanup errors are both preserved; deletion failure makes the smoke fail.
The console prints the unique name before creation, then the sandbox ID and safe
phase results. It does not dump SDK errors or credentials.

A create timeout can leave a sandbox without returning its handle: cleanup is then
**unconfirmed**. There are no automatic retries. Check the printed name/ID in Daytona
before retrying. Client timeouts do not cancel remote operations, and process termination
can prevent cleanup; the TTL is a fallback, not confirmation of immediate deletion.
Capture console output if you need a record. This command is excluded from default
tests and CI, but typechecked. `pnpm test` runs its mocked lifecycle and error-output tests without
credentials, provisioning, or charges.

### Callable Daytona goal attempt (not run by default tests)

After `pnpm build`, `runDaytonaAttempt` in
`packages/loop/dist/daytona-attempt.js` connects the repo and goal flow to Daytona:

```js
import { runDaytonaAttempt } from "./packages/loop/dist/daytona-attempt.js";

// daytona is an already configured SDK client with requestTimeoutMs: 30_000.
const changes = await runDaytonaAttempt(
  (params, options) => daytona.create(params, options),
  {
    // snapshot: 'approved-ubuntu-runtime', // optional; otherwise prepares Ubuntu 22.04
    repoUrl: "https://github.com/your-org/test-repo.git",
    // commit: 'full commit SHA', // optional; otherwise clones the default branch
    goal: "Fix the failing addition test",
    // Default organization networking is inherited; no network override is required.
    secrets: { OPENAI_API_KEY: "existing-organization-secret-name" },
    // outboundProxyUrl: 'http://approved-proxy:8080',
  },
  console.log,
);
// changes.baseCommit is the cloned HEAD; changes.patch is a Buffer to apply there.
// Persist this returned artifact in the caller for PR publication.
```

Without a snapshot, the adapter creates Ubuntu 22.04 with 1 CPU, 1 GiB RAM, and
3 GiB disk, then installs Git, Node 24.19.0, Python 3.15.0 with pip, and Codex 0.159.2
inside that disposable sandbox. Archive digests are verified before extraction. This reuses
the runtime pins from the successful compatibility probe; it does not build a custom
reusable snapshot or install repository dependencies. An optional snapshot must be
a root-accessible Ubuntu-compatible runtime with Node 24+, Python 3 with pip, Git,
Codex and `runuser`. Python must permit user installs (standalone Python or a
writable virtual environment); externally managed system Python is rejected during preflight.
The adapter runs Codex as the unprivileged `compat` user. Its user tool directory
(`~/.local/bin`) follows system directories on `PATH`, so the agent can install optional tools with
`python3 -m pip install --user lizard` in the default runtime; omit `--user` for
a writable virtual-environment snapshot. Lizard is not preinstalled.

It inherits Daytona's organization network policy by default. `domainAllowList` is
optional and should only be supplied if the organization's policy permits it. Setup
needs the Ubuntu package repositories, nodejs.org, registry.npmjs.org, and GitHub
release downloads (`github.com` and `release-assets.githubusercontent.com`);
Python package installation needs pypi.org and files.pythonhosted.org. The goal
needs the public Git repository and api.openai.com. A blocked setup fails and deletes
the sandbox rather than changing network policy.

Keys must not be baked into a snapshot or runner. The pinned SDK's
[`secrets` and `outboundProxyUrl` fields](https://www.daytona.io/docs/en/typescript-sdk/daytona/)
reference existing organization Secrets and the approved proxy setup. The dedicated
`daytona_openai` provider uses `OPENAI_API_KEY` supplied by Daytona, the Responses
API, and HTTP streaming without WebSockets or retries. Herbie sends only secret names,
never host credentials. The sandbox child preserves the API placeholder and proxy/CA
environment variables; it does not inherit arbitrary Codex authentication overrides.

Only the disposable Daytona runner requests `externalSandbox` with restricted network
access and no interactive approvals; Daytona supplies the isolation boundary. Normal
host attempts retain server-owned sandbox and approval settings. The fixed model is
`gpt-6-luna`, low effort, default service tier, with web search disabled and a 32K
configured context window. Token-usage notifications do not trigger spending-based
cancellation. Herbie does not impose a dollar spending cap. Attempt counts and the
20-minute turn deadline still bound execution. Cancellation waits at most five
seconds for a matching terminal event, then the existing owned-process-group
cleanup runs; unconfirmed termination remains a failure. There is no model
fallback or retry.

Creation is bounded at 120 seconds; each upload at 30 seconds; fresh runtime setup at
240 seconds (snapshot configuration at 30); the turn at 20 minutes; each patch-extraction
Git command and artifact download at 30 seconds; sandbox goal execution at 22 minutes;
and confirmed deletion at 60 seconds. Other SDK requests, including clone, use the
caller's client timeout. A 35-minute sandbox TTL is a fallback. As in the lifecycle
smoke, ambiguous creation is reported by its unique name without retries; a handle
is required for explicit deletion. Failed deletion rejects even after a successful
goal. Reported phase messages omit command output and SDK details; inspect error
causes privately rather than dumping them into logs.

On success, the adapter returns `{ baseCommit, patch }` after confirmed deletion.
The runner records HEAD before Codex runs, then stages the final checkout and creates
a binary-capable Git patch against that original commit. This includes Codex commits,
tracked edits/deletions, file modes, and new non-ignored files; no changes yields an
empty patch. `patch` is a Buffer: base64 transport preserves binary and non-UTF-8 patch
bytes. Streaming downloads stop at a bounded JSON envelope before parsing; the
decoded patch must be at most 8 MiB. The artifact is downloaded into host memory
before deletion. If deletion
fails, the adapter still rejects and exposes the retrieved artifact on
`DaytonaAttemptError.changes`. The caller owns durable storage of returned/recovered
artifacts. Goal, extraction, change-artifact download, or malformed-artifact failures
reject and still attempt deletion; they do not provide a partial patch.

Herbie does not run a separate validation command after the agent finishes.
The agent can install dependencies and run tests in its own checkout. Repository
CI validates the draft PR; reviewers should check its results before merging.
After goal completion and confirmed sandbox deletion, the host attaches
`verification` evidence binding the repository URL, base commit and SHA-256 of
the patch bytes to that attempt. Version 3 records completion and cleanup, not a
test result. Saved version 2 evidence remains eligible for publication; artifacts
without a supported version or from failed attempts do not.

This preserves the final repository file state, not commit history or ignored files;
submodule working-tree contents are not bundled. No live sandbox/model call has been made to validate
this path. One live smoke needs an
existing scoped Secret/proxy references compatible with the configured OpenAI provider,
an approved public repo/commit and goal, and explicit authorization for sandbox and
model spend. Creating/configuring account prerequisites needs separate authorization;
the adapter does not provision secrets or change account settings.

### Callable patch publisher

After building, the host can publish a successfully completed attempt using
`publishPatch`. It is not wired into the CLI. Git authentication and the GitHub
API client must already be configured on the host; neither is sent to the Codex
sandbox. The caller supplies a narrow `createPullRequest` adapter for that client:

```js
import { publishPatch } from "./packages/loop/dist/publish-patch.js";

// changes is the successful return from runDaytonaAttempt.
// github is an existing authenticated client; this example uses Octokit's shape.
const published = await publishPatch(
  async ({ repository, ...pull }) => {
    const [owner, repo] = repository.split("/");
    const { data } = await github.rest.pulls.create({ owner, repo, ...pull });
    return { url: data.html_url };
  },
  {
    repository: "your-org/test-repo",
    baseBranch: "main",
    branch: "herbie/fix-addition-001", // caller-owned, stable, new branch name
    title: "Fix addition",
    body: "Review the changes and repository CI results before merging.",
    changes,
  },
);
console.log(published.url); // also returns branch and commit
```

The publisher rejects empty patches, missing or mismatched completion/cleanup
evidence, an existing publication branch, or a base commit outside the current
default branch history. It copies the captured bytes, initializes a temporary bare
Git repository, fetches the base, applies the patch to an isolated index, and creates
one commit with `commit-tree`. There is no checkout, repository-code execution, or
dependency installation on the host. The existing host Git identity is used. A
create-only push lease prevents replacing a branch, including concurrent creation;
only a confirmed new branch proceeds to one draft-PR request. Each Git command has
a 30-second timeout. The supplied GitHub client owns its request timeout.

`PatchPublicationError.publication` records the repository, branch, available commit
and URL, and the stage reached. `preparing` means no push was attempted; `pushing`
means remote branch state may be uncertain; `opening-pr` means the branch was pushed
but the PR may or may not have been created. `published` with an error means the PR
URL was received but local cleanup failed. Temporary local files are removed on all
paths; published branches are never deleted as rollback. There are no automatic
retries. After a partial failure, inspect the recorded branch and its PRs before
acting; retrying the same branch is rejected instead of creating a blind duplicate.

Use the host-issued evidence from the completed attempt, not hand-built success
flags. It binds the supplied artifact to that attempt; it does not certify that
tests passed or replace repository CI and review. Durable
storage, CLI orchestration, and live end-to-end validation remain later work. Unit
tests use only temporary Git repositories and mocked GitHub calls.

Before live Git publication on a new host, the operator must supply an existing
noninteractive Git credential helper/SSH setup authorized to push to the target repository,
and Git author/committer identity (which may be per-process rather than global).
The separate GitHub API callback needs permission to create draft PRs. A connected
GitHub app alone does not configure native Git push authentication. The target public
test repository and base branch must already exist. Herbie does not create these
credentials, change Git settings, or create a target repository. Fixture tests cover
publication locally; a live attempt followed by native Git push remains unvalidated.
