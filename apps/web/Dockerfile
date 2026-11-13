# syntax=docker/dockerfile:1.7
#
# Blue Dots Aggregator Portal — Next.js 15 production image (apps/web).
#
# Multi-stage build aligned with repo template. Uses Next.js standalone output
# (`output: 'standalone'` in next.config.ts) so the runtime image only carries
# the compiled server, .next/static, and public/ assets — no pnpm, no source.
#
#   1. base       — dhi.io/node:24-alpine-dev + corepack
#   2. installer  — workspace deps (filtered to web)
#   3. builder    — `next build` produces .next/standalone
#   4. runner     — hardened dhi.io/node:24-alpine, non-root `node` (uid 1000) on :3000

# Build stages use the DHI *dev* variant — the only one carrying a shell, apk,
# corepack and npm. The runner below uses the hardened variant, which has none of
# them, so no RUN is possible past that FROM.
FROM dhi.io/node:24-alpine-dev AS base
ENV PNPM_HOME="/pnpm" \
    PATH="$PNPM_HOME:$PATH" \
    CI=true
RUN corepack enable

# ── installer ─────────────────────────────────────────────────────────────────
FROM base AS installer
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json                    apps/web/package.json
COPY packages/tsconfig/package.json           packages/tsconfig/package.json
# web's server components read consent config via @aggregator-dpg/config-loader,
# which pulls in @aggregator-dpg/shared-primitives; the public registration page
# imports the shared `signals_cta` rule from @aggregator-dpg/network-config.
# Every workspace package in web's dependency closure needs its package.json
# here, or the filtered install below fails to resolve the workspace link.
COPY packages/config-loader/package.json      packages/config-loader/package.json
COPY packages/network-config/package.json     packages/network-config/package.json
COPY packages/shared-primitives/package.json  packages/shared-primitives/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts --filter @aggregator-dpg/web...

# ── builder ───────────────────────────────────────────────────────────────────
FROM installer AS builder
ENV NEXT_TELEMETRY_DISABLED=1
# No NEXT_PUBLIC_* build args, deliberately. Next.js inlines those into the
# client bundle at `next build`, which made every value passed here permanent
# for the life of the image — an operator could not change the language list or
# the invite cap without a rebuild, even though both are documented as env.
#
# Every setting the browser needs is now resolved in a SERVER component and
# handed down (see apps/web/src/i18n/EnabledLocalesProvider.tsx), so the image
# is deployment-agnostic and reconfiguring it is an env change plus a restart.
# Do not reintroduce a NEXT_PUBLIC_* ARG here without that reasoning changing.
COPY . .
# Build web AND its workspace dependencies in topological order
# (shared-primitives → config-loader → web). Without the trailing `...`,
# only `next build` runs and the workspace packages' `dist/` is absent, so
# imports like `@aggregator-dpg/config-loader/fs` fail to resolve.
RUN pnpm --filter @aggregator-dpg/web... build

# ── runner ────────────────────────────────────────────────────────────────────
FROM dhi.io/node:24-alpine AS runner
# Hardened runtime: no shell, no apk, no npm/corepack. The previous
# `RUN addgroup … && adduser …` cannot run here — and is unnecessary: the image
# already ships an unprivileged `node` user at uid 1000, matching the runAsUser
# the deploy charts set for this service.

ARG VCS_REF=unknown
ARG BUILD_DATE=unknown
ARG VERSION=0.0.0

LABEL org.opencontainers.image.title="aggregator-dpg-web" \
      org.opencontainers.image.description="Blue Dots Aggregator Portal (Next.js)" \
      org.opencontainers.image.source="https://github.com/sanketika-labs/aggregator-dpg" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.licenses="UNLICENSED"

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

WORKDIR /app

# Next.js standalone output already prunes node_modules to the bare minimum.
# Copy in standalone server, static assets, and public/ — chown to non-root.
COPY --from=builder --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=builder --chown=node:node /app/apps/web/.next/static     ./apps/web/.next/static
COPY --from=builder --chown=node:node /app/apps/web/public           ./apps/web/public
# Participant JSON Schemas are loaded at runtime by the public /r/[slug]
# page. Next's output-file tracer doesn't pick them up because they're
# read via dynamic `path.resolve(...)`, so copy them explicitly. Copying
# the whole `config/` tree pulls in both the shared aggregator schemas
# (`config/schemas/aggregator/`) and every per-network folder (e.g.
# `config/blue_dot/schemas/participant/`); the active network is picked
# via `SCHEMA_ROOT_DIR` at runtime.
COPY --from=builder --chown=node:node /app/config                    ./config

USER node
EXPOSE 3000

CMD ["node", "apps/web/server.js"]
