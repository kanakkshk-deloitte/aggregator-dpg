#!/usr/bin/env bash
# Pre-deploy runner for migration 0025 (`contact` table) on an EXISTING instance.
#
# SUPERSEDED for the user & org instance upgrade: deployed instances (all at
# 0022) migrate with the instance-upgrade tool (`node dist/tools/instance-upgrade.js`, see
# docs/user-org-migration-runbook.md), which covers 0023 onwards in
# one window. This script and scripts/sql/contact-*.sql only understand the
# schema BEFORE migration 0027 (`aggregators`, `aggregator_orgs.contact_id`);
# they are kept for databases still on that path and removed with the train.
#
# Phase 1 ships as one release, deployed stop-the-world. The migration file IS
# the script: `apply` runs apps/api/drizzle/migrations/0025_contact.sql with
# psql; the release's first API boot re-runs it through drizzle (a no-op) and
# then applies 0026, which drops the legacy columns. A fresh instance does not
# need this script; its first boot creates everything.
#
# Run it from a checkout of the RELEASE TAG you are about to deploy, so the SQL
# you pre-apply is byte-identical to what the pods will run.
#
# Usage:
#   ./scripts/contact-migrate.sh preflight   # read-only report; exit 1 if any blocking count > 0
#   ./scripts/contact-migrate.sh dry-run     # apply + verify inside a transaction, then ROLLBACK;
#                                            # exit non-zero if 0025 or the verify gate fails
#   ./scripts/contact-migrate.sh apply       # apply for real (single transaction)
#   ./scripts/contact-migrate.sh verify      # read-only V1–V6 report; exit 1 if V1 or V2 > 0,
#                                            # or V4 > 0 while the legacy columns exist
#
# Runbook (docs/contact-migration-runbook.md):
#   preflight + dry-run (may run while live) → scale api + worker to 0 →
#   DB snapshot → apply → verify → deploy the API at 1 replica (its boot
#   applies 0026) → verify → start the worker, scale up → owner-name backfill.
#
# Postgres — pick ONE (read from the environment or the project .env):
#   DATABASE_URL   postgres://user:pass@host:port/db   (uses local psql)
#   PG_CONTAINER   docker container name              (uses `docker exec psql`)
#                  with PG_USER / PG_DB (default POSTGRES_USER / POSTGRES_DB)
#   PSQL_CMD       full command prefix, e.g. "kubectl exec -i pod/psql -- psql -U app -d aggregator"
#
# Run it as the application role that owns the tables, or as a role that may
# SET ROLE to it (e.g. a superuser): 0025 switches to the table owner itself so
# everything it creates stays writable by the app, and refuses any other role.
# Needs PostgreSQL 14+ (CREATE OR REPLACE TRIGGER).
#
# Needs bash + psql (or docker / kubectl) and python3 (only to read .env).
# PSQL_CMD is word-split, so it cannot carry quoted arguments with spaces.
#
# The script never writes drizzle's __drizzle_migrations table; the API boot
# records 0025 there when it re-runs the (now no-op) file.

set -euo pipefail

MODE="${1:-}"
case "$MODE" in
  preflight | dry-run | apply | verify) ;;
  *)
    awk 'NR > 1 && !/^#/ { exit } NR > 1' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MIGRATION="$ROOT/apps/api/drizzle/migrations/0025_contact.sql"
PREFLIGHT="$ROOT/scripts/sql/contact-preflight.sql"
VERIFY="$ROOT/scripts/sql/contact-verify.sql"

for f in "$MIGRATION" "$PREFLIGHT" "$VERIFY"; do
  [[ -f "$f" ]] || { echo "missing $f" >&2; exit 1; }
done

