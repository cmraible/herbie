#!/usr/bin/env bash
# Run workspace and promotion checks on macOS or Linux without host Node or Postgres.
set -Eeuo pipefail
# Give each background stage a process group so interruption reaches its children.
set -m
cd "$(dirname "$0")/.."
for executable in docker git curl jq; do
  command -v "$executable" >/dev/null || { echo "Missing required command: $executable" >&2; exit 1; }
done
docker info >/dev/null
docker buildx version >/dev/null
started=$SECONDS
prefix="herbie-verify-${RANDOM}-$$"
artifact_dir="$PWD/artifacts/ci/$prefix"
mkdir -p "$artifact_dir"
source scripts/verify-timing.sh
timing_started="$(jq -nr now)"
jobs=()
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  # Let each child run its own cleanup before removing our database.
  for pid in "${jobs[@]}"; do wait "$pid" 2>/dev/null || true; done
  docker rm -f "$prefix-tests" "$prefix-db" >/dev/null 2>&1 || true
  timing_report "$status" "$timing_started" || true
  printf 'Local CI finished in %ss (exit %s). Logs: %s\n' "$((SECONDS-started))" "$status" "$artifact_dir"
  exit "$status"
}
trap cleanup EXIT
trap 'for pid in "${jobs[@]}"; do kill -TERM -- "-$pid" 2>/dev/null || true; done; exit 130' INT TERM

workspace_checks() (
  # Keep nested jobs in this stage's process group for interruption.
  set +m
  # Database startup does not depend on the verification image. Reap it even
  # when the build fails, before the outer cleanup removes the database.
  time_step workspace_checks postgres-startup start_database &
  database_pid=$!
  trap 'status=$?; wait "$database_pid" || true; exit "$status"' EXIT
  time_step workspace_checks verification-image docker build -f Dockerfile.verify --iidfile "$artifact_dir/verify-image" .
  wait "$database_pid"
  docker run --rm --init --name "$prefix-tests" --network "container:$prefix-db" --shm-size=1g \
    -e HERBIE_TEST_DATABASE_URL=postgresql://herbie:herbie-local-only@127.0.0.1:5432/herbie \
    -v "$artifact_dir:/app/artifacts/ci" "$(cat "$artifact_dir/verify-image")"
)
start_database() {
  docker run -d --name "$prefix-db" \
    -e POSTGRES_USER=herbie -e POSTGRES_PASSWORD=herbie-local-only -e POSTGRES_DB=herbie \
    postgres:17-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24
  for ((i=0;i<30;i++)); do
    if docker exec "$prefix-db" pg_isready -h 127.0.0.1 -U herbie >/dev/null 2>&1; then break; fi
    sleep 0.2
  done
  docker exec "$prefix-db" pg_isready -h 127.0.0.1 -U herbie
}
# Promotion uses an isolated local registry; it never publishes remotely.
promotion_checks() { bash scripts/test-image-promotion.sh; }
stages=(workspace_checks promotion_checks)
for stage in "${stages[@]}"; do
  echo "Running $stage"
  time_step "" "$stage" "$stage" >"$artifact_dir/$stage.log" 2>&1 &
  jobs+=("$!")
done
status=0
for ((i=0;i<${#jobs[@]};i++)); do
  if wait "${jobs[$i]}"; then
    echo "PASS ${stages[$i]}"
  else
    echo "FAIL ${stages[$i]}" >&2
    tail -80 "$artifact_dir/${stages[$i]}.log" >&2
    status=1
  fi
done
exit "$status"
