FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.34.6 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile && pnpm build

FROM node:24-bookworm-slim
ARG REVISION=development
ENV DEPLOYMENT_ID=$REVISION
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/service/package.json ./packages/service/package.json
COPY --from=build /app/packages/service/node_modules ./packages/service/node_modules
COPY --from=build /app/packages/service/dist ./packages/service/dist
COPY --from=build /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build /app/packages/contracts/node_modules ./packages/contracts/node_modules
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /app/packages/web/dist ./packages/web/dist
USER node
EXPOSE 8787
ENTRYPOINT ["node", "packages/service/dist/main.js"]
CMD ["api"]