# ─── Load DB settings from .env (only the keys this script reads) ────────────
_KEYS="DATABASE_URL PG_CONTAINER PG_USER PG_DB POSTGRES_USER POSTGRES_DB PSQL_CMD"
for _envfile in "$ROOT/.env" "$PWD/.env"; do
  if [[ -f "$_envfile" ]]; then
    _exports=$(KEYS="$_KEYS" ENVFILE="$_envfile" python3 -c '
import os, re, shlex
keys = set(os.environ["KEYS"].split())
with open(os.environ["ENVFILE"]) as fh:
    for line in fh:
        m = re.match(r"\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$", line)
        if not m or m.group(1) not in keys or m.group(1) in os.environ:
            continue
        v = m.group(2)
        if len(v) >= 2 and v[0] == v[-1] and v[0] in ("\"", "'"'"'"):
            v = v[1:-1]
        print("export {}={}".format(m.group(1), shlex.quote(v)))
')
    [[ -n "$_exports" ]] && eval "$_exports"
    break
  fi
done

PSQL_FLAGS=(-X -v ON_ERROR_STOP=1)
if [[ -n "${PSQL_CMD:-}" ]]; then
  # shellcheck disable=SC2206
  PSQL=($PSQL_CMD)
elif [[ -n "${DATABASE_URL:-}" ]]; then
  command -v psql >/dev/null || { echo "psql not found on PATH" >&2; exit 1; }
  PSQL=(psql "$DATABASE_URL")
elif [[ -n "${PG_CONTAINER:-}" ]]; then
  PSQL=(docker exec -i "$PG_CONTAINER" psql -U "${PG_USER:-${POSTGRES_USER:-aggregator}}" -d "${PG_DB:-${POSTGRES_DB:-aggregator}}")
else
  echo "set DATABASE_URL, PG_CONTAINER or PSQL_CMD" >&2
  exit 1
fi

# ─── Exit-code gates (one number each; the human-readable reports stay as is) ─
# Blocking pre-flight count: the same checks 0025's first-creation guard runs
# (scripts/sql/contact-preflight.sql rows 1–4).
PREFLIGHT_GATE_SQL="WITH src AS (
  SELECT lower(btrim(contact->>'email')) AS e, contact->>'phone' AS p FROM aggregators
  UNION ALL
  SELECT lower(btrim(owner_email)), owner_phone FROM aggregator_orgs)
SELECT (SELECT count(*) FROM (SELECT e FROM src GROUP BY e HAVING count(DISTINCT coalesce(p, '')) > 1) a)
     + (SELECT count(*) FROM (SELECT p FROM src WHERE p IS NOT NULL GROUP BY p HAVING count(DISTINCT e) > 1) b)
     + (SELECT count(*) FROM src WHERE p IS NOT NULL AND p !~ '^\\+[0-9]{10,15}\$')
     + (SELECT count(*) FROM src WHERE coalesce(e, '') = '')"
# V1 + V2 (scripts/sql/contact-verify.sql).
VERIFY_GATE_SQL="SELECT (SELECT count(*) FROM aggregators WHERE contact_id IS NULL)
     + (SELECT count(*) FROM aggregator_orgs WHERE contact_id IS NULL)
     + (SELECT count(*) FROM contact WHERE id <> contact_id_of(email, phone))"
# V4 (scripts/sql/contact-verify-legacy.sql) — only while the legacy columns exist.
VERIFY_LEGACY_GATE_SQL="SELECT (SELECT count(*) FROM aggregators a JOIN contact c ON c.id = a.contact_id
         WHERE a.contact IS NOT NULL
           AND (lower(btrim(a.contact->>'email')) IS DISTINCT FROM c.email
             OR (a.contact->>'phone') IS DISTINCT FROM c.phone
             OR (CASE WHEN btrim(a.contact->>'name') <> '' THEN a.contact->>'name' END) IS DISTINCT FROM c.name
             OR (a.contact - 'name' - 'phone' - 'email') IS DISTINCT FROM a.contact_extra))
     + (SELECT count(*) FROM aggregator_orgs o JOIN contact c ON c.id = o.contact_id
         WHERE o.owner_email IS NOT NULL
           AND (lower(btrim(o.owner_email)) IS DISTINCT FROM c.email
             OR o.owner_phone IS DISTINCT FROM c.phone))"

