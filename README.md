# Herbie

`GET /api/version` returns JSON with the running `version` and `commitSha` without
authentication. The SHA comes from deployment metadata, falling back to the local
Git checkout; it is `null` when neither is available.

Herbie runs ongoing coding projects through a durable service. The React web UI and
CLI use the same authenticated API; a separate worker continues after either client
exits. Postgres owns projects, attempts, jobs, captured artifacts, PRs and events.

## Service, web UI and CLI

Follow the [setup guide](docs/setup.md) to configure credentials and run Herbie
locally with Docker Compose.

Run **`pnpm verify`** for local validation, including PostgreSQL, browser, CLI
and image-promotion checks. Production image builds and smoke tests run in CI.
Docker provisions the test tools and disposable databases. After the initial
tool/image downloads, runs target under two minutes. See
[local CI requirements and logs](docs/github-actions.md).

For UI design work, run `pnpm --filter @herbie/web preview:ui` and open
http://127.0.0.1:5173. This uses realistic local data fixtures with the production
UI, without a database, worker, GitHub authentication, or model calls. Fixture
edits last until the dev server restarts. PR links are illustrative fixture URLs;
they do not refer to PRs created by Herbie. Fixture middleware runs only in Vite's
`fixtures` development mode and is not included in production builds.

Run Herbie locally with Docker Compose. Docker builds the current checkout and
runs the web UI, API, worker, and Postgres together. Configure your test GitHub
App, Daytona, OpenAI, and HTTPS hostname using the [setup guide](docs/setup.md).

```sh
cp .env.example .env
# Fill the credentials in .env.
docker compose up --build -d --wait
```

Open the configured HTTPS hostname and sign in with GitHub. Execution defaults to
disabled; set `HERBIE_EXECUTION_ENABLED=true` and rerun Compose when ready to run
a real project.

The optional CLI client requires Node.js 24+ and pnpm 10:

```sh
pnpm install
pnpm cli login --url https://herbie-dev.example.com
pnpm cli repositories
pnpm cli pr --repo YOUR-OWNER/YOUR-TEST-REPO --prompt "Fix addition and test the change"
pnpm cli start --repo YOUR-OWNER/YOUR-TEST-REPO --name "Fix addition" --prompt "Fix addition and test the change" --target-wip 1
pnpm cli status
pnpm cli status PROJECT_ID
pnpm cli rename PROJECT_ID --name "Improve arithmetic"
pnpm cli edit PROJECT_ID --prompt "Also cover subtraction with regression tests"
pnpm cli logs PROJECT_ID
pnpm cli pause PROJECT_ID
pnpm cli resume PROJECT_ID
pnpm cli cancel PROJECT_ID
```

For an ad-hoc ticket or task, use `herbie pr --repo OWNER/REPO --prompt "Describe the ticket"`
(or `pnpm cli pr ...` from this checkout). In the web UI, choose **New project →
Workflow → Single PR**. Both create a durable one-shot workflow using the existing
loop execution and publication machinery. It produces one PR, keeps supporting CI
repairs and review feedback on that PR, and finishes when the PR is merged or
closed. It never replenishes work. Failed runs can be explicitly retried before
a PR is published; publication recovery reuses the same saved work and branch.
Use the existing status, logs, pause, resume, and cancel commands with the returned
project ID. `--request-id` also safely retries a `pr` submission. Single PR workflows
have a fixed WIP of 1 and cannot be converted to recurring projects.

`herbie start` and the web UI's **Recurring project** workflow retain their existing
behavior. `targetWip` defaults to 1 and sets the desired amount of outstanding work: open PRs
plus queued or active runs. The coordinator polls for missing work and starts runs
to restore the target, including after a PR merges. For example, `--target-wip 2` maintains two open PRs or active runs until the
project is paused, cancelled, or stopped by a failure or an unmerged close.
The project view lists every published PR. Use **Edit project** to update its name,
prompt, and target work in progress together. Prompt changes apply to future
attempts; lowering the target keeps existing work and delays new attempts until
capacity is available. The repository stays fixed for the life of the project.

