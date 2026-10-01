# Herbie

A pnpm workspace with two packages:

- **`@herbie/loop`** (`packages/loop`): the console loop, printing `Hello, world!` immediately and every five minutes.
- **`@herbie/demo`** (`packages/demo`): the local ChatGPT sign-in and streaming demo. See its [README](packages/demo/README.md).

## Getting started

Requires Node.js 24+ and pnpm.

```sh
pnpm install
pnpm start   # Run the console loop
pnpm demo    # Run the web demo at http://127.0.0.1:3210
```

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
node packages/loop/dist/index.js
node packages/demo/dist/index.js
```
