# od-hub — self-hosted, Vela-compatible collaboration hub for OpenDesign.
#
# Build from the repository root (the pnpm lockfile is the install contract):
#
#   docker build -f deploy/od-hub/Dockerfile -t od-hub:local .
#
# Three stages:
#   build      installs the two workspace packages the hub build needs
#              (`tools/od-hub` and `packages/metatool`, which stamps
#              `dist/metadata.json`) from the frozen lockfile and builds
#              `tools/od-hub/dist`.
#   prod-deps  installs only `tools/od-hub`'s production dependencies
#              (`better-sqlite3` and its runtime helpers) from the same
#              lockfile, keeping pnpm's `node_modules/.pnpm` layout so the
#              package symlinks resolve unchanged in the runtime image.
#   runtime    node:24-slim + tini with `dist/`, `migrations/`, `templates/`,
#              `package.json`, and the production `node_modules` only. No pnpm,
#              no TypeScript, no source, no tests.

ARG NODE_IMAGE=docker.io/library/node:24-slim
ARG RUNTIME_IMAGE=docker.io/library/node:24-slim

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build

ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG http_proxy
ARG https_proxy
ARG no_proxy
ARG NO_PROXY

ENV HTTP_PROXY=${HTTP_PROXY}
ENV HTTPS_PROXY=${HTTPS_PROXY}
ENV http_proxy=${http_proxy}
ENV https_proxy=${https_proxy}
ENV no_proxy=${no_proxy}
ENV NO_PROXY=${NO_PROXY}
ENV CI=true

RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY scripts/postinstall.mjs ./scripts/postinstall.mjs
COPY packages/metatool ./packages/metatool
COPY tools/od-hub ./tools/od-hub
RUN corepack enable && \
    corepack prepare pnpm@10.33.2 --activate && \
    pnpm install --frozen-lockfile \
      --filter @open-design/tools-od-hub \
      --filter @open-design/metatool && \
    pnpm --filter @open-design/tools-od-hub build

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS prod-deps

ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG http_proxy
ARG https_proxy
ARG no_proxy
ARG NO_PROXY

ENV HTTP_PROXY=${HTTP_PROXY}
ENV HTTPS_PROXY=${HTTPS_PROXY}
ENV http_proxy=${http_proxy}
ENV https_proxy=${https_proxy}
ENV no_proxy=${no_proxy}
ENV NO_PROXY=${NO_PROXY}
ENV CI=true

# better-sqlite3 ships prebuilt binaries for linux glibc; the toolchain is only
# the fallback when no prebuild matches the platform.
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY scripts/postinstall.mjs ./scripts/postinstall.mjs
COPY tools/od-hub/package.json ./tools/od-hub/package.json
RUN corepack enable && \
    corepack prepare pnpm@10.33.2 --activate && \
    pnpm install --frozen-lockfile --prod \
      --filter @open-design/tools-od-hub && \
    pnpm store prune && \
    rm -rf \
      /root/.cache \
      /root/.local/share/pnpm/store \
      /app/node_modules/.cache \
      /app/node_modules/.modules.yaml \
      /app/node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3/deps \
      /app/node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3/src && \
    find /app/node_modules -type d \( \
      -name test -o \
      -name tests -o \
      -name "__tests__" -o \
      -name docs -o \
      -name doc -o \
      -name example -o \
      -name examples -o \
      -name ".github" \
    \) -prune -exec rm -rf '{}' + && \
    find /app/node_modules -type f \( \
      -name "*.md" -o \
      -name "*.markdown" -o \
      -name "*.d.ts" -o \
      -name "*.d.cts" -o \
      -name "*.d.mts" -o \
      -name "*.map" -o \
      -name "*.tsbuildinfo" -o \
      -name "binding.gyp" \
    \) -delete

# ---------------------------------------------------------------------------
FROM ${RUNTIME_IMAGE}

RUN apt-get update && \
    apt-get install -y --no-install-recommends tini ca-certificates && \
    rm -rf /var/lib/apt/lists/* && \
    groupadd --system --gid 1001 od-hub && \
    useradd --system --uid 1001 --gid od-hub --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin od-hub

WORKDIR /app
# pnpm layout: `tools/od-hub/node_modules/better-sqlite3` is a relative symlink
# into `/app/node_modules/.pnpm/...`, so both trees keep their workspace paths.
COPY --from=prod-deps --chown=od-hub:od-hub /app/node_modules ./node_modules
COPY --from=prod-deps --chown=od-hub:od-hub /app/tools/od-hub/node_modules ./tools/od-hub/node_modules
# `dist/index.mjs` locates `migrations/` and `templates/` by walking up from
# its own directory, so the three siblings must stay together.
COPY --from=build --chown=od-hub:od-hub /app/tools/od-hub/package.json ./tools/od-hub/package.json
COPY --from=build --chown=od-hub:od-hub /app/tools/od-hub/dist ./tools/od-hub/dist
COPY --from=build --chown=od-hub:od-hub /app/tools/od-hub/migrations ./tools/od-hub/migrations
COPY --from=build --chown=od-hub:od-hub /app/tools/od-hub/templates ./tools/od-hub/templates

# /data holds the SQLite file and, by default, its sibling `blobs/` tree.
# Mount a volume here; back both up together (see deploy/od-hub/README.md).
RUN mkdir -p /data && chown -R od-hub:od-hub /data
VOLUME ["/data"]

ENV NODE_ENV=production
ENV NODE_OPTIONS=--max-old-space-size=256
ENV OD_HUB_HOST=0.0.0.0
ENV OD_HUB_PORT=18790
ENV OD_HUB_DATA_DIR=/data

EXPOSE 18790

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.OD_HUB_PORT||'18790')+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

USER od-hub
# The entrypoint is the `od-hub` CLI itself, so `docker run <image> start
# --seed-dev ...` or `docker compose run od-hub start --help` pass od-hub
# arguments, not a replacement shell command.
ENTRYPOINT ["/usr/bin/tini", "--", "node", "tools/od-hub/dist/index.mjs"]
CMD ["start", "--sqlite", "/data/hub.sqlite"]
