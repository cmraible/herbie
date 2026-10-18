#!/usr/bin/env bash
# Credential-free Linux CI verification. Supply dedicated, disposable loopback
# Postgres databases; the integration suite creates and drops schemas and roles.
set -Eeuo pipefail
umask 077

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"
stage="${1:-all}"
case "$stage" in build|unit|cli|core|browser|all) ;; *) printf 'Unknown CI verification stage: %s\n' "$stage" >&2; exit 2 ;; esac
needs_database=false
[[ "$stage" == build || "$stage" == cli ]] || needs_database=true
if [[ "$needs_database" == true ]]; then
  : "${HERBIE_TEST_DATABASE_URL:?Set HERBIE_TEST_DATABASE_URL to a disposable loopback Postgres database}"
  export HERBIE_CI_DATABASE_URL="${HERBIE_CI_DATABASE_URL:-$HERBIE_TEST_DATABASE_URL}"
fi
export HERBIE_CI_PORT="${HERBIE_CI_PORT:-18787}"
export HERBIE_CI_ARTIFACT_DIR="${HERBIE_CI_ARTIFACT_DIR:-$repo_dir/artifacts/ci}"
export CI=true

for executable in node pnpm curl setsid jq; do
  command -v "$executable" >/dev/null || { printf 'Missing required command: %s\n' "$executable" >&2; exit 1; }
done
HERBIE_REQUIRE_DATABASE="$needs_database" node --input-type=module <<'JS'
import {createServer} from 'node:net';
if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('CI requires Node 24');
if (process.env.HERBIE_REQUIRE_DATABASE === 'true') {
  for (const name of ['HERBIE_TEST_DATABASE_URL','HERBIE_CI_DATABASE_URL']) {
    let url;
    try { url = new URL(process.env[name]); } catch { throw new Error(`${name} must be a valid loopback PostgreSQL URL`); }
    if (!['postgres:','postgresql:'].includes(url.protocol) || !['127.0.0.1','localhost','[::1]'].includes(url.hostname) || !url.username || url.pathname.length < 2 || url.search || url.hash) {
      throw new Error(`${name} must name a dedicated loopback PostgreSQL database without query parameters`);
    }
  }
}
const ports = ['HERBIE_CI_PORT'].map(name => Number(process.env[name]));
if (new Set(ports).size !== ports.length || ports.some(port => !Number.isInteger(port) || port < 1024 || port > 65535)) throw new Error('CI listener ports must be distinct integers from 1024 through 65535');
for (const port of ports) {
  const server = createServer();
  await new Promise((resolve,reject) => { server.once('error',() => reject(new Error(`CI port ${port} is already unavailable`))); server.listen(port,'127.0.0.1',resolve); });
  await new Promise((resolve,reject) => server.close(error => error ? reject(error) : resolve()));
}
JS

artifact_dir="$(node -e 'process.stdout.write(require("node:path").resolve(process.env.HERBIE_CI_ARTIFACT_DIR))')"
mkdir -p "$artifact_dir"
source scripts/verify-timing.sh
timing_started="$(jq -nr now)"
processes=()
playwright_install_pid=''
cleanup() {
  local status=$? still_running pid
  trap - EXIT INT TERM
  set +e
  if [[ -n "$playwright_install_pid" ]]; then
    kill -TERM -- "-$playwright_install_pid" 2>/dev/null
    wait "$playwright_install_pid" 2>/dev/null
  fi
  for pid in "${processes[@]}"; do kill -TERM -- "-$pid" 2>/dev/null; done
  # Child processes are local test fixtures. Give them bounded time to
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
  if [[ -d packages/web/test-results ]]; then
    mkdir -p "$artifact_dir/browser"
    cp -R packages/web/test-results/. "$artifact_dir/browser/"
  fi
  printf 'CI verification exit status: %s\n' "$status" > "$artifact_dir/result.txt"
  record_timing "" workspace_checks "$timing_started" "$status"
  timing_report "$status" "$timing_started"
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
  time_step workspace_checks "$name" "$@" 2>&1 | tee "$artifact_dir/$name.log"
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

playwright_install_log="$artifact_dir/playwright-install.log"
start_browser_install() {
  # The workflow restores this browser cache. On a cold cache, install while
  # TypeScript builds run so the download is off the browser-test critical path.
  setsid bash -Eeuo pipefail -c 'artifact_dir=$HERBIE_CI_ARTIFACT_DIR; source scripts/verify-timing.sh; time_step workspace_checks playwright-install pnpm --filter @herbie/web exec playwright install chromium --only-shell' >"$playwright_install_log" 2>&1 &
  playwright_install_pid=$!
}
wait_browser_install() {
  if [[ -z "$playwright_install_pid" ]]; then return 0; fi
  if ! wait "$playwright_install_pid"; then
    cat "$playwright_install_log" >&2
    return 1
  fi
  playwright_install_pid=''
}
run_build() {
  run_step lint pnpm lint
  run_step format pnpm format:check
  run_step build node scripts/verify-timing.mjs workspace_checks.build -r build
  run_step typecheck node scripts/verify-timing.mjs workspace_checks.typecheck -r typecheck
}
run_unit_tests() {
  # The workspace packages do not share test state. Running them together
  # avoids serializing the package test scripts behind the longest suite.
  run_step release-artifact node --test scripts/classify-pr.test.mjs scripts/build-release-artifact.test.mjs scripts/promote-portable-image.test.mjs scripts/ship-watch.test.mjs scripts/verify-timing.test.mjs scripts/deploy-watch.test.mjs
  run_step unit-tests node scripts/verify-timing.mjs workspace_checks.unit-tests -r --parallel --workspace-concurrency=2 test
}
run_unit() {
  run_step build node scripts/verify-timing.mjs workspace_checks.build -r build
  run_unit_tests
}
start_web_preview() {
  export HERBIE_E2E_URL="http://127.0.0.1:$HERBIE_CI_PORT"
  start_server web-preview pnpm --filter @herbie/web exec vite preview \
    --host 127.0.0.1 --port "$HERBIE_CI_PORT" --strictPort
  time_step workspace_checks web-preview-startup wait_http "$server_pid" "$HERBIE_E2E_URL/" web-preview
}
run_browser() {
  run_step browser-e2e pnpm --filter @herbie/web test:e2e
}

case "$stage" in
  build)
    run_build
    ;;
  unit)
    run_unit
    ;;
  cli)
    run_step build node scripts/verify-timing.mjs workspace_checks.build -r build
    run_step cli-tests pnpm --filter @herbie/cli test
    ;;
  core)
    run_build
    run_unit
    ;;
  browser)
    start_browser_install
    # CLI consent scenarios use the service; include its workspace dependencies.
    run_step build node scripts/verify-timing.mjs workspace_checks.build --filter @herbie/web... --filter @herbie/service... -r build
    wait_browser_install
    start_web_preview
    run_browser
    ;;
  all)
    start_browser_install
    run_build
    run_unit_tests
    wait_browser_install
    start_web_preview
    run_browser
    ;;
esac

printf 'All CI verification stages passed. Artifacts: %s\n' "$artifact_dir"
