#!/usr/bin/env bash
set -euo pipefail

image_repository=$1
sequence=$2
revision=$3
artifact_dir=$4
repository=${image_repository#ghcr.io/}
source="https://github.com/$repository"
identity="$source/.github/workflows/portable-image.yml@refs/heads/main"

[[ "$sequence" =~ ^[1-9][0-9]*$ && "$revision" =~ ^[a-f0-9]{40}$ ]]

# Staging tags do not match Flux's production version selector.
artifact=$(flux push artifact "oci://$image_repository:release-$revision" \
  --path="$artifact_dir" --source="$source" --revision="main@sha1:$revision" \
  --output json | jq -er '.repository + "@" + .digest')
cosign sign --yes "$artifact"
cosign verify --certificate-identity "$identity" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com "$artifact" >/dev/null

# Never announce an unsigned, incorrectly signed, or superseded release.
current=$(gh api "repos/$repository/git/ref/heads/main" --jq .object.sha)
test "$current" = "$revision" || { echo 'Main advanced; refusing release artifact.' >&2; exit 1; }
flux tag artifact "oci://$artifact" --tag "0.0.$sequence"
printf '%s\n' "$artifact"
