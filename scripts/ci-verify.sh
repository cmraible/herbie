#!/usr/bin/env bash
# Credential-free Linux CI verification. Supply dedicated, disposable loopback
# Postgres databases; the integration suite creates and drops schemas and roles.
set -Eeuo pipefail
umask 077

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"
: "${HERBIE_TEST_DATABASE_URL:?Set HERBIE_TEST_DATABASE_URL to a disposable loopback Postgres database}"
export HERBIE_CI_DATABASE_URL="${HERBIE_CI_DATABASE_URL:-$HERBIE_TEST_DATABASE_URL}"
export HERBIE_CI_PORT="${HERBIE_CI_PORT:-18787}"
export HERBIE_EDGE_PORT="${HERBIE_EDGE_PORT:-18790}"
export HERBIE_EDGE_ENABLED_PORT="${HERBIE_EDGE_ENABLED_PORT:-18791}"
export HERBIE_CI_ARTIFACT_DIR="${HERBIE_CI_ARTIFACT_DIR:-$repo_dir/artifacts/ci}"
export CI=true WRANGLER_SEND_METRICS=false
export CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false CLOUDFLARE_INCLUDE_PROCESS_ENV=false

for executable in node pnpm curl docker setsid; do
  command -v "$executable" >/dev/null || { printf 'Missing required command: %s\n' "$executable" >&2; exit 1; }
done
node --input-type=module <<'JS'
import {createServer} from 'node:net';
if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('CI requires Node 24');
for (const name of ['HERBIE_TEST_DATABASE_URL','HERBIE_CI_DATABASE_URL']) {
  let url;
  try { url = new URL(process.env[name]); } catch { throw new Error(`${name} must be a valid loopback PostgreSQL URL`); }
  if (!['postgres:','postgresql:'].includes(url.protocol) || !['127.0.0.1','localhost','[::1]'].includes(url.hostname) || !url.username || url.pathname.length < 2 || url.search || url.hash) {
    throw new Error(`${name} must name a dedicated loopback PostgreSQL database without query parameters`);
  }
}
const ports = ['HERBIE_CI_PORT','HERBIE_EDGE_PORT','HERBIE_EDGE_ENABLED_PORT'].map(name => Number(process.env[name]));
if (new Set(ports).size !== ports.length || ports.some(port => !Number.isInteger(port) || port < 1024 || port > 65535)) throw new Error('CI listener ports must be distinct integers from 1024 through 65535');
for (const port of ports) {
  const server = createServer();
  await new Promise((resolve,reject) => { server.once('error',() => reject(new Error(`CI port ${port} is already unavailable`))); server.listen(port,'127.0.0.1',resolve); });
  await new Promise((resolve,reject) => server.close(error => error ? reject(error) : resolve()));
}
JS

# Never point the dry-run image build at an inherited remote Docker daemon.
export DOCKER_HOST=unix:///var/run/docker.sock
unset DOCKER_CONTEXT DOCKER_TLS DOCKER_TLS_VERIFY DOCKER_CERT_PATH
docker --host=unix:///var/run/docker.sock info --format '{{.ServerVersion}}' >/dev/null

