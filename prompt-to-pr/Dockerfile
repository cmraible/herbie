FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.34.6 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile && pnpm build && pnpm --filter @prompt-to-pr/service deploy --prod --legacy /runtime

FROM node:24-alpine
ARG REVISION=development
ENV DEPLOYMENT_ID=$REVISION
RUN apk add --no-cache git ca-certificates && rm -rf /usr/local/lib/node_modules /opt/yarn* /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/yarn* /usr/local/bin/corepack
WORKDIR /app
COPY --from=build /runtime ./packages/service
COPY --from=build /app/packages/web/dist ./packages/web/dist
USER node
EXPOSE 8787
ENTRYPOINT ["node", "packages/service/dist/main.js"]
CMD ["api"]
