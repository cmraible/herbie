# syntax=docker/dockerfile:1
FROM node:24.19.0-bookworm-slim AS package-manager
WORKDIR /app
# Optional public proxy CA is mounted only during networked build steps.
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm install --global pnpm@10.34.6

FROM package-manager AS workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/loop/package.json packages/loop/
COPY packages/service/package.json packages/service/
COPY packages/web/package.json packages/web/

FROM workspace AS build
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    pnpm install --frozen-lockfile --prod=false --filter herbie --filter '@herbie/service...' --filter '@herbie/web...'
COPY packages/ packages/
RUN test ! -e packages/cli && test ! -e packages/cloudflare && \
    test ! -e packages/service/test && test ! -e packages/service/.env && \
    pnpm --filter '@herbie/service...' build && pnpm --filter @herbie/web build

FROM workspace AS production-dependencies
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    pnpm install --frozen-lockfile --prod --filter herbie --filter '@herbie/service...'

FROM node:24.19.0-bookworm-slim AS runtime
ARG HERBIE_RUNTIME_REVISION=1
LABEL herbie.runtime-revision=$HERBIE_RUNTIME_REVISION
ENV NODE_ENV=production HERBIE_HOST=0.0.0.0 HERBIE_PORT=8787
WORKDIR /app
# The trusted publisher uses native Git; generated code is never executed here.
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then \
      apt-get -o Acquire::https::CaInfo=/run/secrets/proxy_ca update; \
    else apt-get update; fi; \
    apt-get install --yes --no-install-recommends git ca-certificates && \
    rm -rf /var/lib/apt/lists/*
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=production-dependencies --chown=node:node /app/package.json ./package.json
COPY --from=production-dependencies --chown=node:node /app/packages/contracts ./packages/contracts
COPY --from=production-dependencies --chown=node:node /app/packages/loop ./packages/loop
COPY --from=production-dependencies --chown=node:node /app/packages/service ./packages/service
COPY --from=build --chown=node:node /app/packages/contracts/src ./packages/contracts/src
COPY --from=build --chown=node:node /app/packages/loop/dist ./packages/loop/dist
COPY --from=build --chown=node:node /app/packages/service/dist ./packages/service/dist
COPY --from=build --chown=node:node /app/packages/web/dist ./packages/web/dist
USER node
EXPOSE 8787
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["node", "--input-type=module", "-e", "const r=await fetch('http://127.0.0.1:8787/api/health');process.exit(r.ok?0:1)"]
CMD ["node", "--import", "tsx", "packages/service/dist/hosted.js"]