# Prints the single value of query "$1".
scalar() {
  local query="$1"
  printf '%s;\n' "$query" | "${PSQL[@]}" "${PSQL_FLAGS[@]}" -At
}

sha() {
  local file="$1"
  if command -v sha256sum >/dev/null; then sha256sum "$file"; else shasum -a 256 "$file"; fi
}
echo "0025_contact.sql sha256: $(sha "$MIGRATION" | cut -d' ' -f1)"
echo "mode: $MODE"
echo "database: $(scalar "SELECT current_database() || ' as ' || current_user")"

# Files are streamed on stdin so the same invocation works for local psql,
# `docker exec -i` and `kubectl exec -i` alike.
# 0025 is the EXPAND step. Once 0026 has dropped the legacy columns it must not
# be re-applied (it would try to relax columns that no longer exist).
LEGACY_COLUMN_SQL="SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='aggregators' AND column_name='contact'"
if [[ "$MODE" == "apply" || "$MODE" == "dry-run" || "$MODE" == "preflight" ]]; then
  legacy=$(scalar "$LEGACY_COLUMN_SQL")
  if [[ "$legacy" == "0" ]]; then
    echo "the legacy contact columns are already dropped (migration 0026) — nothing to pre-apply; use: $0 verify" >&2
    exit 1
  fi
fi

case "$MODE" in
  preflight)
    "${PSQL[@]}" "${PSQL_FLAGS[@]}" < "$PREFLIGHT"
    blocking=$(scalar "$PREFLIGHT_GATE_SQL")
    if [[ "$blocking" != "0" ]]; then
      echo "preflight FAILED: $blocking blocking row(s) — fix them before apply (0025 would refuse)" >&2
      exit 1
    fi
    echo "preflight OK: no blocking rows"
    ;;
  verify)
    if [[ "$(scalar "SELECT to_regclass('public.contact') IS NOT NULL")" != "t" ]]; then
      echo "table \"contact\" does not exist yet — run: $0 apply" >&2
      exit 1
    fi
    "${PSQL[@]}" "${PSQL_FLAGS[@]}" < "$VERIFY"
    bad=$(scalar "$VERIFY_GATE_SQL")
    legacy=$(scalar "$LEGACY_COLUMN_SQL")
    if [[ "$legacy" != "0" ]]; then
      "${PSQL[@]}" "${PSQL_FLAGS[@]}" < "$ROOT/scripts/sql/contact-verify-legacy.sql"
      bad=$((bad + $(scalar "$VERIFY_LEGACY_GATE_SQL")))
    fi
    if [[ "$bad" != "0" ]]; then
      echo "verify FAILED: V1 + V2$([[ "$legacy" != "0" ]] && echo " + V4") = $bad (must be 0)" >&2
      exit 1
    fi
    echo "verify OK"
    ;;
  dry-run)
    # The gate raises inside the transaction, so psql exits non-zero; the
    # transaction is rolled back either way.
    { echo 'BEGIN;'; cat "$MIGRATION"; echo; cat "$VERIFY"; echo; cat "$ROOT/scripts/sql/contact-verify-legacy.sql"; echo
      printf 'DO $gate$ DECLARE n bigint; BEGIN\n  SELECT (%s) + (%s) INTO n;\n  IF n > 0 THEN RAISE EXCEPTION %s, n; END IF;\nEND $gate$;\n' \
        "$VERIFY_GATE_SQL" "$VERIFY_LEGACY_GATE_SQL" "'dry-run verify FAILED: V1 + V2 + V4 = % (must be 0)'"
      echo 'ROLLBACK;'; } \
      | "${PSQL[@]}" "${PSQL_FLAGS[@]}"
    echo "dry-run complete — rolled back, nothing changed"
    ;;
  apply)
    "${PSQL[@]}" "${PSQL_FLAGS[@]}" --single-transaction < "$MIGRATION"
    echo "applied — now run: $0 verify"
    ;;
  *)
    # Unreachable: MODE is validated at the top of the script.
    echo "unknown mode: $MODE" >&2
    exit 2
    ;;
esac
