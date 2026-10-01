# Build into a Daytona snapshot with sandboxClass=linux-vm, NOT a container snapshot.
FROM node:24-bookworm
ARG CODEX_VERSION=0.146.0
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git sudo util-linux \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && echo 'deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable' > /etc/apt/sources.list.d/docker.list \
    && apt-get update && apt-get install -y --no-install-recommends docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin \
    && npm install -g @openai/codex@${CODEX_VERSION} \
    && echo 'node ALL=(ALL) NOPASSWD: /usr/bin/dockerd' > /etc/sudoers.d/herbie \
    && usermod -aG docker node && rm -rf /var/lib/apt/lists/*
COPY runner.mjs docker-preflight.sh /opt/herbie/
USER node
