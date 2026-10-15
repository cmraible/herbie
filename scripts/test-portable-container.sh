#!/usr/bin/env bash
# Disposable test database only. Never pass production runtime configuration here.
set -euo pipefail
image="${1:?Pass a locally built Herbie image}"
revision="${2:?Pass its expected image revision}"
prefix="herbie-smoke-${RANDOM}-$$"
test_private_key="$(node --input-type=module -e 'import {generateKeyPairSync} from "node:crypto"; process.stdout.write(generateKeyPairSync("rsa", {modulusLength: 2048}).privateKey.export({type: "pkcs8", format: "pem"}))')"
cleanup() {
  docker rm -f "$prefix-app" "$prefix-db" >/dev/null 2>&1 || true
  docker network rm "$prefix" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'for container in "$prefix-db" "$prefix-app"; do
  if docker inspect "$container" >/dev/null 2>&1; then
    printf "Logs for %s:\n" "$container"
    docker logs --tail 60 "$container" 2>&1 || true
  fi
done' ERR
docker network create "$prefix" >/dev/null
docker run -d --name "$prefix-db" --network "$prefix" --network-alias postgres \
  -e POSTGRES_USER=fixture -e POSTGRES_PASSWORD=fixture -e POSTGRES_DB=fixture \
  postgres:17-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24 >/dev/null
# The temporary initialization server only listens on a Unix socket.
for ((i=0;i<30;i++)); do
  if docker exec "$prefix-db" pg_isready -h 127.0.0.1 -U fixture >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$prefix-db" pg_isready -h 127.0.0.1 -U fixture >/dev/null
docker run -d --name "$prefix-app" --network "container:$prefix-db" \
  --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  --tmpfs /tmp:rw,nosuid,nodev,size=128m,mode=1777 \
  -e HERBIE_MODE=live -e HERBIE_HOST=127.0.0.1 -e HERBIE_EXECUTION_ENABLED=false \
  -e HERBIE_PUBLIC_URL=https://herbie.example.test \
  -e HERBIE_ALLOWED_GITHUB_USER_ID=7 \
  -e HERBIE_CREDENTIAL_KEY=AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8= \
  -e GITHUB_APP_ID=fixture -e GITHUB_CLIENT_ID=fixture \
  -e GITHUB_CLIENT_SECRET=fixture -e GITHUB_WEBHOOK_SECRET=fixture \
  -e "GITHUB_PRIVATE_KEY=$test_private_key" \
  -e OPENAI_API_KEY=fixture \
  -e DATABASE_URL=postgresql://fixture:fixture@127.0.0.1:5432/fixture \
  -e HERBIE_DEPLOYMENT_ID="$revision" "$image" >/dev/null
for ((i=0;i<75;i++)); do
  if docker exec "$prefix-app" node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec -e EXPECTED_REVISION="$revision" "$prefix-app" node --input-type=module -e '
  import assert from "node:assert/strict";
  const r=await fetch("http://127.0.0.1:8787/api/health");assert.equal(r.status,200);
  const health=await r.json();assert.equal(health.executionEnabled,false);
  assert.equal(health.imageRevision,process.env.EXPECTED_REVISION);
  assert.equal(health.deploymentId,process.env.EXPECTED_REVISION);
  assert.equal((await fetch("http://127.0.0.1:8787/")).status,200);
  const favicon=await fetch("http://127.0.0.1:8787/favicon.svg");
  assert.equal(favicon.status,200);
  assert.match(favicon.headers.get("content-type"),/^image\/svg\+xml\b/);
  assert.match(await favicon.text(),/<svg\b/);
  assert.notEqual(process.getuid(),0);
'
docker exec "$prefix-app" sh -c 'git --version >/dev/null && mkdir /tmp/publisher-smoke && git init --quiet /tmp/publisher-smoke'
docker stop --time 5 "$prefix-db" >/dev/null
docker exec "$prefix-app" node --input-type=module -e '
  import assert from "node:assert/strict";
  assert.equal((await fetch("http://127.0.0.1:8787/api/health",{signal:AbortSignal.timeout(15000)})).status,503);
  const live=await fetch("http://127.0.0.1:8787/api/live");assert.equal(live.status,200);
  assert.deepEqual(await live.json(),{alive:true});
'
docker stop --time 15 "$prefix-app" >/dev/null
test "$(docker inspect --format '{{.State.ExitCode}}' "$prefix-app")" = 0
printf 'Portable image smoke passed: revision, UI, favicon, non-root read-only runtime, Git scratch, DB outage, SIGTERM.\n'
