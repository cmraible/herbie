# Daytona environments per goal

Research date: 2026-10-15. This is a proposal, not implemented behavior.

Daytona provides enough control to give each goal a reproducible language environment. A sandbox can start from a custom container image or a named snapshot. Images can define OS packages, runtime versions, tools, environment variables, working directory, and user through a Dockerfile or Daytona's declarative builder. The builder supports multiple runtimes in one image. [Declarative builder](https://www.daytona.io/docs/en/declarative-builder/)

The `language` option selects the Python, JavaScript, or TypeScript runtime for direct SDK code execution; it is not a general runtime-version specification. Pin Node/Python/etc. through the image and installed toolchain. [Sandbox languages](https://www.daytona.io/docs/en/sandboxes/#languages)

Snapshots let many sandboxes reuse a prepared environment. Images require a tag or digest; moving aliases such as `latest`, `lts`, and `stable` are unsupported. Prefer a digest for reproducibility. Linux VM snapshots have different build constraints: Dockerfile/declarative builds are unsupported, so use an existing image reference. [Snapshots](https://www.daytona.io/docs/en/snapshots/)

CPU, RAM, and disk are configurable subject to organization limits. Image-based creation accepts resources directly; snapshot-based creation inherits the snapshot's allocation. [Scaling](https://www.daytona.io/docs/en/scale/)

Network policy is independently configurable. Tier 1/2 organization restrictions cannot be overridden per sandbox. Tier 3/4 permit sandbox policies and updates while running; an explicit allowlist also needs package registry/download domains, since essential services do not bypass it. [Network limits](https://www.daytona.io/docs/en/network-limits/)

Herbie currently bootstraps Node 24.19.0 and Codex into Ubuntu and creates a non-root `compat` user; the default bootstrap now also installs Python 3.15.0 with pip and exposes the user tools directory on PATH. See [runtime setup](../packages/loop/src/daytona-runtime.ts). The agent can install Lizard on demand with `python3 -m pip install --user lizard`.

Recommended minimal design: let a goal select a named environment profile, for example `node24-python312`, resolved to a prepared snapshot containing Herbie's agent tools plus the requested project toolchain. Keep repository dependency installation in a setup command after checkout; fail setup explicitly before starting the agent. Include a smoke check for runtime versions, package managers, required tools, and test services. Record the resolved snapshot/version with each attempt. Add custom image/Dockerfile support only when profiles prove insufficient.

Environment selection must remain separate from network policy and agent permissions: a suitable image supplies tools, but cannot by itself grant registry access or a writable installation location. Network access should include the registries/CDNs needed by setup, within the organization's policy. Runtime configuration should support multiple languages because analysis tools may use a different language from the application.

Docker Engine 28.3.3 and Compose are installed by the default bootstrap. Each attempt starts Docker if needed and checks daemon access and Compose as the `compat` agent user before running the goal. This lets agents start PostgreSQL and other services with Docker or Compose. Default sandboxes allocate 2 CPUs, 4 GiB RAM, and 10 GiB disk. Custom snapshots must include Docker Engine and Compose and should provide at least these resources; missing tools or an inaccessible daemon fail runtime preparation. Network allowlists must also permit Docker installation (`get.docker.com`, `download.docker.com`) and the container registries used by the project.
