#!/usr/bin/env sh
# Fills every CHANGE_ME_* placeholder in local-setup/.env with a freshly
# generated random value.
#
#   cp .env.example .env
#   ./gen-secrets.sh
#
# Values are written to `.env` only — never back into `.env.example`, which is
# committed. Re-running is safe: already-filled values are left alone, so it
# will not invalidate data encrypted under an existing SIGNALS_PII_KEY.
#
# Everything gets `openssl rand -hex 32` except SIGNALS_SEARCH_API_KEY (an
# sk_signals_ apikey) and SIGNALS_PII_KEY, which the
# signals API requires to be base64 decoding to exactly 32 bytes (AES-256).
# SIGNALS_SEARCH_API_KEY_HASH is re-derived from SIGNALS_SEARCH_API_KEY on every
# run: the seed stores only the hash, so the two must never drift.
set -eu

# Every file this script creates holds secrets in cleartext, including the
# shell-redirected scratch file in the loop below — which mktemp does not cover.
# Set the umask before anything is created rather than chmod-ing after, so there
# is no window where the file is readable by others.
umask 077

ENV_FILE="${1:-$(dirname "$0")/.env}"

if [ ! -f "$ENV_FILE" ]; then
  echo "No $ENV_FILE — run: cp .env.example .env" >&2
  exit 1
fi

# One pattern for both finding placeholders and, at the end, proving none are
# left. Tolerates `export ` and leading whitespace so a line this script cannot
# rewrite is never silently treated as absent. Anchored at the start of the
# line, so the `CHANGE_ME_*` mentions in the file's own header comment are not
# matched.
PLACEHOLDER_RE='^[[:space:]]*\(export[[:space:]][[:space:]]*\)\{0,1\}\([A-Za-z0-9_]\{1,\}\)=CHANGE_ME_'

remaining() { sed -n "s/${PLACEHOLDER_RE}.*\$/\\2/p" "$1"; }

vars=$(remaining "$ENV_FILE")

tmp=$(mktemp)
trap 'rm -f "$tmp" "$tmp.next"' EXIT INT TERM
cp "$ENV_FILE" "$tmp"

for name in $vars; do
  case "$name" in
    SIGNALS_PII_KEY) value=$(openssl rand -base64 32) ;;
    # signals apikeys carry the sk_signals_ prefix the seed script uses.
    SIGNALS_SEARCH_API_KEY) value="sk_signals_$(openssl rand -hex 24)" ;;
    # Derived from the key below, after the key itself is filled in.
    SIGNALS_SEARCH_API_KEY_HASH) continue ;;
    *)               value=$(openssl rand -hex 32) ;;
  esac
  # `value` is hex or base64, so the only character needing care in the sed
  # replacement is base64's `/`; `|` is not in either alphabet, so use it as
  # the delimiter and escape nothing else.
  sed "s|^\\([[:space:]]*\\(export[[:space:]][[:space:]]*\\)\\{0,1\\}\\)${name}=CHANGE_ME_.*\$|\\1${name}=${value}|" \
    "$tmp" > "$tmp.next"
  mv "$tmp.next" "$tmp"
  echo "  generated $name"
done

# The apikey table's format: SHA-256 of the raw key, base64url, no padding.
key=$(sed -n 's/^[[:space:]]*SIGNALS_SEARCH_API_KEY=//p' "$tmp")
if [ -n "$key" ] && grep -q '^[[:space:]]*SIGNALS_SEARCH_API_KEY_HASH=' "$tmp"; then
  hash=$(printf %s "$key" | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')
  sed "s|^\([[:space:]]*\)SIGNALS_SEARCH_API_KEY_HASH=.*\$|\1SIGNALS_SEARCH_API_KEY_HASH=${hash}|" \
    "$tmp" > "$tmp.next"
  mv "$tmp.next" "$tmp"
  echo "  derived SIGNALS_SEARCH_API_KEY_HASH"
fi

# Prove the work rather than assume it. A placeholder that the substitution
# missed would otherwise survive into `.env` under a success message — the exact
# false all-clear this script exists to prevent.
missed=$(remaining "$tmp" | tr '\n' ' ')
if [ -n "$missed" ]; then
  echo "gen-secrets.sh: these placeholders were not replaced: ${missed}" >&2
  echo "$ENV_FILE left unchanged. Fix them by hand, or report the line format." >&2
  exit 1
fi

cat "$tmp" > "$ENV_FILE"
chmod 600 "$ENV_FILE"
echo "Wrote $(echo "$vars" | wc -w | tr -d ' ') secrets into $ENV_FILE (mode 600)."
