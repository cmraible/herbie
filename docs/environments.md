# Environment providers and agent sessions

A run owns its branch and pull request. Each actual agent execution creates an agent session: implementation, check repair, or review feedback. Sessions retain their model, reasoning effort, timestamps, environment identity, cleanup outcome, transcript attribution, token usage when reported by Codex, and resulting patches. Run details show each session separately. Historical activity remains available at run level; migration does not guess which session produced it.

Publication retries reuse saved patches and do not create sessions. The existing job, repair, and feedback records continue to own their publication leases and deduplication. An expired execution lease marks its running session interrupted, with cleanup unconfirmed. Session completion describes agent execution, not PR publication or review completion. Private failure details and patches are not exposed in the session summary.

## Configuration

`HERBIE_ENVIRONMENT_PROVIDER` selects `daytona` (default) or `e2b` for new sessions. Existing sessions retain their original provider identity. Changing providers does not replay saved work.

Daytona keeps the existing `DAYTONA_API_KEY`, `HERBIE_DAYTONA_OPENAI_SECRET`, and optional `HERBIE_DAYTONA_SNAPSHOT` configuration.

E2B requires:

- `E2B_API_KEY`
- `HERBIE_E2B_OPENAI_SECRET`: the name of an existing E2B secret containing the OpenAI API key

Both providers inject model credentials through their egress proxy. The real model key is not placed in guest files or environment variables. E2B public ingress is disabled; outbound access remains available for repository dependencies, as in the default Daytona configuration.

The live service checks out public and private GitHub repositories with a short-lived, repository-scoped read token. The shared checkout helper removes its root-only credential file before cloning, passes authentication through the Git process environment, and drops it before populating the worktree. No GitHub token is available to the agent. All remote branch refs are cloned initially; later authenticated fetches, private submodules, and private dependency downloads are not configured automatically.

### Automatic E2B templates

Herbie creates templates through E2B's API as part of saving a project. No manually built templates or resource-size mappings are required. Without an existing base, Herbie builds Ubuntu 24.04 with Docker Engine, Compose, Buildx, Git, basic utilities, and Herbie’s internal Node/Codex tools. The API key must permit template lookup/builds as well as sandbox lifecycle operations.

Projects use the same numeric CPU, memory GiB, and disk GiB settings as Daytona. When creating a project or changing its resources or setup script, Herbie starts a background template build if needed and waits for it to finish before saving the project. The form shows “Preparing environment…” and keeps its inputs intact if preparation fails. No project or queued run is created until preparation succeeds. Default sizing is 2 CPU cores, 4 GiB memory, and at least 10 GiB disk. Template names are derived from the runtime recipe, base, size, and setup script, so later projects and runs reuse the built template. Builds for the same environment configuration share work within a service process; after a restart, Herbie looks up E2B's persisted build state and resumes waiting for an existing build. A failed build prevents sandbox creation and can be retried by a later attempt.

Saving a project with a new size can take several minutes and incurs E2B template-build usage. Template preparation has a 15-minute wait budget, with bounded API requests. Leaving the save form does not cancel a shared remote template build. A failed or interrupted save can be retried; E2B retains builds so they can be reused. Runtime cancellation also stops waiting before a sandbox is created. Templates are retained for future runs and are not deleted with disposable session sandboxes.

`HERBIE_E2B_TEMPLATE` is optional. If supplied, it provides the base for automatically generated templates, including the default resource size. Pin or change the base reference when updating a custom runtime. When no base is supplied, changes to Herbie's runtime installation recipe produce a new template identity.

E2B does not expose per-account CPU, memory, and disk bounds through the pinned SDK's API schema, so `/api/environment-limits` returns `null` bounds for E2B. E2B enforces account and build limits when the template is built; Herbie does not report guessed limits.

CPU and memory are set at template build time. E2B's disk-growth option requests minimum free space on a best-effort basis and never shrinks a filesystem, so the project disk setting represents a minimum capacity. Before repository code runs, Herbie verifies CPU and memory exactly and root filesystem capacity against the requested disk minimum. A mismatch fails preparation and triggers sandbox cleanup. Session startup also configures the non-root agent user and checks Docker, Compose, Buildx, and the toolchain.

