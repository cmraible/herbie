# Cloudflare Workers deployment plan

Status: proposed implementation sequence. This document does not deploy resources
or change production configuration. Each numbered item is a separate commit.

## Goal and deployment model

Ship Herbie to native Cloudflare Workers while continuing to support the existing
k3s deployment. Both targets share application behavior, PostgreSQL state models,
and resumable execution handlers. Runtime adapters handle HTTP serving, task
delivery, configuration, and database connections.

The initial Cloudflare deployment uses Workers, static assets, Queues, Cron
Triggers, and Supabase PostgreSQL through Supavisor transaction pooling. E2B, the
production sandbox provider, continues to run agents independently. Daytona
remains supported on k3s; its Workers integration is optional and does not gate
this migration. No persistent Cloudflare container is part of the target
architecture.

Hyperdrive is optional. Start by validating Workers connecting directly to
Supavisor using a compatible PostgreSQL driver. Supavisor protects database
connections, but each Worker invocation still incurs connection setup to the
pooler. Measure that overhead before adding Hyperdrive. If Hyperdrive is adopted,
validate its supported upstream configuration and disable query caching for
authorization, leases, and application state.

Keep the current direct or session-pooled database connection for k3s. The existing
coordinator uses session advisory locks and PostgreSQL LISTEN; those features must
not be routed through transaction pooling. The Workers path uses short explicit
transactions, transaction-local settings or schema-qualified SQL, and no session
advisory locks, LISTEN, or named prepared statements.

Two independent installations may execute simultaneously against separate
databases. Two deployments sharing one database initially have exactly one
execution owner. Shipping a release to both targets does not transfer ownership.

## Rollout principles

- Every intermediate commit remains deployable to k3s.
- Land behavior-preserving refactors before changing execution or publication.
- Use additive, versioned schema and artifact changes with compatible readers.
- Treat queue delivery as at least once; database state controls eligibility.
- Preserve authorization, WIP limits, execution fencing, cleanup evidence, and
  reconciliation after ambiguous external writes.
- Keep credentials out of task messages, persisted artifacts, and build outputs.
- Use isolated databases, GitHub Apps, and repositories for previews and tests.
- Keep PostgreSQL authoritative; do not introduce D1 or a second state machine.

## Commit sequence

### 1. `refactor: separate portable service contracts from Node adapters` — complete

Extract shared configuration types, execution contracts, artifact validation, and
publication contracts from modules importing filesystem, subprocess, or HTTP
server APIs. Keep process environment access, PEM-file loading, and Node startup
in Node entrypoints. Workers receive configuration through bindings.

Migration: none. Existing k3s behavior remains unchanged.

Validation: existing checks pass; portable modules have no transitive imports of
Node-only runtime adapters.

### 2. `refactor: isolate publication transport and Git operations` — complete

Separate publication policy and recovery from Git object construction/ref updates
and GitHub PR operations. Keep native Git as the only implementation initially.
Preserve error classifications, verification evidence, expected-head checks, and
publication checkpoints.

Migration: none.

Validation: existing publication and recovery scenarios retain their behavior.
Completed by extracting native Git object construction and conditional ref updates
into `git-publication.ts`; publication evidence checks, lease/recovery state, and
GitHub PR creation remain in the orchestration layer. Publication tests and loop
typechecking pass.

### 3. `refactor: separate database migrations from runtime construction` — complete

Add an explicit migration command and schema compatibility checks. Separate
Better Auth runtime construction from migration imports. Retain automatic Node
startup migrations temporarily behind an explicit compatibility setting. Workers
must never migrate on a request or cold start.

Migration: add a one-shot migration Job in the private k3s infrastructure. Disable
automatic startup migrations only after that Job works. Run migrations through a
direct or otherwise migration-compatible database connection, independently of
the Workers transaction-pool connection.

Validation: compatible applications start without DDL; incompatible schema
versions fail clearly before processing work.

