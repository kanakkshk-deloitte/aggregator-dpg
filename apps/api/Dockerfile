# syntax=docker/dockerfile:1

# Build stages use the DHI *dev* variant — the only one carrying a shell, apk,
# corepack and npm. The runner below uses the hardened variant, which has none of
# them, so no RUN is possible past that FROM.
FROM dhi.io/node:24-alpine-dev AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

# ── installer: resolve and cache workspace deps ───────────────────────────────
# Copy the full repo so every workspace dep's package.json is present for
# pnpm to resolve the api subgraph (api + all its transitive workspace deps).
# Filter scopes the install to that subgraph — unrelated packages skipped.
FROM base AS installer
WORKDIR /app
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts --filter "@aggregator-dpg/api..."

# ── builder: compile TypeScript ───────────────────────────────────────────────
# pnpm runs `build` topologically across the api subgraph, ensuring every
# workspace dep is compiled before the api itself.
FROM installer AS builder
RUN pnpm --filter "@aggregator-dpg/api..." build

# ── deployer: prune to production deps only ───────────────────────────────────
# Inherit FROM builder so workspace deps' dist/ is present when pnpm deploy
# resolves their files.
FROM builder AS deployer
RUN pnpm deploy --filter @aggregator-dpg/api --prod --legacy /standalone

# ── runner: minimal runtime image ─────────────────────────────────────────────
FROM dhi.io/node:24-alpine AS runner
# Hardened runtime: no shell, no apk, no npm/corepack. The previous
# `RUN addgroup … && adduser …` cannot run here — and is unnecessary: the image
# already ships an unprivileged `node` user at uid 1000, which is exactly the
# runAsUser the deploy charts set for this service, so the two now agree
# (`appuser` was a system-range uid that never matched).
WORKDIR /app
COPY --from=deployer --chown=node:node /standalone .
# Schemas are loaded from config/ at runtime by registration-validator.
COPY --from=builder --chown=node:node /app/config ./config
# Drizzle migrations are read at runtime by db/migrate.ts (resolved via
# `../../drizzle/migrations` relative to dist/db/, i.e. /app/drizzle/migrations).
COPY --from=builder --chown=node:node /app/apps/api/drizzle ./drizzle
# Operator SQL for the instance-upgrade tool (dist/tools/instance-upgrade.js resolves it at
# `../../sql`, i.e. /app/sql): the checks, verify gates, counts and fixes.
COPY --from=builder --chown=node:node /app/scripts/sql ./sql
# RBAC policy for the OPA sidecar, and the Envoy edge config: a deploy's init
# container copies them out of this image, so the sidecars run what this build
# was tested with. rbac.rego serves the API's own decisions; edge.rego and the
# route table (edge/routes.json) serve the edge (docs/rbac/rbac-edge-enforcement.md);
# envoy.yaml is the edge's template, filled in by the init container.
COPY --from=builder --chown=node:node /app/policy/rbac/rbac.rego ./policy/rbac/rbac.rego
COPY --from=builder --chown=node:node /app/policy/rbac/edge.rego ./policy/rbac/edge.rego
COPY --from=builder --chown=node:node /app/policy/rbac/edge/routes.json ./policy/rbac/edge/routes.json
COPY --from=builder --chown=node:node /app/infra/envoy/envoy.yaml ./policy/envoy/envoy.yaml
USER node
EXPOSE 4000
CMD ["node", "dist/server.js"]