The standalone build command remains available for operators who want to prepare a base manually:

```sh
pnpm --filter @herbie/loop build:e2b-template herbie-runtime
# Optional: CPU cores, memory GiB, minimum free disk GiB.
pnpm --filter @herbie/loop build:e2b-template herbie-runtime-large 4 8 10
```

The adapter targets E2B SDK 2.56.0, including its network secret transforms. A live E2B smoke run is needed to validate the chosen account, secret, template, and Docker support before production rollout. Local tests simulate the SDK; they do not certify remote provisioning.

## Extending providers

`packages/loop/src/environment.ts` defines the interface. A provider creates an environment that prepares its runtime, runs commands, transfers files, checks out a repository, and confirms destruction. The shared `agent-attempt.ts` owns transcript collection, bounded artifact reads, cancellation, cleanup retries, and publication evidence. Keep provider options inside adapters. Never issue publication evidence before cleanup succeeds.

E2B SDK references: [Sandbox](https://e2b.dev/docs/sdk-reference/js-sdk/v2.6.2/sandbox), [current SDK source](https://github.com/e2b-dev/E2B/tree/main/packages/js-sdk/src).

### Save preparation API

For E2B, creating a project or changing its resources without a matching completed preparation returns HTTP 409 with `code: "environment_preparation_required"`. The shared web/CLI client handles preparation automatically using short requests:

1. `POST /api/project-environments` with `{ repository, resources, setupScript }` for a new project or `{ projectId, resources?, setupScript? }` for an edit. Repository authorization and resource validation run before any build starts.
2. Poll `GET /api/project-environments/:id` for `building`, `ready`, or `failed`.
3. Once ready, repeat the original save with `x-herbie-environment-preparation: <id>`. Creation retains the original idempotency key.

The server binds preparation to the authenticated owner, repository, and exact resource settings and setup script. A failed or mismatched preparation cannot create or update the project. Edits that leave resources and setup unchanged need no new preparation. Preparation receipts expire after 20 minutes and are lost on service restart; retrying a save checks E2B's persisted build state. Run startup still checks for a ready template for older projects and runtime changes. Session sandboxes are created only when runs start, using the prepared template.

### Project setup script

Setup scripts require database schema version 2. Deployments using
`HERBIE_AUTO_MIGRATE=false` must run `pnpm --filter @herbie/service migrate`
before starting this version; startup rejects the previous schema.

An optional `setupScript` Bash script runs as root during E2B template preparation,
before any repository checkout or agent execution. Its filesystem changes are
cached in the template. The script is included in the template identity; editing
or removing it prepares a different environment before the project is saved.
Identical configurations reuse the completed template, including across restarts.
Failed builds cannot save the project or start a sandbox and can be retried.
Cached setup scripts require the E2B provider; Daytona rejects nonempty scripts.

Setup runs in `/home/compat` with `HOME=/root`, `DEBIAN_FRONTEND=noninteractive`,
and Bash `-euo pipefail`. Docker is started and checked as the non-root `compat`
agent user before setup. Scripts have a 10-minute execution limit inside the
15-minute template preparation budget. Install tools in shared locations such as
`/usr/local/bin` or `/opt` with links in `/usr/local/bin`; root-only installations
and transient shell exports will not be available to the agent. Herbie invokes
its internal Node by absolute path so projects can select their own Node version.
Python and other project languages can be installed by setup.

For example:

```bash
apt-get update
apt-get install -y --no-install-recommends python3 python3-pip python3-venv
```

The repository is not present during setup, and runtime credentials are not
supplied to template builds. Do not put secrets in scripts or cached files.
Docker containers started during setup should not be treated as persistent
services; start required services again during the session. Docker Engine 28.3.3,
Compose, and Buildx are installed from Docker's signed Ubuntu apt repository.
Every session checks daemon access, Compose, and Buildx before the agent starts.
A configured custom base template must provide the same internal tooling and
Docker contract; changing the default Ubuntu base does not replace custom bases.

The web project form supports creation and editing. The CLI accepts
`start ... --setup-script FILE` and `edit PROJECT_ID --setup-script FILE`.
Use an empty file to clear setup; omitted fields preserve existing configuration.
