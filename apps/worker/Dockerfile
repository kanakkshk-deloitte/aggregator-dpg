# syntax=docker/dockerfile:1
#
# Bulk-upload worker (BullMQ consumer) — same monorepo as the API, different
# entrypoint. Builds the worker package + its workspace deps, then prunes to a
# production image.

# Build stages use the DHI *dev* variant — the only one carrying a shell, apk,
# corepack and npm. The runner below uses the hardened variant, which has none of
# them, so no RUN is possible past that FROM.
FROM dhi.io/node:24-alpine-dev AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

# ── installer: resolve workspace deps ────────────────────────────────────────
# Copy the full repo so every workspace dep's package.json is present for
# pnpm to resolve the worker subgraph. Filter scopes the install to that
# subgraph — unrelated packages skipped.
FROM base AS installer
WORKDIR /app
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts --filter "@aggregator-dpg/worker..."

# ── builder: compile workspace + worker ──────────────────────────────────────
# pnpm runs `build` topologically across the worker subgraph.
FROM installer AS builder
RUN pnpm --filter "@aggregator-dpg/worker..." build

# ── deployer: prune to prod deps (workspace dist/ already present) ───────────
FROM builder AS deployer
RUN pnpm deploy --filter @aggregator-dpg/worker --prod --legacy /standalone

# ── runner: minimal runtime ──────────────────────────────────────────────────
FROM dhi.io/node:24-alpine AS runner
# Hardened runtime: no shell, no apk, no npm/corepack. Ships an unprivileged
# `node` user at uid 1000, matching the deploy charts' runAsUser.
#
# DEPLOY NOTE: liveness probe restored via HEALTH_PORT (aggregator-dpg#675) —
# see helm/aggregator/charts/worker in bluedots-automation for the httpGet probe.
WORKDIR /app
COPY --from=deployer --chown=node:node /standalone .
# Worker reads JSON Schemas from /app/config at runtime (participant validator).
COPY --from=builder --chown=node:node /app/config ./config
USER node
EXPOSE 8080
CMD ["node", "dist/main.js"]
