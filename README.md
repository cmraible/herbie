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