CLI responses are JSON. Login stores only a Herbie bearer session in a private
0600 file (`HERBIE_CONFIG` or `~/.config/herbie/session.json`). For an interrupted
start, repeat the same input with the request ID printed to stderr using
`--request-id UUID`; the service returns the original project. The browser retains
its request ID for retries too. `pnpm cli logout` revokes the session.

See [service operations and live setup](docs/service.md) for recovery behavior,
testing, security boundaries, and the precise one-time GitHub App/Daytona setup.
Local Compose uses real integrations; execution stays disabled until you enable it.

Environment configuration is validated together by the Zod schema in
`packages/service/src/config.ts` before connecting to PostgreSQL. Errors name the
variables that need fixing without displaying their values. Live mode requires
`OPENAI_API_KEY`, including when execution is disabled. Automatic naming must succeed
before a project is queued; provider errors and invalid responses fail the request
without saving a project or job. Live execution requires `DAYTONA_API_KEY` and
`HERBIE_DAYTONA_OPENAI_SECRET` when enabled.

The Compose container exits on invalid configuration. Check `docker compose logs
herbie`, correct `.env`, and rerun `docker compose up -d --wait`.

The [portable deployment runbook](docs/portable-deployment.md) describes the
Node container, private Supabase database, and automatic GHCR → Flux OCI → k3s delivery.
Production releases use [GitHub Actions](docs/github-actions.md), with verification,
environment approval and disabled execution until separately approved.

## Native iOS client

The initial SwiftUI iPhone/iPad client lives in [apps/ios](apps/ios/README.md).
Open `apps/ios/Herbie.xcodeproj` in Xcode to run it against an existing HTTPS service,
or use its offline Debug preview. The iOS README tracks coverage and remaining
parity/validation work.

## Earlier local experiments

The workspace retains the original foreground experiments:

- **`@herbie/loop`** (`packages/loop`): runs one foreground Codex improvement attempt for a local repository and project.
- **`@herbie/demo`** (`packages/demo`): the local ChatGPT sign-in and streaming demo. See its [README](packages/demo/README.md).

### Foreground experiment setup

Requires Node.js 24+ and pnpm.

```sh
pnpm install
pnpm start --repo /path/to/checkout --project "Improve error messages"
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
  project: "Fix the failing addition test",
  signal: controller.signal, // optional AbortController owned by the caller
});
```

This starts Codex in the checkout, initializes it, creates one ephemeral thread,
runs the project, waits for terminal completion, and cleans up its process group.
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
probe; `runCodexAttempt` adds the thread and project using the same process owner.

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
bug and two tests, and confirms both tests fail. It runs `pnpm start --repo … --project …`,
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
node packages/loop/dist/index.js --repo /path/to/checkout --project "Improve error messages"
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
`ubuntu:24.04` with the documented minimum 1 vCPU, 1 GiB RAM, and 1 GiB disk,
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

### Callable Daytona project attempt (not run by default tests)

After `pnpm build`, `runDaytonaAttempt` in
`packages/loop/dist/daytona-attempt.js` connects the repo and project flow to Daytona:

```js
import { runDaytonaAttempt } from "./packages/loop/dist/daytona-attempt.js";

// daytona is an already configured SDK client with requestTimeoutMs: 30_000.
const changes = await runDaytonaAttempt(
  (params, options) => daytona.create(params, options),
  {
    // snapshot: 'approved-ubuntu-runtime', // optional; otherwise prepares Ubuntu 24.04
    repoUrl: "https://github.com/your-org/test-repo.git",
    // commit: 'full commit SHA', // optional; otherwise clones the default branch
    project: "Fix the failing addition test",
    // Default organization networking is inherited; no network override is required.
    secrets: { OPENAI_API_KEY: "existing-organization-secret-name" },
    // outboundProxyUrl: 'http://approved-proxy:8080',
  },
  console.log,
);
// changes.baseCommit is the cloned HEAD; changes.patch is a Buffer to apply there.
// Persist this returned artifact in the caller for PR publication.
```

