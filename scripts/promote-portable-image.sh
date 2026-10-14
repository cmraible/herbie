#!/usr/bin/env bash
# Copy only the manifest within one registry repository; never rebuild or pull layers.
set -euo pipefail
image_repository="${1:?Pass the image repository}"
tree="${2:?Pass the merged source tree SHA}"
revision="${3:?Pass the main commit SHA}"
sequence="${4:-0}"
[[ "$tree" =~ ^[a-f0-9]{40}$ && "$revision" =~ ^[a-f0-9]{40}$ && "$sequence" =~ ^(0|[1-9][0-9]*)$ ]]

candidate="$image_repository:tree-$tree"
if ! digest="$(docker buildx imagetools inspect "$candidate" --format '{{json .Manifest}}' | jq -er '.digest | select(test("^sha256:[a-f0-9]{64}$"))')"; then
  echo "No PR image for source tree $tree. Update the PR against main and let its image upload finish before merging. No rebuild was attempted." >&2
  exit 1
fi
image="$image_repository@$digest"
source_tree="$(docker buildx imagetools inspect "$image" --format '{{json .Image}}' | jq -er '.config.Labels["io.herbie.source-tree"]')"
if [[ "$source_tree" != "$tree" ]]; then
  echo "PR image source tree does not match main; refusing promotion." >&2
  exit 1
fi

tags=(--tag "$image_repository:$revision")
if [[ "$sequence" != 0 ]]; then
  tags+=(--tag "$image_repository:main-$sequence-$revision")
fi
docker buildx imagetools create --prefer-index=false "${tags[@]}" "$image" >&2
printf '%s\n' "$image"
