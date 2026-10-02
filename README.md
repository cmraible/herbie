# Herbie

A pnpm workspace with two packages:

- **`@herbie/loop`** (`packages/loop`): the [one-shot improvement CLI](packages/loop/README.md), opening one bounded draft PR.
- **`@herbie/demo`** (`packages/demo`): the local ChatGPT sign-in and streaming demo. See its [README](packages/demo/README.md).

## Getting started

Requires Node.js 24+ and pnpm.

```sh
pnpm install
pnpm start /absolute/path/to/repo "One improvement goal"
pnpm demo    # Run the web demo at http://127.0.0.1:3210
```

The CLI exits after one draft; press Ctrl+C to stop the demo. Demo credentials remain in `.herbie/` at the workspace root.

## Development

```sh
pnpm typecheck
pnpm test
pnpm build
```

These commands run across the workspace. To target one package, use `pnpm --filter @herbie/demo test` or `pnpm --filter @herbie/loop build`.

After building:

```sh
node packages/loop/dist/index.js /absolute/path/to/repo "One improvement goal"
node packages/demo/dist/index.js
```
