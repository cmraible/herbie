#!/usr/bin/env bash
# Build and smoke-test the same candidate on PRs and during main recovery.
set -euo pipefail
image="${1:?Pass the candidate image tag}"
revision="${2:?Pass the image revision}"
tree="$(git rev-parse HEAD^{tree})"
docker build --platform linux/amd64 --provenance=false \
  --label "org.opencontainers.image.source=${REPOSITORY_URL:?Set the repository URL}" \
  --label "org.opencontainers.image.revision=$revision" --label "io.herbie.source-tree=$tree" \
  --build-arg "HERBIE_RUNTIME_REVISION=$revision" -t "$image" .
bash "$(dirname "$0")/test-portable-container.sh" "$image" "$revision"
