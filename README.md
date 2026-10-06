# Herbie

A pnpm workspace with two packages:

- **`@herbie/loop`** (`packages/loop`): runs one foreground Codex improvement attempt for a local repository and goal.
- **`@herbie/demo`** (`packages/demo`): the local ChatGPT sign-in and streaming demo. See its [README](packages/demo/README.md).

## Getting started

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

The internal app-server helpers are not wired into the CLI. After building, one
complete attempt can be called with:

```js
import { runCodexAttempt } from './packages/loop/dist/codex-process.js';

const controller = new AbortController();
await runCodexAttempt('codex', ['app-server'], {
  cwd: '/path/to/checkout',
  goal: 'Fix the failing addition test',
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
