# Environment providers and agent sessions

A run owns its branch and pull request. Each actual agent execution creates an agent session: implementation, check repair, or review feedback. Sessions retain their model, reasoning effort, timestamps, environment identity, cleanup outcome, transcript attribution, token usage when reported by Codex, and resulting patches. Run details show each session separately. Historical activity remains available at run level; migration does not guess which session produced it.

Publication retries reuse saved patches and do not create sessions. The existing job, repair, and feedback records continue to own their publication leases and deduplication. An expired execution lease marks its running session interrupted, with cleanup unconfirmed. Session completion describes agent execution, not PR publication or review completion. Private failure details and patches are not exposed in the session summary.

## Configuration

`HERBIE_ENVIRONMENT_PROVIDER` selects `daytona` (default) or `e2b` for new sessions. Existing sessions retain their original provider identity. Changing providers does not replay saved work.

Daytona keeps the existing `DAYTONA_API_KEY`, `HERBIE_DAYTONA_OPENAI_SECRET`, and optional `HERBIE_DAYTONA_SNAPSHOT` configuration.

E2B requires:

- `E2B_API_KEY`
- `HERBIE_E2B_TEMPLATE`: a prebuilt Herbie runtime template
- `HERBIE_E2B_OPENAI_SECRET`: the name of an existing E2B secret containing the OpenAI API key

Both providers inject model credentials through their egress proxy. The real model key is not placed in guest files or environment variables. E2B public ingress is disabled; outbound access remains available for repository dependencies, as in the default Daytona configuration.

The live service checks out public and private GitHub repositories with a short-lived, repository-scoped read token. The shared checkout helper removes its root-only credential file before cloning, passes authentication through the Git process environment, and drops it before populating the worktree. No GitHub token is available to the agent. All remote branch refs are cloned initially; later authenticated fetches, private submodules, and private dependency downloads are not configured automatically.

Build the E2B template explicitly, with `E2B_API_KEY` configured:

```sh
pnpm --filter @herbie/loop build:e2b-template herbie-runtime
```

This provisions a paid remote template. It installs the same pinned Ubuntu toolchain used by Daytona, including Node, Codex, Python, and Docker. Session startup configures the non-root agent user and checks Docker, Compose, Buildx, and the toolchain before starting the agent. A failed preflight cleans up the environment and prevents publication. E2B sizing comes from the template; custom project resource overrides are rejected. Remove such overrides before using E2B.

The adapter targets E2B SDK 2.56.0, including its network secret transforms. A live E2B smoke run is needed to validate the chosen account, secret, template, and Docker support before production rollout. Local tests simulate the SDK; they do not certify remote provisioning.

## Extending providers

`packages/loop/src/environment.ts` defines the interface. A provider creates an environment that prepares its runtime, runs commands, transfers files, checks out a repository, and confirms destruction. The shared `agent-attempt.ts` owns transcript collection, bounded artifact reads, cancellation, cleanup retries, and publication evidence. Keep provider options inside adapters. Never issue publication evidence before cleanup succeeds.

E2B SDK references: [Sandbox](https://e2b.dev/docs/sdk-reference/js-sdk/v2.6.2/sandbox), [current SDK source](https://github.com/e2b-dev/E2B/tree/main/packages/js-sdk/src).