Without a snapshot, the adapter creates Ubuntu 24.04 with 2 CPUs, 4 GiB RAM, and
10 GiB disk, then installs Git, Docker Engine/Compose/Buildx, Herbie’s internal Node 24.19.0, and Codex 0.159.2
inside that disposable sandbox. Node and Codex archive digests are verified before
extraction, and Docker packages come from Docker's signed apt repository. Daytona
does not build a reusable project template or install repository dependencies.
An optional snapshot must provide Herbie's internal Node at
`/opt/herbie-tools/node-v24.19.0-linux-x64/bin/node`, its bundled npm/Corepack,
Docker Engine/Compose/Buildx, Git, jq, Codex, and `runuser`.
The adapter runs Codex as the non-root `compat` user. Project tools must be
accessible in `/usr/local/bin`, `/usr/bin`, `/bin`, or `/home/compat/.local/bin`.
Python and other project languages are optional and can be installed through
E2B's cached setup script. Custom image `PATH` and `VIRTUAL_ENV` settings are not
inherited by the agent.

It inherits Daytona's organization network policy by default. `domainAllowList` is
optional and should only be supplied if the organization's policy permits it. Setup
needs the Ubuntu package repositories, download.docker.com, nodejs.org, and registry.npmjs.org;
Python package installation needs pypi.org and files.pythonhosted.org. The project
needs the Git repository and api.openai.com. The live service supports public and private
GitHub repositories using a repository-scoped read token for sandbox checkout; it removes
checkout credentials before the agent starts. A blocked setup fails and deletes
the sandbox rather than changing network policy.

