# E2B security refresh

The October 2026 eMudhra intermediate-key compromise requires updating both OS
trust stores and runtimes. References:

- https://ubuntu.com/security/notices/USN-8944-1
- https://nodejs.org/en/blog/release/v24.22.1
- https://docs.docker.com/engine/release-notes/29/#2992
- https://emudhra.we-have-a-problem.com/

E2B builds upgrade OS packages, require Ubuntu 24.04's ca-certificates package
20260816ubuntu0.24.04.1 or newer, and disable both affected root trust paths
(emSign ECC Root CA - G3 and Comodo AAA Certificate Services). The runtime installs
Node 24.22.1 and Docker 29.9.2. Custom bases must support the Ubuntu 24.04 runtime
installer and are refreshed too. Builds bypass E2B's layer cache. The OS revision
participates in every generated template name, so old generated aliases cannot
satisfy the new resolver.

To prepare every project before rollout, export all distinct resource/setup
combinations from the target deployment to a JSON array. Include the configured
custom base as `template` for each affected entry, and preserve setup scripts
exactly. Example (resource units are CPU cores and GiB):

```json
[{ "cpu": 2, "memory": 4, "disk": 10, "setupScript": "" }]
```

With the target account's `E2B_API_KEY` injected into the environment, run:

```sh
pnpm --filter @herbie/loop regenerate:e2b /absolute/path/to/manifest.json
```

This waits for each generated template to become ready and prints its alias.
Re-running resumes/reuses templates for the new revision. The manifest must
include every project, including projects with default resources. The repository
does not contain a production project inventory. Rebuild any separately managed
base aliases using `build:e2b-template` before building their descendants.

Deploy the matching resolver code after regeneration. Existing running or resumed
sandboxes retain their old filesystems; finish or replace those separately before
declaring rollout complete. Project setup scripts and nested container images can
install independent CA bundles or older runtimes and need their own updates.
Verify both direct and Sectigo cross-sign chains using the disclosure's test
fixtures; DNS/network failures are not evidence of certificate rejection.