Completed with `pnpm --filter @herbie/service migrate`, `HERBIE_AUTO_MIGRATE=false`,
and a schema version check before runtime startup. The existing Node startup
migration path remains the default for rollout compatibility. Better Auth's
migration module is loaded only by its explicit migration method.

### 4. `test: establish Workers and Supavisor compatibility` — harness complete; live verification deferred

Sequencing decision: proceed to item 5. Do not stop at item 4 solely because live
test resources are unavailable. The local harness is complete for its current
scope; end-to-end compatibility has not been established. Independent
implementation can continue, with the following deferred checks remaining gates:

- Item 6 must prove the selected Git transport's atomic branch creation,
  expected-head protection, ambiguous-write recovery, and representative resource
  usage before it is considered complete. Item 7 must not enable it by default
  without that evidence.
- Item 14 must verify real Supavisor transaction-pool connectivity and service
  queries, authentication/credential handling, and live E2B operations in Workers
  before it is considered complete.
- Item 16 must not activate a Workers release until those integration checks and
  database setup/transaction latency and request-cost measurements are recorded.
  Item 17 still gates production ownership handoff on recovery and rollout tests.

Record commands, results, runtime versions, and measurements in the corresponding
PRs. Local mocks and connector API checks do not satisfy these live gates.

Create a small Workers test harness before selecting replacement libraries.
Validate the actual Workers runtime, not just Node-based mocks:

- A compatible PostgreSQL driver connecting to Supavisor transaction mode with
  verified TLS, bounded invocation-scoped connections, and no named prepared
  statements.
- Explicit transactions, row locks, conditional updates, transaction-local
  settings, private-schema access, and Better Auth queries.
- Auth, credential encryption, GitHub signing, and dependency compatibility.
- Required E2B operations through compatible SDK imports or HTTP adapters: template
  resolution, sandbox creation/reconnection, commands, file transfers, observation,
  and confirmed cleanup. Validate the production provider rather than requiring
  Daytona credentials.
- Portable Git object construction and conditional ref updates, including CPU
  and memory consumption for representative artifacts.

Evaluate a JavaScript Git implementation, including isomorphic-git, but choose it
only after proving atomic branch creation and expected-head protection. A GitHub
REST read followed by a ref update is not assumed equivalent to force-with-lease.
If the candidate cannot preserve these guarantees, resolve the transport design
before replacing production publication.

Measure cold/warm database setup time, connections, transaction latency, and
representative request cost. Record whether Hyperdrive has a demonstrated benefit;
it is not an acceptance requirement or mandatory dependency.

Migration: test resources only, using an isolated database and repository.

The local harness runs request handling, Web Crypto AES-GCM credential encryption
and RSA signing round trips, rejects a modified AES-GCM ciphertext, and imports
the `pg`, Better Auth, and Daytona SDK entrypoints plus the E2B provider in
`workerd` via `pnpm --filter @herbie/service test:workers`. The E2B adapter also
runs creation, reconnection, command execution, and cleanup with injected SDK
responses; this checks local runtime behavior, not live provider transport.
This establishes runtime primitive support and that these package entrypoints
load; it does not exercise the service's encryption or signing code, prove that
`pg` can open a TLS connection to Supavisor, or validate service queries. Supavisor
transactions, auth/provider flows, live E2B operations, Git publication, and
performance measurements remain outstanding and require isolated test resources.
The current service entrypoint also imports Node APIs and must not be treated as
Workers compatible.

### 5. `feat: add versioned portable change artifacts` — complete

Introduce a versioned artifact containing changed paths, expected base entries,
final file bytes, and Git modes. The trusted publisher validates changes against
the captured base commit and constructs blobs, trees, and a commit without
applying a patch through a subprocess. Native Git may remain inside the agent
sandbox for collecting changes.

Support binary files, deletion, executable bits, symlinks, and renames represented
as deletion/addition. Define gitlink behavior explicitly and reject unsupported
representations clearly. Bound file counts, decoded content, and tree traversal.

