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

After building:

```sh
node packages/loop/dist/index.js --repo /path/to/checkout --goal "Improve error messages"
node packages/demo/dist/index.js
```
