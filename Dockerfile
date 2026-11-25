# syntax=docker/dockerfile:1@sha256:572cebbc2b15e6f84c077742952674889cb63cd5e9b80abdffcbe587b6f19183

# ---- build: bundle the web client ----
FROM node:26-bookworm-slim@sha256:0042e17d232a87a2cd485be1da7900fca4d10a4ad11b29e9285da1d2e54798c9 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY shared ./shared
COPY web ./web
RUN npm run build

# ---- deps: production node_modules only (no native addons: SQLite is node:sqlite) ----
FROM node:26-bookworm-slim@sha256:0042e17d232a87a2cd485be1da7900fca4d10a4ad11b29e9285da1d2e54798c9 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime ----
FROM node:26-bookworm-slim@sha256:0042e17d232a87a2cd485be1da7900fca4d10a4ad11b29e9285da1d2e54798c9 AS runtime

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