Migration: deploy readers accepting both formats before producing new artifacts.
Existing saved patches continue through the native adapter. New artifact evidence
binds the validated representation to the repository and base commit.

Validation: compare resulting Git trees with native Git across supported changes;
reject malformed paths, mismatched base entries, and oversized content.

Completed with a versioned per-path artifact emitted alongside the legacy patch.
It records the captured base blob/mode and final bytes/mode, covering binary
content, additions, deletions, executable files, symlinks, and rename-as-delete
plus-add. The host validates and persists both forms while legacy readers continue
to use the patch, and host-issued verification evidence hashes the portable form.
Gitlinks are explicitly rejected when changed; paths, duplicate
entries, encodings, file counts, and aggregate bytes are bounded. Unit coverage
checks binary data, modes, deletion, malformed paths, and invalid entries. The
portable publisher and end-to-end native-tree equivalence remain item 6 work.

### 6. `feat: implement portable Git publication`

Complete the Git transport evaluation deferred from item 4 and implement the
proven transport. Preserve the exact captured parent,
atomic branch creation, expected-head protection, authorization and lease checks
immediately before writes, and existing verification/cleanup requirements.
Persist the intended commit identity before a potentially ambiguous push and
reconcile remote state before retrying. Avoid fetching entire repository histories;
bound publication work around changed content and required trees.

Migration: opt-in on k3s initially. Keep native Git available.

Progress: the native publisher now constructs its Git tree from versioned portable
file entries when available, validating each captured base entry and preserving
the captured parent. Legacy patches still use the native patch adapter. Focused
local tests cover artifact publication and concurrent base branch advancement.
The publisher now also checks the remote branch after an ambiguous push response
and treats the write as successful only when it points to the exact intended
commit. A local bare-repository test covers acceptance followed by a lost response.
Local verification in this checkout passed with
`pnpm --filter @herbie/loop exec tsx --test --test-name-pattern='publication|portable|lost response|captured tree' test/publish-patch.test.ts test/portable-change-artifact.test.ts`
(14 tests) and `pnpm --filter @herbie/service test:workers` (5 tests). These checks
exercise native bare-repository publication and Workers package/runtime compatibility
with injected provider responses; they do not exercise GitHub transport from
Workers. The step remains incomplete: the deferred Workers runtime transport
evaluation, resource measurements, and durable persistence of intended commit
identity across process restarts still require implementation and evidence.

Validation: equivalence with native publication, concurrent head changes, existing
branches, and lost responses after successful remote writes.

### 7. `feat: enable portable publication on k3s`

Make portable publication the default for new artifacts. Retain native publication
for saved legacy patches during transition.

Migration: inventory pending legacy artifacts. Publish, explicitly abandon, or
retain their compatibility path before removing native Git. Do not silently
reinterpret legacy artifacts.

Validation: confirm publication and recovery on k3s before proceeding.

### 8. `refactor: split agent execution into resumable operations`

Split long-lived attempts into independently resumable operations:

`prepare → launch → observe once → collect → cleanup → publish`

Persist progress between operations. Keep the daemon driving these handlers at
first. Preparation and collection also need checkpoints so bootstrap work does
not exceed one invocation's limits. Observation returns after one bounded check;
it does not wait for the agent to finish. Capture transcript increments through
bounded reads and persisted offsets rather than a continuous observer.

Migration: version checkpoints. New readers support old records; new sessions use
the new protocol. Drain sessions that cannot safely cross the protocol boundary.

Validation: interruption and resume at each operation boundary without duplicate
agent launches, lost results, or premature cleanup.

### 9. `feat: add durable task scheduling and execution ownership`

Add tables for due tasks, transactional outbox records, operation leases/fencing
generations, and installation execution mode/ownership generation. Commit each
state change and its next required task in the same transaction. Messages contain
identifiers and generations, not credentials or artifacts.

Enforce WIP limits and mutual exclusion among implementation, CI repair, feedback,
and publication through database transactions. All claims and continuation writes
check the execution mode and current generation.