artifact_dir="$(node -e 'process.stdout.write(require("node:path").resolve(process.env.HERBIE_CI_ARTIFACT_DIR))')"
mkdir -p "$artifact_dir"
run_dir="$(mktemp -d "${TMPDIR:-/tmp}/herbie-ci.XXXXXX")"
empty_env="$run_dir/empty.env"
: > "$empty_env"
processes=()
cleanup() {
  local status=$? still_running pid
  trap - EXIT INT TERM
  set +e
  for pid in "${processes[@]}"; do kill -TERM -- "-$pid" 2>/dev/null; done
  # All executors are deterministic local fixtures. Give them bounded time to
  # finish cleanup, then terminate only process groups started by this script.
  for ((attempt=0; attempt<50; attempt++)); do
    still_running=false
    for pid in "${processes[@]}"; do
      if kill -0 -- "-$pid" 2>/dev/null; then still_running=true; fi
    done
    if [[ "$still_running" == false ]]; then break; fi
    sleep 0.2
  done
  for pid in "${processes[@]}"; do
    if kill -0 -- "-$pid" 2>/dev/null; then kill -KILL -- "-$pid" 2>/dev/null; fi
    wait "$pid" 2>/dev/null
  done
  rm -rf -- "$run_dir"
  if [[ -d packages/web/test-results ]]; then
    mkdir -p "$artifact_dir/browser"
    cp -R packages/web/test-results/. "$artifact_dir/browser/"
  fi
  printf 'CI verification exit status: %s\n' "$status" > "$artifact_dir/result.txt"
  if ((status != 0)); then printf 'Verification failed; logs are in %s\n' "$artifact_dir" >&2; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

run_step() {
  local name=$1
  shift
  printf 'Running %s\n' "$name"
  "$@" 2>&1 | tee "$artifact_dir/$name.log"
}
start_server() {
  local name=$1
  shift
  setsid "$@" > "$artifact_dir/$name.log" 2>&1 &
  server_pid=$!
  processes+=("$server_pid")
}
wait_http() {
  local pid=$1 url=$2 name=$3
  for ((attempt=0; attempt<60; attempt++)); do
    if ! kill -0 "$pid" 2>/dev/null; then
      printf '%s exited before readiness; see %s/%s.log\n' "$name" "$artifact_dir" "$name" >&2
      return 1
    fi
    if curl --fail --silent --max-time 2 "$url" >/dev/null; then return 0; fi
    sleep 0.5
  done
  printf '%s did not become ready within the bounded startup checks\n' "$name" >&2
  return 1
}

run_step build pnpm build
run_step typecheck pnpm typecheck
run_step unit-tests pnpm test

# Run the compiled trusted service and built SPA, with the deterministic adapter.
# Deliberately do not use the root "service" script, which loads a local .env.
export HERBIE_E2E_URL="http://127.0.0.1:$HERBIE_CI_PORT"
export HERBIE_CLI_E2E_ENTRY="$repo_dir/packages/cli/dist/index.js"
start_server hosted env DATABASE_URL="$HERBIE_CI_DATABASE_URL" \
  HERBIE_MODE=demo HERBIE_EXECUTION_ENABLED=true HERBIE_HOST=127.0.0.1 \
  HERBIE_PORT="$HERBIE_CI_PORT" HERBIE_PUBLIC_URL="$HERBIE_E2E_URL" \
  node --import tsx packages/service/dist/hosted.js
wait_http "$server_pid" "$HERBIE_E2E_URL/api/health" hosted
node --input-type=module <<'JS'
const response = await fetch(`${process.env.HERBIE_E2E_URL}/api/health`,{signal:AbortSignal.timeout(5000)});
const health = await response.json();
if (!response.ok || health.mode !== 'demo' || health.executionEnabled !== true) throw new Error('CI requires its own deterministic demo service');
JS
run_step cli-e2e pnpm --filter @herbie/cli test:e2e
run_step browser-e2e pnpm --filter @herbie/web test:e2e

# Exercise the actual local Worker runtime, including its scheduled handler.
# Containers are deliberately unavailable: these tests verify the fail-closed
# execution gate and supervisor failure path, without cloud or paid execution.
export HERBIE_EDGE_TEST_URL="http://127.0.0.1:$HERBIE_EDGE_PORT"
export HERBIE_EDGE_ENABLED_TEST_URL="http://127.0.0.1:$HERBIE_EDGE_ENABLED_PORT"
start_server edge-disabled pnpm --filter @herbie/cloudflare exec wrangler dev \
  --local --ip 127.0.0.1 --port "$HERBIE_EDGE_PORT" --inspector-port 0 \
  --enable-containers=false --test-scheduled --show-interactive-dev-session=false \
  --persist-to "$run_dir/edge-disabled" --env-file "$empty_env" \
  --var HERBIE_EXECUTION_ENABLED:false --var 'HERBIE_RUNTIME_SECRETS:{}'
wait_http "$server_pid" "$HERBIE_EDGE_TEST_URL/" edge-disabled
start_server edge-enabled pnpm --filter @herbie/cloudflare exec wrangler dev \
  --local --ip 127.0.0.1 --port "$HERBIE_EDGE_ENABLED_PORT" --inspector-port 0 \
  --enable-containers=false --test-scheduled --show-interactive-dev-session=false \
  --persist-to "$run_dir/edge-enabled" --env-file "$empty_env" \
  --var HERBIE_EXECUTION_ENABLED:true --var 'HERBIE_RUNTIME_SECRETS:{}'
wait_http "$server_pid" "$HERBIE_EDGE_ENABLED_TEST_URL/" edge-enabled
run_step edge-e2e pnpm --filter @herbie/cloudflare test:e2e

# This validates the real deployment bundle and builds the final Docker image.
# There is intentionally no live deploy, image push, or paid loop smoke here.
run_step deployment-dry-run pnpm --filter @herbie/cloudflare exec wrangler deploy \
  --dry-run --outdir "$artifact_dir/worker-dry-run" --env-file "$empty_env"
printf 'All CI verification stages passed. Artifacts: %s\n' "$artifact_dir"
