#!/usr/bin/env bash
# Backfill the Keycloak `aggregator_type` user attribute from the Postgres
# `users.serves` column (its first domain; `type` before migration 0029) for
# any approved aggregator whose KC user is
# missing the attribute. One-shot helper — run once per environment.
#
# Auto-reads the project `.env` (repo root or CWD) so the same vars the API
# uses drive this script. Override per-invocation by exporting env vars before
# calling — exported values always win over .env.
#
# Usage:
#   ./scripts/backfill-kc-aggregator-type.sh
#
# Required env (read from .env or exported):
#   Postgres — pick ONE
#     DATABASE_URL         postgres://user:pass@host:port/db
#     PG_CONTAINER         docker container name (local fallback)
#
#   Keycloak — pick ONE auth method
#     a) Service account (recommended; mirrors what the API uses)
#        KEYCLOAK_URL                   e.g. http://keycloak:8080
#        KEYCLOAK_REALM                 e.g. aggregator
#        KEYCLOAK_ADMIN_CLIENT_ID       e.g. aggregator-api
#        KEYCLOAK_ADMIN_CLIENT_SECRET   from secrets store
#     b) Master-realm admin password (dev/local convenience)
#        KC_URL, KC_REALM, KC_ADMIN_USER, KC_ADMIN_PASS
#
# Requires: curl, python3, psql (when DATABASE_URL set) OR docker (when
# PG_CONTAINER set).

set -euo pipefail

# ─── Load .env (project root preferred, then CWD) ────────────────────────────
# Parse with python rather than `source` so values containing `$`, `#`, etc.
# don't blow up the shell. Only the keys this script actually reads are
# imported — keeps the shell environment clean and avoids leaking unrelated
# secrets into child processes.
_SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
_KEYS="KEYCLOAK_URL KEYCLOAK_REALM KEYCLOAK_ADMIN_CLIENT_ID KEYCLOAK_ADMIN_CLIENT_SECRET KC_BOOTSTRAP_ADMIN_USERNAME KC_BOOTSTRAP_ADMIN_PASSWORD POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB DATABASE_URL PG_CONTAINER"
for _envfile in "$_SCRIPT_DIR/../.env" "$PWD/.env"; do
  if [[ -f "$_envfile" ]]; then
    _exports=$(KEYS="$_KEYS" ENVFILE="$_envfile" python3 -c '
import os, re, shlex, sys
keys = set(os.environ["KEYS"].split())
with open(os.environ["ENVFILE"]) as fh:
    for line in fh:
        m = re.match(r"\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$", line)
        if not m: continue
        k, v = m.group(1), m.group(2)
        if k not in keys: continue
        # Strip wrapping quotes if present.
        if len(v) >= 2 and v[0] == v[-1] and v[0] in ("\"", "'"'"'"):
            v = v[1:-1]
        if k not in os.environ:
            print("export {}={}".format(k, shlex.quote(v)))
')
    if [[ -n "$_exports" ]]; then eval "$_exports"; fi
    echo "Loaded env: $_envfile"
    break
  fi
done

# Map API-side env var names to the script's internal vars. Already-exported
# script vars win (env wins over .env wins over defaults).
KC_URL="${KC_URL:-${KEYCLOAK_URL:-http://localhost:8080}}"
KC_REALM="${KC_REALM:-${KEYCLOAK_REALM:-aggregator}}"
KC_CLIENT_ID="${KC_CLIENT_ID:-${KEYCLOAK_ADMIN_CLIENT_ID:-}}"
KC_CLIENT_SECRET="${KC_CLIENT_SECRET:-${KEYCLOAK_ADMIN_CLIENT_SECRET:-}}"
KC_ADMIN_USER="${KC_ADMIN_USER:-${KC_BOOTSTRAP_ADMIN_USERNAME:-admin}}"
KC_ADMIN_PASS="${KC_ADMIN_PASS:-${KC_BOOTSTRAP_ADMIN_PASSWORD:-admin}}"

# DATABASE_URL might already be set; fall back to PG_CONTAINER for local docker.
PG_CONTAINER="${PG_CONTAINER:-aggregator-postgres}"
PG_USER="${PG_USER:-${POSTGRES_USER:-aggregator}}"
PG_DB="${PG_DB:-${POSTGRES_DB:-aggregator}}"

# Coordinators are `users` rows since migration 0027 (was `aggregators`).
SQL="SELECT id, serves[1] FROM users WHERE user_type = 'coordinator' AND serves[1] IN ('seeker','provider');"

# ─── Read aggregators from Postgres ─────────────────────────────────────────
if [[ -n "${DATABASE_URL:-}" ]]; then
  command -v psql >/dev/null || { echo "psql not found on PATH"; exit 1; }
  rows=$(psql "$DATABASE_URL" -t -A -F '|' -c "$SQL")
else
  command -v docker >/dev/null || { echo "DATABASE_URL not set and docker missing"; exit 1; }
  rows=$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -t -A -F '|' -c "$SQL")
fi

# ─── Mint a KC admin token ──────────────────────────────────────────────────
# Prefer the service-account credentials the API already uses (cleaner audit,
# no master-realm shell creds floating around). Fall back to password grant
# for local dev where the service-account secret may be blank.
if [[ -n "$KC_CLIENT_ID" ]] && [[ -n "$KC_CLIENT_SECRET" ]]; then
  echo "Auth: service-account ${KC_CLIENT_ID} on realm ${KC_REALM}"
  TOKEN=$(curl -fsS -X POST "${KC_URL}/realms/${KC_REALM}/protocol/openid-connect/token" \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    -d "grant_type=client_credentials&client_id=${KC_CLIENT_ID}&client_secret=${KC_CLIENT_SECRET}" \
    | python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])")