Migration: additive schema; existing installations default to the legacy daemon.
New task consumers remain disabled. Deploy mode-aware legacy claims everywhere
before enabling any new executor.

Validation: duplicate claims, stale generations, concurrent project work, and
rollback of state changes together with their task intent.

### 10. `feat: run durable tasks through the k3s dispatcher`

Add a Node dispatcher that claims due tasks and invokes shared handlers. Continue
running as a normal k3s service, polling locally when necessary. Replace ownership
for the full session with ownership for each short operation. Remote execution
continues when no dispatcher owns an operation.

Migration: deploy compatible code first, drain the legacy coordinator, switch
execution mode transactionally, then enable the task dispatcher. Keep controlled
rollback to the compatible legacy mode during the transition.

Validation: production-equivalent flows on k3s, including pause, cancellation,
repair, feedback, and publication recovery.

### 11. `feat: recover missed tasks and reconcile external state`

Add bounded sweeps for undelivered outbox entries, expired operation leases,
missing observations, cleanup deadlines, GitHub reconciliation, and delayed
publication retries. Use GitHub webhooks for prompt work and periodic reads for
recovery. Start with scheduled sandbox observations; completion callbacks are
optional later. A callback only triggers authenticated status verification.

Migration: backfill eligible task intent idempotently. Uncertain publication
requires reconciliation and must never become a blind write retry.

Validation: missed webhooks, lost wakeups, provider outages, and cleanup failures.

### 12. `refactor: share a Fetch API handler across deployment targets`

Extract routing into a Request-to-Response handler and make the Node server an
adapter. Preserve endpoint paths, owner-only access, original-byte webhook
verification, cookies, CLI login, and request-size bounds. Isolate static asset
serving behind runtime adapters.

Migration: no client or GitHub URL changes required.

Validation: shared HTTP/auth scenarios run against Node and Workers adapters.

### 13. `feat: support browser updates without persistent connections`

Add cursor-based polling with visibility detection and idle backoff. Advertise
supported update transport. Keep k3s WebSockets available; Workers uses polling
without a persistent LISTEN bridge. Preserve fresh snapshots and event history
recovery after disconnects.

Migration: ship clients supporting both transports before the Workers endpoint.

Validation: reconnects, history pagination, deduplication, and out-of-order event
commits retain existing correctness.

### 14. `feat: add Workers runtime with Supavisor database access`

Add HTTP, queue, and scheduled Workers entrypoints, static asset bindings, and
runtime configuration. Complete the live database, auth, and E2B verification
deferred from item 4 before promoting the proven adapter to the application runtime. Separate Node-only imports and configuration validation;
the current rejection of transaction pooling remains for legacy Node paths but
does not apply to the new transaction-safe Workers adapter.

Use bounded invocation-scoped connections and explicit cleanup. Use qualified
schema names or transaction-local settings instead of session state. Keep
session advisory locks and LISTEN in Node compatibility code only. Configure
placement near the database where supported and beneficial.

Hyperdrive remains an optional alternative adapter. Do not add it automatically
or stack poolers without validating the supported upstream and measuring value.

Migration: provision isolated Cloudflare resources and inject secrets through the
operator's secret channel. Keep production k3s database connectivity unchanged.

Validation: real Supavisor transaction-pool integration, auth, state transitions,
connection bounds, and failure cleanup in Workers.

### 15. `feat: dispatch durable tasks through Cloudflare Queues`

Connect the outbox to Queues. Acknowledge after committing the operation outcome
and continuation. A crash between send and recording delivery may duplicate a
message; handlers must tolerate that. Use delayed delivery for near-term wakeups,
database due times as authority, Cron for recovery, and dead-letter diagnostics.
Bound batches and concurrency to the database connection budget.

Start with Queues plus Cron. Defer Workflows unless durable waits demonstrate a
clear benefit without creating competing authoritative state.

