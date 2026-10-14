#!/usr/bin/env bash
# Exercise real manifest promotion against a disposable, loopback-only registry.
set -euo pipefail
script_dir="$(cd "$(dirname "$0")" && pwd)"
fixture="$(mktemp -d)"
registry="herbie-promotion-${RANDOM}-$$"
cleanup() {
  docker rm -f "$registry" >/dev/null 2>&1 || true
  if [[ -n "${image_repository:-}" ]]; then
    docker image rm "$image_repository:tree-$tree" >/dev/null 2>&1 || true
  fi
  rm -rf "$fixture"
}
trap cleanup EXIT
docker run -d --name "$registry" -p 127.0.0.1::5000 \
  registry:3@sha256:ddf754342cfc8acc51a56d5d0ab6af06826461864460636d8bd5c546dab2a7b8 >/dev/null
address="$(docker port "$registry" 5000/tcp)"
for ((i=0;i<30;i++)); do
  if curl --fail --silent "http://$address/v2/" >/dev/null; then break; fi
  sleep 1
done
curl --fail --silent "http://$address/v2/" >/dev/null
image_repository="localhost:${address##*:}/fixture"

# A different commit (as with squash merging) can have identical source contents.
git -C "$fixture" init --quiet
git -C "$fixture" config user.name 'Promotion test'
git -C "$fixture" config user.email 'promotion@example.invalid'
printf 'same source contents\n' > "$fixture/payload"
git -C "$fixture" add payload
git -C "$fixture" commit --quiet -m 'PR merge commit'
pr_revision="$(git -C "$fixture" rev-parse HEAD)"
tree="$(git -C "$fixture" rev-parse HEAD^{tree})"
git -C "$fixture" commit --quiet --amend -m 'Squashed main commit'
revision="$(git -C "$fixture" rev-parse HEAD)"
test "$pr_revision" != "$revision"
test "$tree" = "$(git -C "$fixture" rev-parse HEAD^{tree})"

printf 'FROM scratch\nCOPY payload /payload\n' > "$fixture/Dockerfile"
docker build --provenance=false --label "io.herbie.source-tree=$tree" \
  --label "org.opencontainers.image.revision=$pr_revision" \
  -t "$image_repository:tree-$tree" "$fixture" >/dev/null
docker push "$image_repository:tree-$tree" >/dev/null
manifest_digest() {
  docker buildx imagetools inspect "$1" --format '{{json .Manifest}}' | jq -er .digest
}
digest="$(manifest_digest "$image_repository:tree-$tree")"
promoted="$(bash "$script_dir/promote-portable-image.sh" "$image_repository" "$tree" "$revision" 42)"
test "$promoted" = "$image_repository@$digest"
test "$(manifest_digest "$image_repository:$revision")" = "$digest"
test "$(manifest_digest "$image_repository:main-42-$revision")" = "$digest"

# Manual recovery promotes only the revision tag, without an automatic channel.
bash "$script_dir/promote-portable-image.sh" "$image_repository" "$tree" "$pr_revision" >/dev/null
test "$(manifest_digest "$image_repository:$pr_revision")" = "$digest"
if manifest_digest "$image_repository:main-0-$pr_revision" >/dev/null 2>&1; then
  echo 'Manual promotion unexpectedly created a deployment channel tag' >&2
  exit 1
fi

# No matching candidate must fail; even an incorrectly tagged image must fail.
missing=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
if bash "$script_dir/promote-portable-image.sh" "$image_repository" "$missing" "$revision" 43 >"$fixture/output" 2>&1; then
  echo 'Missing candidate unexpectedly promoted' >&2
  exit 1
fi
grep -q 'No PR image for source tree' "$fixture/output"
docker buildx imagetools create --prefer-index=false --tag "$image_repository:tree-$missing" "$promoted"
if bash "$script_dir/promote-portable-image.sh" "$image_repository" "$missing" "$revision" 43 >"$fixture/output" 2>&1; then
  echo 'Mismatched source tree unexpectedly promoted' >&2
  exit 1
fi
grep -q 'source tree does not match' "$fixture/output"
if manifest_digest "$image_repository:main-43-$revision" >/dev/null 2>&1; then
  echo 'Rejected promotion unexpectedly created a deployment channel tag' >&2
  exit 1
fi
printf 'Image promotion passed: identical digest, changed commit SHA, manual recovery, missing and mismatched candidates.\n'