else
  echo "Auth: master-realm admin user ${KC_ADMIN_USER}"
  TOKEN=$(curl -fsS -X POST "${KC_URL}/realms/master/protocol/openid-connect/token" \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    -d "grant_type=password&client_id=admin-cli&username=${KC_ADMIN_USER}&password=${KC_ADMIN_PASS}" \
    | python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])")
fi

if [[ -z "$rows" ]]; then
  echo "No typed aggregators found."; exit 0
fi

while IFS='|' read -r AGG_ID AGG_TYPE; do
  [[ -z "$AGG_ID" ]] && continue
  echo "→ ${AGG_ID} (${AGG_TYPE})"

  user_payload=$(curl -fsS -H "Authorization: Bearer $TOKEN" \
    "${KC_URL}/admin/realms/${KC_REALM}/users?q=aggregator_id:${AGG_ID}&exact=true")
  user_id=$(printf '%s' "$user_payload" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d[0]['id'] if d else '')")
  if [[ -z "$user_id" ]]; then
    echo "   no KC user — skip"; continue
  fi

  # Merge attributes: preserve existing ones + set aggregator_type.
  merged=$(printf '%s' "$user_payload" | AGG_TYPE="$AGG_TYPE" python3 -c "
import sys,json,os
u = json.load(sys.stdin)[0]
attrs = u.get('attributes', {}) or {}
attrs['aggregator_type'] = [os.environ['AGG_TYPE']]
print(json.dumps({'attributes': attrs}))
")
  http=$(curl -s -o /dev/null -w '%{http_code}' -X PUT \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    "${KC_URL}/admin/realms/${KC_REALM}/users/${user_id}" -d "$merged")
  if [[ "$http" = "204" ]]; then
    echo "   ✓ set aggregator_type=${AGG_TYPE} on KC user ${user_id}"
  else
    echo "   ✗ KC update failed (HTTP ${http})"
  fi
done <<< "$rows"

echo "Done. Users must sign out + back in to refresh the access token."