Migration: enable consumers only for Cloudflare-owned installations. Stale or
early messages cannot bypass due times or ownership checks.

Validation: acknowledgement loss, delayed/out-of-order delivery, retry exhaustion,
and outbox delivery recovery.

### 16. `ci: ship Workers alongside portable container releases`

Build and verify both targets. Preserve the existing GHCR/Flux release path.
Deploy Workers through a separately configured environment with revision
reporting and schema compatibility checks. Apply required migrations before
activating dependent code. Previews use isolated state; release publication does
not automatically change execution ownership.

Migration: configure Cloudflare CI credentials and resource bindings. Extend
required verification to cover Workers without weakening container checks.

Validation: independent deployments and rollback of both targets; no production
secrets or database connections in preview builds.

### 17. `test: verify cross-runtime recovery and rollout`

Exercise duplicate/out-of-order delivery, termination after agent launch, lost
queue acknowledgements, concurrent branch modification, lost push responses,
cleanup failures, cancellation, and ownership transfer between Node and Workers.

Record idle and active request counts, queue operations, database connections,
connection setup latency, observation cost, and transcript polling cost. Compare
Supavisor alone with Hyperdrive only if measurements justify the additional path.
Validate that Workers performs no continuous observation while waiting on agents.

Migration: validate using test projects before any production ownership handoff.

### 18. `chore: retire legacy publication and coordinator compatibility`

Remove native Git from the service image and retire obsolete daemon behavior once
pending records and the rollback window permit. Keep the Node API and durable
task dispatcher as a supported k3s deployment. Defer destructive schema cleanup
to a later release.

Migration: verify that no legacy artifacts or sessions require retired readers.
Update the supported rollback floor and operator documentation.

## Production deployment and migration procedure

### First Cloudflare release: independent installation

Keep k3s production running. Deploy Cloudflare with an isolated database and test
GitHub App/repositories. Verify the complete workflow without duplicate execution
against production. This achieves shipping both targets before a production
handoff is needed.

### Optional shared-installation handoff

1. Back up PostgreSQL and preserve the credential encryption key.
2. Apply additive migrations and deploy schema-compatible code to both targets.
3. Stop new claims and drain short operations, including external writes. Record
   active remote sessions and any uncertain publication. Resolve or hold uncertain
   writes; ownership fencing cannot retract an already in-flight GitHub request.
4. Transfer execution ownership transactionally using a new generation. Confirm
   the former owner cannot resume claims or reconciliation.
5. Enable the destination dispatcher. Recover existing remote sessions using their
   original identities and checkpoints; stale messages become harmless.
6. If changing ingress, switch the canonical hostname and GitHub callback/setup/
   webhook routing. Preserve the configured origin and test owner authentication;
   a different hostname may require fresh login.
7. Verify exact revision, database readiness, task delivery, session recovery,
   publication reconciliation, and sandbox cleanup.

For rollback, drain the destination's short operations and transfer ownership back
using another new generation. Run a schema-compatible k3s image. Never downgrade
the database, reactivate stale generations, or replay uncertain GitHub writes.

## Milestones and completion criteria

1. Portable publication works in k3s with existing concurrency guarantees.
2. Durable task execution works in k3s, including interruption recovery.
3. An isolated Workers installation completes the same workflow through Supavisor.
4. CI ships both targets while preserving independent deployment and rollback.
5. An optional production handoff succeeds without duplicate execution.

Database, sandbox, and model costs remain separate from coordinator hosting.
Hyperdrive adoption is a measured optimization, not a prerequisite for completion.

## References

- [Current portable deployment](portable-deployment.md)
- [Service behavior](service.md)
- [Supabase connection modes](https://supabase.com/docs/guides/database/connecting-to-postgres)
- [Cloudflare Queues](https://developers.cloudflare.com/queues/)
- [Cloudflare Hyperdrive](https://developers.cloudflare.com/hyperdrive/)

Recheck current provider documentation and runtime limits before implementation.
