# Postgres 17 with BOTH pgvector and PostGIS.
#
# WHY: signals-dpg's `db:init` (apps/api/scripts/db_init.ts → create_items.sql)
# runs `CREATE EXTENSION vector` AND `CREATE EXTENSION postgis`. No single stock
# image ships both, and the official `postgis/postgis` image has NO arm64 build
# (breaks on Apple Silicon). So we base on `pgvector/pgvector:pg17` (multi-arch,
# already has pgvector) and add PostGIS from the PGDG apt repo the base image
# already configures.
FROM pgvector/pgvector:pg17

RUN apt-get update \
  && apt-get install -y --no-install-recommends postgresql-17-postgis-3 \
  && rm -rf /var/lib/apt/lists/*
