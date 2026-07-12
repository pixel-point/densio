# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=22.18.0

FROM node:${NODE_VERSION}-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}

WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@11.7.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

COPY apps/api/src apps/api/src
COPY apps/api/drizzle apps/api/drizzle
COPY packages/shared/src packages/shared/src

RUN pnpm --filter @ffmpeg-api/api build

FROM node:${NODE_VERSION}-bookworm-slim AS runtime

ENV NODE_ENV=production

WORKDIR /app

COPY --from=build --chown=node:node /workspace/apps/api/dist/ ./dist/
COPY --from=build --chown=node:node /workspace/apps/api/drizzle/ ./drizzle/

RUN mkdir -p /app/data && chown node:node /app/data

# FFmpeg and FFprobe are intentionally absent. Production mounts a pinned static
# host bundle at /opt/ffmpeg; keeping it outside this image is part of the design.
USER node

EXPOSE 3000

CMD ["node", "dist/server.js"]
