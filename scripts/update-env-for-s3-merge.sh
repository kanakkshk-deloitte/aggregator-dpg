#!/usr/bin/env bash
#
# Idempotent .env updater for the develop-merge + MinIO→S3 swap.
#
# - Backs up the existing .env to .env.bak.<timestamp>
# - Comments out MINIO_ROOT_USER / MINIO_ROOT_PASSWORD lines (does NOT delete,
#   so you can recover values if needed)
# - Appends S3_* + new feature env vars only if they're not already present
#
# Run with:  bash scripts/update-env-for-s3-merge.sh
# Re-run safely — adding a line twice is prevented by the grep guards.

set -euo pipefail

ENV_FILE=".env"
TS="$(date +%Y%m%d-%H%M%S)"
BAK=".env.bak.${TS}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found at $(pwd)/$ENV_FILE" >&2
  exit 1
fi

echo "→ Backing up $ENV_FILE → $BAK"
cp -p "$ENV_FILE" "$BAK"

# ─── 1. Comment out MINIO_* lines (preserves values for rollback) ───────────
echo "→ Commenting out MINIO_* lines (kept under # MIGRATED-OUT prefix)"
sed -i -E 's/^(MINIO_ROOT_USER=.*)$/# MIGRATED-OUT \1/; s/^(MINIO_ROOT_PASSWORD=.*)$/# MIGRATED-OUT \1/' "$ENV_FILE"

# ─── 2. Append new env vars only if missing ─────────────────────────────────
append_if_missing() {
  local key="$1"
  local default="$2"
  local comment="$3"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    echo "  • ${key} already present — leaving untouched"
  else
    if [[ -n "$comment" ]]; then
      printf '\n# %s\n%s=%s\n' "$comment" "$key" "$default" >> "$ENV_FILE"
    else
      printf '%s=%s\n' "$key" "$default" >> "$ENV_FILE"
    fi
    echo "  • added ${key}=${default}"
  fi
}

# Add a section header once
if ! grep -q "# ── object storage (AWS S3, IAM role) ──" "$ENV_FILE"; then
  printf '\n# ── object storage (AWS S3, IAM role) ──────────────────────────\n' >> "$ENV_FILE"
fi

append_if_missing "S3_REGION" "ap-south-1" "AWS S3 region"
append_if_missing "S3_BUCKET" "aggregator-bulk-uploads" "Bucket holding CSVs, QR PNGs, errors.csv"
append_if_missing "S3_FORCE_PATH_STYLE" "false" "false=virtual-hosted-style (AWS S3 default)"

if ! grep -q "# ── new feature env (bulk uploads, QR, cron) ──" "$ENV_FILE"; then
  printf '\n# ── new feature env (bulk uploads, QR, cron) ───────────────────\n' >> "$ENV_FILE"
fi

append_if_missing "BULK_UPLOAD_URL_TTL_SECONDS" "900" ""
append_if_missing "BULK_UPLOAD_MAX_BYTES" "10485760" ""
append_if_missing "PUBLIC_LINK_BASE_URL" "" ""
append_if_missing "BULK_MAX_ROWS" "10000" ""
append_if_missing "BULK_MAX_ROW_BYTES" "65536" ""
append_if_missing "LINK_METRICS_ROLLUP_INTERVAL_MS" "300000" ""
append_if_missing "WATCHDOG_INTERVAL_MS" "3600000" ""

if ! grep -q "# ── BFF service token (anonymous-proxy routes) ──" "$ENV_FILE"; then
  printf '\n# ── BFF service token (anonymous-proxy routes) ─────────────────\n' >> "$ENV_FILE"
fi

append_if_missing "BFF_SERVICE_CLIENT_ID" "" "blank → falls back to KEYCLOAK_ADMIN_CLIENT_ID"
append_if_missing "BFF_SERVICE_CLIENT_SECRET" "" "blank → falls back to KEYCLOAK_ADMIN_CLIENT_SECRET"

chmod 600 "$ENV_FILE"
echo
echo "→ Done. Backup at $BAK"
echo "→ Summary of MINIO + S3 lines now in $ENV_FILE:"
grep -E "^#? ?MINIO|^S3_|^BULK_|^QR_|^WATCHDOG_|^LINK_METRICS_|^BFF_SERVICE_|^PUBLIC_LINK_BASE_URL" "$ENV_FILE" | sed 's/^/    /'
