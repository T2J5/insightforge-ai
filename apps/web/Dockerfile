FROM node:26.5.0-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.17.0 --activate
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @insightforge/web build

FROM node:26.5.0-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.17.0 --activate
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=20s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["pnpm", "--filter", "@insightforge/web", "start"]
