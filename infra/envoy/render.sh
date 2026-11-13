#!/bin/sh
# Starts Envoy from the infra/envoy/envoy.yaml template (compose stacks).
#
# Replaces each placeholder (a variable name between double underscores) with
# that environment variable, refuses to start when one is unset, then runs
# Envoy on the result with the arguments this script was given. The
# deployment's init container applies the same rule (bluedots-automation).
#
# Usage: render.sh [envoy args...]
#   TEMPLATE (default /etc/envoy/envoy.template.yaml), OUT (default /tmp/envoy.yaml)
set -eu

TEMPLATE="${TEMPLATE:-/etc/envoy/envoy.template.yaml}"
OUT="${OUT:-/tmp/envoy.yaml}"

cp "$TEMPLATE" "$OUT"
for name in $(grep -o '__[A-Z_]*__' "$TEMPLATE" | sort -u | sed 's/^__//; s/__$//'); do
  value=$(printenv "$name" || true)
  if [ -z "$value" ]; then
    echo "render.sh: $name is not set (needed by $TEMPLATE)" >&2
    exit 1
  fi
  # `|` is the sed delimiter; none of the values (hosts, ports, URLs) contain it.
  sed -i "s|__${name}__|${value}|g" "$OUT"
done

exec envoy -c "$OUT" "$@"
