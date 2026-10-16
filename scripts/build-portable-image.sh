#!/usr/bin/env bash
# Build and smoke-test the same candidate on PRs and during main recovery.
set -euo pipefail
image="${1:?Pass the candidate image tag}"
revision="${2:?Pass the image revision}"
tree="$(git rev-parse HEAD^{tree})"
build=(docker build)
if [[ -n "${HERBIE_BUILD_CACHE:-}" ]]; then
  builder="herbie-cache-${RANDOM}-$$"
  # Keep the default builder untouched: promotion fixtures use the local image store.
  docker buildx create --driver docker-container --name "$builder" >/dev/null
  trap 'docker buildx rm "$builder" >/dev/null 2>&1 || true' EXIT
  build=(docker buildx build --builder "$builder" --load
    --cache-from "type=registry,ref=$HERBIE_BUILD_CACHE"
    --cache-to "type=registry,ref=$HERBIE_BUILD_CACHE,mode=max,ignore-error=true")
fi
"${build[@]}" --platform linux/amd64 --provenance=false \
  --label "org.opencontainers.image.source=${REPOSITORY_URL:?Set the repository URL}" \
  --label "org.opencontainers.image.revision=$revision" --label "io.herbie.source-tree=$tree" \
  --build-arg "HERBIE_RUNTIME_REVISION=$revision" -t "$image" .
bash "$(dirname "$0")/test-portable-container.sh" "$image" "$revision"
