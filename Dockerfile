# syntax=docker/dockerfile:1
# Production-ish container for the CareMemory API.
# Builds the whole pnpm workspace, then runs the compiled Fastify backend.

FROM node:22-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/
COPY packages/engine/package.json packages/engine/
COPY packages/rag/package.json packages/rag/
COPY packages/im-core/package.json packages/im-core/
COPY packages/im-whatsapp/package.json packages/im-whatsapp/
COPY packages/disease-card/package.json packages/disease-card/
COPY packages/brief-templates/package.json packages/brief-templates/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm build

FROM node:22-slim AS production
WORKDIR /app
ENV NODE_ENV=production

# Copy compiled API output and static assets.
COPY --from=build /app/apps/api/dist /app/apps/api/dist
COPY --from=build /app/apps/api/public /app/apps/api/public
COPY --from=build /app/apps/api/package.json /app/apps/api/package.json

# Copy workspace package outputs so workspace imports resolve.
COPY --from=build /app/packages /app/packages

# Copy root node_modules which contains workspace symlinks and runtime deps.
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/pnpm-workspace.yaml /app/pnpm-workspace.yaml
COPY --from=build /app/package.json /app/package.json

EXPOSE 3000
CMD ["node", "apps/api/dist/index.js"]
