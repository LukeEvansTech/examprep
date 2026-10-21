# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e

# ---- build: bundle the web client ----
FROM node:26-bookworm-slim@sha256:742a0fe7320e09e0321222b68165e6ac731d30470e7ea7f98f9bfc3a6e1034fe AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY shared ./shared
COPY web ./web
RUN npm run build

# ---- deps: production node_modules only (no native addons: SQLite is node:sqlite) ----
FROM node:26-bookworm-slim@sha256:742a0fe7320e09e0321222b68165e6ac731d30470e7ea7f98f9bfc3a6e1034fe AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime ----
FROM node:26-bookworm-slim@sha256:742a0fe7320e09e0321222b68165e6ac731d30470e7ea7f98f9bfc3a6e1034fe AS runtime

# App version, stamped from the release tag by CI (docker-publish.yml build-args).
ARG VERSION=0.0.0-dev
ENV APP_VERSION=${VERSION} \
    NODE_ENV=production \
    PORT=8080 \
    EXAMPREP_DB=/data/examprep.db \
    EXAMPREP_STATIC=/app/dist

LABEL org.opencontainers.image.source="https://github.com/LukeEvansTech/examprep" \
      org.opencontainers.image.title="examprep" \
      org.opencontainers.image.description="Self-hosted exam practice app: exam and study modes, spaced repetition, offline PWA" \
      org.opencontainers.image.version="${VERSION}"

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY shared ./shared
COPY server ./server
COPY --from=build /app/dist ./dist

# SQLite lives on a mounted volume at /data, owned by the non-root runtime uid.
RUN mkdir -p /data && chown -R 1000:1000 /data
VOLUME ["/data"]

USER 1000:1000
# Kubernetes probes own liveness (GET /api/health); an image healthcheck would double-probe.
HEALTHCHECK NONE
EXPOSE 8080
ENTRYPOINT ["node", "server/main.ts"]
