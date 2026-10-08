# Supabase database for the hosted service

Herbie uses Supabase as PostgreSQL storage behind the trusted Node service. The browser and CLI use Herbie's HTTP API; they never receive a database password, Supabase service key, or direct Data API access. GitHub remains the login and repository authorization provider.

## Connection

Use a dedicated Herbie project. For a long-running container that needs IPv4, select **Connect → Session pooler** and use its port **5432** connection string:

```text
DATABASE_URL=postgresql://postgres.PROJECT_REF:URL_ENCODED_PASSWORD@SESSION_POOLER_HOST:5432/postgres
```

Copy the exact hostname and username from the project's connection panel. URL-encode the password. A direct connection on port 5432 is also supported when the container can reach the project's IPv6 endpoint. Supabase transaction poolers on port 6543 are rejected: the service depends on a stable session search path and runs migrations during startup.

Remote live connections always use certificate and hostname verification (`rejectUnauthorized: true`). They use Node's trusted certificate authorities by default. If the project requires its downloaded root certificate, supply either `HERBIE_DATABASE_CA` with the PEM certificate text or `HERBIE_DATABASE_CA_FILE` with its readable path. Set one, not both. Do not use `rejectUnauthorized: false`, `sslmode=require`, or `ssl=no-verify`.

A bare URL or a URL ending in `?sslmode=verify-full` is accepted. Other URL query parameters are rejected so node-postgres cannot override the TLS or schema configuration. No secrets belong in source control, Docker images, browser environment variables, command history, or logs.

Each Node runtime uses at most five database connections, with a 10-second connection timeout and 30-second statement/idle-transaction timeouts. Include every container instance when budgeting the project connection limit. Loopback development databases may use plaintext; this exception does not apply to remote live databases.

## Private schema and migrations

Live runtime connections select only the `herbie` schema. `prepareDatabase` checks that search path, creates the schema if needed, and protects it before and after the existing goal and authentication migrations. The connecting database role must own the schema and tables and have permission to create them. A normal owner without superuser privileges works.

Preparation revokes schema, table, sequence, and function access from `PUBLIC` and any existing `anon`, `authenticated`, and `service_role` roles. It also removes per-schema default grants for objects created by the migration role. Every existing table receives RLS and a restrictive deny policy for non-owners. The trusted schema owner retains access through PostgreSQL's owner exemption; Herbie's HTTP API enforces user ownership. No `auth.uid()` policies or browser-facing database grants are created.

Do not add `herbie` to the project's exposed Data API schemas. Since this application uses direct PostgreSQL access only, disabling the project's Data API is appropriate. If other role memberships still grant a Data API role schema access, startup fails instead of silently accepting it. Security checks and Supabase advisors must be run against the actual project after authorized provisioning; local tests do not verify its dashboard settings.

The existing migrations remain idempotent; there is no second migration framework. Run them through `prepareDatabase` when adding tables so revocations and RLS are applied before serving traffic. This setup does not move existing tables or data from `public`. Review and explicitly migrate any previous live installation before switching it to the private schema. Local demo mode uses `public` and retains existing development data there.

## Verification

`HERBIE_TEST_DATABASE_URL` enables the real PostgreSQL tests. The database-security suite requires a loopback database with a local test administrator that can create disposable databases and roles. It verifies access using a separate, ordinary schema owner and untrusted roles, including legacy grants, RLS, repeated preparation, and schema isolation. It never provisions or changes a Supabase project.

The connection tests verify explicit TLS settings and CA handling. A successful verified connection to the provisioned Supabase endpoint remains a deployment check; no live database credentials are required for this test suite.

## Sources checked

- [Supabase connection methods](https://supabase.com/docs/guides/database/connecting-to-postgres)
- [Supabase SSL connection and root certificate guidance](https://supabase.com/docs/guides/database/psql)
- [Supabase secure data guidance](https://supabase.com/docs/guides/database/secure-data)
- [Supabase session timeout guidance](https://supabase.com/docs/guides/database/postgres/timeouts)
- [node-postgres SSL configuration precedence](https://node-postgres.com/features/ssl)
- [Supabase Data API default-grant change](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically)

The October 2026 changelog check also reviewed PostgreSQL 15.19/17.11 compatibility changes. Herbie's schema uses none of the affected `ltree`, legacy `pgcrypto` PGP ciphers, float `btree_gist` indexes, or custom selectivity operators.
