#!/usr/bin/env bash
set -euo pipefail
# This daemon must be inside a dedicated Daytona Linux VM. Never mount a host socket.
if ! docker info >/dev/null 2>&1; then
  sudo -n dockerd >/tmp/herbie-dockerd.log 2>&1 &
  for attempt in $(seq 1 30); do
    docker info >/dev/null 2>&1 && break
    sleep 1
  done
fi
docker info >/dev/null
work=$(mktemp -d)
trap 'docker compose -p herbie-preflight -f "$work/compose.yaml" down --volumes >/dev/null 2>&1 || true; rm -rf "$work"' EXIT
cat > "$work/Dockerfile" <<'DOCKER'
FROM alpine:3.22
RUN printf 'docker-build-ok\n' > /proof
CMD ["cat", "/proof"]
DOCKER
docker build -q -t herbie-preflight "$work" >/dev/null
test "$(docker run --rm herbie-preflight)" = docker-build-ok
cat > "$work/compose.yaml" <<'COMPOSE'
services:
  cache:
    image: redis:7-alpine
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 1s
      timeout: 2s
      retries: 30
COMPOSE
docker compose -p herbie-preflight -f "$work/compose.yaml" up -d --wait >/dev/null
test "$(docker compose -p herbie-preflight -f "$work/compose.yaml" exec -T cache redis-cli ping)" = PONG