Keys must not be baked into a snapshot or runner. The pinned SDK's
[`secrets` and `outboundProxyUrl` fields](https://www.daytona.io/docs/en/typescript-sdk/daytona/)
reference existing organization Secrets and the approved proxy setup. The dedicated
`daytona_openai` provider uses `OPENAI_API_KEY` supplied by Daytona, the Responses
API, and HTTP streaming without WebSockets or retries. For model authentication, Herbie
sends only secret names, never host credentials. The sandbox child preserves the API placeholder and proxy/CA
environment variables; it does not inherit arbitrary Codex authentication overrides.

Only the disposable Daytona runner requests `externalSandbox` with restricted network
access and no interactive approvals; Daytona supplies the isolation boundary. Normal
host attempts retain server-owned sandbox and approval settings. The fixed model is
the project’s configured model (default `gpt-6-luna`), low effort, default service tier, with web search disabled and a 32K
configured context window. Token-usage notifications do not trigger spending-based
cancellation. Herbie does not impose a dollar spending cap. Attempt counts and the
20-minute turn deadline still bound execution. Cancellation waits at most five
seconds for a matching terminal event, then the existing owned-process-group
cleanup runs; unconfirmed termination remains a failure. There is no model
fallback or retry.

An implementation agent can explicitly finish without a pull request when no repository
change is appropriate. It writes a pause decision and an explanation, leaving the
repository unchanged. After confirmed sandbox cleanup, Herbie saves the result,
completes the run, and pauses the project. The activity feed shows the explanation;
Resume starts a new run. An empty patch without that explicit decision still requires
attention. PR feedback and CI repair keep their existing decision flows.

Creation is bounded at 120 seconds; each upload at 30 seconds; fresh runtime setup at
240 seconds (snapshot configuration at 30); the turn at 20 minutes; each patch-extraction
Git command and artifact download at 30 seconds; sandbox project execution at 22 minutes;
and confirmed deletion at 60 seconds. Other SDK requests, including clone, use the
caller's client timeout. A 35-minute sandbox TTL is a fallback. As in the lifecycle
smoke, ambiguous creation is reported by its unique name without retries; a handle
is required for explicit deletion. Failed deletion rejects even after a successful
project. Reported phase messages omit command output and SDK details; inspect error
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
artifacts. Project, extraction, change-artifact download, or malformed-artifact failures
reject and still attempt deletion; they do not provide a partial patch.

For initial project attempts, the agent installs dependencies and runs tests in its
own checkout; there is no separate validation command. For CI repairs, the runner
requires and executes the agent's verification script after the session exits.
Only successful local verification and confirmed sandbox deletion allow a repair
patch to be pushed to the existing PR. Signed CI webhooks and polling trigger
repairs for tracked PRs, once per head and up to three times per PR; failures stop
further automatic repair. See [setup and recovery](docs/service.md) for the required
GitHub App subscriptions and permissions. Repository CI still validates each push. Once checks pass, Herbie automatically
marks the draft PR ready for review without starting another agent session.
Herbie also processes human PR comments, inline feedback, and submitted reviews.
The agent chooses to ignore the feedback, reply, or push a locally verified update
and reply on the existing PR. Bot comments do not trigger runs; duplicate feedback
is processed once. Feedback processing stops when the project is paused or cancelled.
See [service operations](docs/service.md) for subscriptions and failure recovery.
After project completion and confirmed sandbox deletion, the host attaches
`verification` evidence binding the repository URL, base commit and SHA-256 of
the patch bytes to that attempt. Version 3 records completion and cleanup, not a
test result. Saved version 2 evidence remains eligible for publication; artifacts
without a supported version or from failed attempts do not.

This preserves the final repository file state, not commit history or ignored files;
submodule working-tree contents are not bundled. No live sandbox/model call has been made to validate
this path. One live smoke needs an
existing scoped Secret/proxy references compatible with the configured OpenAI provider,
an approved public repo/commit and project, and explicit authorization for sandbox and
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

### Agent transcripts

Each live run streams the Codex app-server's thread-scoped notifications into
Postgres `project_events` records with type `agent` and the run's `job_id`. The JSON
message is stored without the progress-message truncation limit. The existing
owner-authenticated WebSocket feed replays these records on reconnect. The run
view assembles message deltas, reasoning, and tool activity; **Download transcript**
exports the original notifications as JSONL, including records the UI does not
render individually. Check-repair turns are included in the same run.

The runner appends notifications to a JSONL file in its environment. Durable
sessions stream new bytes through a read-only helper using E2B command streaming
or Daytona session logs. Connections rotate after one minute or approximately
1 MiB to bound buffering and abandoned readers. Reconnection resumes at the last
persisted record's byte offset, including after worker replacement.
Completion is checked every five seconds. Transient observation failures retry
after 1, 2, 4, and 8 seconds; persistent failures detach the observer for worker
recovery without deleting the environment or restarting the agent. Legacy callers
without streaming use five-second transcript polling. Transcripts drain before
cleanup. Output not yet collected can still be lost if the environment itself
fails or reaches its TTL.

Thinking includes only reasoning summaries/text emitted by Codex and the selected
model. The transcript preserves exposed protocol output, not unavailable model
internals. Treat transcript contents as private project data: tool output can
include repository contents and sensitive values. No transcript bodies are sent
to operational logs.

Choose a project’s model from the searchable dropdown in the create/edit form (or enter a custom model ID), with `herbie start --model MODEL`, or with `herbie edit PROJECT_ID --model MODEL`. The default is `gpt-6-luna`. Changes apply to future runs, including feedback and CI repairs.

Model suggestions come from OpenAI using the service’s `OPENAI_API_KEY` and are cached for five minutes. The picker filters known specialized variants and retired models; the API does not expose full coding-tool compatibility metadata. If discovery is unavailable, the saved model and custom entry remain usable.

Project setup scripts can install additional languages and tools during cached E2B
template preparation. See [project setup scripts](docs/environments.md#project-setup-script)
for web/CLI configuration, build behavior, and installation locations.
