#!/bin/sh
# Runs once, on first initialisation of an EMPTY Postgres data volume.
# The official postgres image executes every *.sh / *.sql in
# /docker-entrypoint-initdb.d after the primary POSTGRES_DB is created.
#
# NOTE: postgres:17-alpine has NO bash — this MUST be #!/bin/sh, and the file
# should be executable (chmod +x). If it fails here, only the primary
# POSTGRES_DB gets created and signals/keycloak connections will error with
# 'database "signals" does not exist'.
#
# We host three logical databases on one Postgres server:
#   - ${POSTGRES_DB}  (default: aggregator)  -> already created by the image
#   - signals                                -> signals-dpg (DPG / Signals Stack)
#   - keycloak                               -> Keycloak realm/user storage
#
# If you `docker compose down -v` (wipes the volume) this re-runs cleanly.
set -eu

for db in signals keycloak; do
  echo "postgres-init: ensuring database '${db}' exists"
  psql -v ON_ERROR_STOP=1 --username "${POSTGRES_USER}" --dbname "${POSTGRES_DB}" <<-EOSQL
		SELECT 'CREATE DATABASE ${db}'
		WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${db}')\gexec
	EOSQL
done

echo "postgres-init: done (aggregator + signals + keycloak databases ready)"
