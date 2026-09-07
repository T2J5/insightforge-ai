FROM node:26.5.0-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.17.0 --activate
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @insightforge/mcp typecheck

FROM node:26.5.0-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.17.0 --activate
COPY --from=build --chown=node:node /app /app
USER node
CMD ["pnpm", "--filter", "@insightforge/mcp", "start"]
