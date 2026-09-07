FROM node:26.5.0-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.17.0 --activate
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @insightforge/worker typecheck

FROM node:26.5.0-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.17.0 --activate
COPY --from=build --chown=node:node /app /app
USER node
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD kill -0 1 && pnpm --filter @insightforge/worker healthcheck
CMD ["pnpm", "--filter", "@insightforge/worker", "start"]
