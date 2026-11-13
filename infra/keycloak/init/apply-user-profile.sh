#!/bin/sh
# Post-import init for the (now combined, Phase B) realm:
#   1. Declare the phoneNumber/phoneNumberVerified user attributes, enable
#      Unmanaged Attributes, and relax `required` on email/firstName/lastName
#      so aggregator's other custom attributes (aggregator_id, aggregator_type,
#      decision_made, signalstack_org_id, etc.) and signals' phone-only /
#      one-word-name users all persist and can log in.
#   2. org_owner realm role + manage-realm grant (org hierarchy).
#   3. Apply SMTP server config from env vars (KC needs this for email OTP + verify).
#   4. aggregator-portal client: confidential + secret sync + protocol mappers.
#   5. Acting-org claim mappers on signals-ui / aggregator-dpg / voice-dpg (§5.1
#      of signals' migration design).
#
# KC 26 ignores `kc.user.profile.config` and `smtpServer` from realm import in
# some paths, so all of the above is (re-)applied via admin REST API after
# Keycloak is healthy, idempotently, on every boot — not just on first import.
#
# Merged (Phase B) from signals-dpg's own
# infra/keycloak/init/apply-user-profile.sh, which is now this script's
# superset — see that file's history for the original signals-only version.
# This is the single script that runs for the combined realm; signals-dpg's
# copy keeps serving only its own independent standalone stack.
set -eu

KC_URL="${KC_URL:-http://keycloak:8080}"
REALM="${KC_REALM:-bluedots}"
ADMIN_USER="${KC_BOOTSTRAP_ADMIN_USERNAME:-admin}"
ADMIN_PASS="${KC_BOOTSTRAP_ADMIN_PASSWORD:-admin}"
POLICY="${UNMANAGED_POLICY:-ENABLED}"

echo "[kc-init] waiting for keycloak at ${KC_URL}..."
i=0
until curl -fsS "${KC_URL}/realms/master/.well-known/openid-configuration" > /dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 60 ]; then
    echo "[kc-init] keycloak not reachable after 5min — aborting"
    exit 1
  fi
  sleep 5
done

echo "[kc-init] obtaining admin token..."
TOKEN=$(curl -fsS -X POST "${KC_URL}/realms/master/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=${ADMIN_USER}" \
  -d "password=${ADMIN_PASS}" \
  -d "grant_type=password" \
  -d "client_id=admin-cli" | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')

if [ -z "$TOKEN" ]; then
  echo "[kc-init] failed to obtain admin token"
  exit 1
fi

# ────────────────────────────────────────────────────────────
# 1) User profile: declare phoneNumber/phoneNumberVerified, enable Unmanaged
#    Attributes, and relax `required` on email/firstName/lastName.
#
#    Declaring phoneNumber/phoneNumberVerified explicitly (rather than relying
#    on the unmanaged policy alone) makes them first-class/searchable — the
#    migration's collision check depends on that. The unmanaged policy is the
#    belt-and-braces for everything else (aggregator_id, aggregator_type,
#    decision_made, signalstack_org_id, ...).
#
#    Relaxing `required` on email/firstName/lastName: Keycloak's default
#    profile marks all three required for the `user` role, which matches
#    neither DPG's data model — signals' `user.email` is nullable and
#    phone-only identities are first-class, and a one-word name legitimately
#    has no last name. With those requirements in place VERIFY_PROFILE fires
#    on first login and parks the user on "Update Account Information" (and
#    filling in email does NOT clear it, since lastName is still missing).
#
#    `unique_by` keeps the first of each name, and the realm's existing
#    entries come first — so an already-declared attribute keeps its own
#    settings.
# ────────────────────────────────────────────────────────────
PROFILE=$(curl -fsS "${KC_URL}/admin/realms/${REALM}/users/profile" \
  -H "Authorization: Bearer ${TOKEN}")

UPDATED=$(printf '%s' "$PROFILE" | jq --arg policy "$POLICY" '
  def relax:
    if (.name == "email" or .name == "firstName" or .name == "lastName")
    then del(.required)
    else . end;

  .unmanagedAttributePolicy = $policy
  | .attributes = (
      # The aggregator identity attributes drive the portal gate and the token
      # claims apps act on (aggregator_id, aggregator_type, signalstack_org_id,
      # signals_acting_orgs, roles); only the API'"'"'s service account writes them,
      # so they are declared admin-only. Forced: any earlier declaration is replaced.
      # `roles` is the user'"'"'s live role keys for the edge check
      # (docs/rbac/rbac-edge-enforcement.md §3.2), one value per role.
      ([(.attributes // [])[] | select(.name as $n | ["aggregator_id", "decision_made", "aggregator_type", "signalstack_org_id", "roles"] | index($n) | not)] + [
        { name: "aggregator_id", displayName: "Aggregator id", permissions: { view: ["admin"], edit: ["admin"] }, multivalued: false },
        { name: "decision_made", displayName: "Registration decision", permissions: { view: ["admin"], edit: ["admin"] }, multivalued: false },
        { name: "aggregator_type", displayName: "Aggregator type", permissions: { view: ["admin"], edit: ["admin"] }, multivalued: false },
        { name: "signalstack_org_id", displayName: "Signals organisation id", permissions: { view: ["admin"], edit: ["admin"] }, multivalued: false },
        { name: "roles", displayName: "Roles", permissions: { view: ["admin"], edit: ["admin"] }, multivalued: true },
        {
          name: "phoneNumber",
          displayName: "Phone Number",
          permissions: { view: ["admin", "user"], edit: ["admin", "user"] },
          multivalued: false
        },
        {
          name: "phoneNumberVerified",
          displayName: "Phone Number Verified",
          permissions: { view: ["admin", "user"], edit: ["admin", "user"] },
          multivalued: false
        }
      ]) | unique_by(.name) | map(relax)
    )
  ')

HTTP=$(curl -s -o /tmp/up-resp.json -w "%{http_code}" -X PUT \
  "${KC_URL}/admin/realms/${REALM}/users/profile" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  --data "${UPDATED}")

if [ "$HTTP" != "200" ]; then
  echo "[kc-init] user-profile PUT failed: HTTP ${HTTP}"
  cat /tmp/up-resp.json || true
  exit 1
fi

# Verify rather than trust — a write that looks fine has silently no-op'd
# before (KC 26 ignoring kc.user.profile.config from realm import is exactly
# that failure mode).
VERIFY=$(curl -fsS "${KC_URL}/admin/realms/${REALM}/users/profile" \
  -H "Authorization: Bearer ${TOKEN}")
HAS_PHONE=$(printf '%s' "$VERIFY" | jq -r '[.attributes[]? | select(.name == "phoneNumber")] | length')
GOT_POLICY=$(printf '%s' "$VERIFY" | jq -r '.unmanagedAttributePolicy // "unset"')
STILL_REQUIRED=$(printf '%s' "$VERIFY" | jq -r '[.attributes[]? | select(.name == "email" or .name == "firstName" or .name == "lastName") | select(has("required")) | .name] | join(",")')

echo "[kc-init] unmanagedAttributePolicy=${GOT_POLICY} phoneNumber declared=${HAS_PHONE}"

ADMIN_ONLY=$(printf '%s' "$VERIFY" | jq -r '[.attributes[]? | select(.name as $n | ["aggregator_id", "decision_made", "aggregator_type", "signalstack_org_id", "roles"] | index($n)) | select(.permissions.edit == ["admin"])] | length')
if [ "${ADMIN_ONLY:-0}" -lt 5 ]; then
  echo "[kc-init] aggregator_id / decision_made / aggregator_type / signalstack_org_id / roles are not all declared admin-only"
  exit 1
fi

if [ "${HAS_PHONE:-0}" -lt 1 ]; then
  echo "[kc-init] phoneNumber is still not declared — OTP login would silently fail"
  exit 1
fi

if [ -n "$STILL_REQUIRED" ]; then
  echo "[kc-init] still required for role user: ${STILL_REQUIRED}"
  echo "[kc-init] phone-only users and one-word names would be parked on the"
  echo "[kc-init] 'Update Account Information' screen at first login"
  exit 1
fi
echo "[kc-init] email/firstName/lastName optional — phone-only login is viable"

# ────────────────────────────────────────────────────────────
# 1b) org hierarchy: org_owner realm role + service-account grant
#
# realm.json is only consulted on first import, so these are re-applied
# idempotently here for realms that already exist in postgres. Both are
# required on every instance (organisations are always on since migration 0028):
#   - org_owner realm role: assigned to the org-owner user at org approval.
#   - aggregator-api service account needs realm-management:manage-realm
#     (in addition to manage-users) to create/manage the org's KC group.
# Placed before the SMTP early-exit below so they always run.
# ────────────────────────────────────────────────────────────
API_CLIENT_ID="${API_CLIENT_ID:-aggregator-api}"

# --- 1b-i. ensure org_owner realm role exists ---
ROLE_HTTP=$(curl -s -o /dev/null -w "%{http_code}" \
  "${KC_URL}/admin/realms/${REALM}/roles/org_owner" -H "Authorization: Bearer ${TOKEN}")
if [ "$ROLE_HTTP" = "200" ]; then
  echo "[kc-init] realm role 'org_owner' already present — skip"
else
  HTTP=$(curl -s -o /tmp/role-resp.json -w "%{http_code}" -X POST \
    "${KC_URL}/admin/realms/${REALM}/roles" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json" \
    --data '{"name":"org_owner","description":"Parent-org owner (org hierarchy). Assigned to the org-owner user at org approval."}')
  if [ "$HTTP" = "201" ]; then
    echo "[kc-init] realm role 'org_owner' created"
  else
    echo "[kc-init] realm role 'org_owner' create FAILED: HTTP ${HTTP}"
    cat /tmp/role-resp.json || true
  fi
fi

# --- 1b-ii. grant realm-management:manage-realm to the API service account ---
API_UUID=$(curl -fsS "${KC_URL}/admin/realms/${REALM}/clients?clientId=${API_CLIENT_ID}" \
  -H "Authorization: Bearer ${TOKEN}" | jq -r '.[0].id // empty')
RM_UUID=$(curl -fsS "${KC_URL}/admin/realms/${REALM}/clients?clientId=realm-management" \
  -H "Authorization: Bearer ${TOKEN}" | jq -r '.[0].id // empty')
if [ -z "$API_UUID" ] || [ -z "$RM_UUID" ]; then
  echo "[kc-init] '${API_CLIENT_ID}' or realm-management client not found — skip manage-realm grant"
else
  SA_UID=$(curl -fsS "${KC_URL}/admin/realms/${REALM}/clients/${API_UUID}/service-account-user" \
    -H "Authorization: Bearer ${TOKEN}" | jq -r '.id // empty')
  HAS_MR=$(curl -fsS \
    "${KC_URL}/admin/realms/${REALM}/users/${SA_UID}/role-mappings/clients/${RM_UUID}" \
    -H "Authorization: Bearer ${TOKEN}" | jq -r '[.[] | select(.name == "manage-realm")] | length')
  if [ -z "$SA_UID" ]; then
    echo "[kc-init] service-account user for '${API_CLIENT_ID}' not found — skip manage-realm grant"
  elif [ "${HAS_MR:-0}" -gt 0 ]; then
    echo "[kc-init] service account already has realm-management:manage-realm — skip"
  else
    MR_ROLE=$(curl -fsS \
      "${KC_URL}/admin/realms/${REALM}/clients/${RM_UUID}/roles/manage-realm" \
      -H "Authorization: Bearer ${TOKEN}")
    HTTP=$(curl -s -o /tmp/mr-resp.json -w "%{http_code}" -X POST \
      "${KC_URL}/admin/realms/${REALM}/users/${SA_UID}/role-mappings/clients/${RM_UUID}" \
      -H "Authorization: Bearer ${TOKEN}" \
      -H "Content-Type: application/json" \
      --data "[${MR_ROLE}]")
    if [ "$HTTP" = "204" ] || [ "$HTTP" = "200" ]; then
      echo "[kc-init] granted realm-management:manage-realm to '${API_CLIENT_ID}' service account"
    else
      echo "[kc-init] manage-realm grant FAILED: HTTP ${HTTP}"
      cat /tmp/mr-resp.json || true
    fi
  fi
fi

# ────────────────────────────────────────────────────────────
# 2) SMTP server config
# ────────────────────────────────────────────────────────────
if [ -z "${SMTP_HOST:-}" ]; then
  echo "[kc-init] SMTP_HOST empty — skipping smtpServer config"
  exit 0
fi

# Derive starttls/ssl from SMTP_SECURE + port. Gmail 587 → starttls. 465 → ssl.
SSL="false"
STARTTLS="false"
case "${SMTP_PORT:-587}" in
  465) SSL="true" ;;
  587) STARTTLS="true" ;;
  *) [ "${SMTP_SECURE:-false}" = "true" ] && SSL="true" ;;
esac
AUTH="false"
[ -n "${SMTP_USER:-}" ] && AUTH="true"

# Build smtpServer JSON. Escape password spaces by JSON-encoding via sh.
SMTP_JSON=$(cat <<EOF
{
  "host": "${SMTP_HOST}",
  "port": "${SMTP_PORT:-587}",
  "from": "${SMTP_FROM:-no-reply@example.com}",
  "fromDisplayName": "${SMTP_FROM_DISPLAY:-Aggregator}",
  "ssl": "${SSL}",
  "starttls": "${STARTTLS}",
  "auth": "${AUTH}",
  "user": "${SMTP_USER:-}",
  "password": "${SMTP_PASSWORD:-}"
}
EOF
)

# Fetch full realm rep, splice in smtpServer, PUT back.
REALM_REP=$(curl -fsS "${KC_URL}/admin/realms/${REALM}" -H "Authorization: Bearer ${TOKEN}")

# Use python (available in curl image? no — curlimages is alpine sh). Use jq if present, else fallback sed.
if command -v jq > /dev/null 2>&1; then
  UPDATED_REALM=$(echo "$REALM_REP" | jq --argjson s "$SMTP_JSON" '.smtpServer = $s')
else
  # crude splice: remove existing smtpServer block then inject after opening brace
  STRIPPED=$(echo "$REALM_REP" | sed -E 's/,?"smtpServer":\{[^}]*\}//')
  UPDATED_REALM=$(echo "$STRIPPED" | sed 's/^{/{"smtpServer":'"$(echo "$SMTP_JSON" | tr -d '\n' | tr -s ' ')"',/')
fi

HTTP=$(curl -s -o /tmp/smtp-resp.json -w "%{http_code}" -X PUT \
  "${KC_URL}/admin/realms/${REALM}" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  --data "${UPDATED_REALM}")

if [ "$HTTP" != "204" ] && [ "$HTTP" != "200" ]; then
  echo "[kc-init] smtpServer PUT failed: HTTP ${HTTP}"
  cat /tmp/smtp-resp.json || true
  exit 1
fi

echo "[kc-init] smtpServer configured: ${SMTP_HOST}:${SMTP_PORT:-587} (ssl=${SSL} starttls=${STARTTLS} auth=${AUTH})"

# ────────────────────────────────────────────────────────────
# 3) aggregator-portal client: enforce confidential + mappers
#
# realm.json is only consulted on first realm import. When the realm
# already exists in postgres (e.g. an upgrade from a pre-merge stack),
# any changes to client config or protocolMappers in realm.json are NOT
# applied automatically. This block re-applies them idempotently on
# every boot:
#   - publicClient=false + clientAuthenticatorType=client-secret
#   - client secret = $OIDC_CLIENT_SECRET (must match the BFF env var)
#   - protocol mappers for decision_made + phone_number (required by
#     requireApproved middleware on the API)
# ────────────────────────────────────────────────────────────

PORTAL_CLIENT_ID="${PORTAL_CLIENT_ID:-aggregator-portal}"

# Use jq — the alpine entrypoint installs it. A greedy sed match here would
# pick up the LAST `id` field in the JSON (a protocolMapper UUID), not the
# client UUID, and the next call would 404.
PORTAL_UUID=$(curl -fsS "${KC_URL}/admin/realms/${REALM}/clients?clientId=${PORTAL_CLIENT_ID}" \
  -H "Authorization: Bearer ${TOKEN}" | jq -r '.[0].id // empty')

if [ -z "$PORTAL_UUID" ]; then
  echo "[kc-init] portal client '${PORTAL_CLIENT_ID}' not found — skip client/mapper reconcile"
else
  # --- 3a. publicClient + secret ----------------------------------------
  if [ -n "${OIDC_CLIENT_SECRET:-}" ]; then
    PORTAL_REP=$(curl -fsS "${KC_URL}/admin/realms/${REALM}/clients/${PORTAL_UUID}" \
      -H "Authorization: Bearer ${TOKEN}")
    if command -v jq > /dev/null 2>&1; then
      UPDATED_PORTAL=$(echo "$PORTAL_REP" | jq --arg s "$OIDC_CLIENT_SECRET" \
        '.publicClient = false | .clientAuthenticatorType = "client-secret" | .secret = $s')
    else
      # fallback: jq is installed by the keycloak-init entrypoint, so this
      # branch is defensive — we just leave the client config alone.
      UPDATED_PORTAL=""
    fi
    if [ -n "$UPDATED_PORTAL" ]; then
      HTTP=$(curl -s -o /tmp/portal-resp.json -w "%{http_code}" -X PUT \
        "${KC_URL}/admin/realms/${REALM}/clients/${PORTAL_UUID}" \
        -H "Authorization: Bearer ${TOKEN}" \
        -H "Content-Type: application/json" \
        --data "${UPDATED_PORTAL}")
      if [ "$HTTP" = "204" ] || [ "$HTTP" = "200" ]; then
        echo "[kc-init] portal client: publicClient=false, secret synced from OIDC_CLIENT_SECRET"
      else
        echo "[kc-init] portal client update FAILED: HTTP ${HTTP}"
        cat /tmp/portal-resp.json || true
      fi
    fi
  else
    echo "[kc-init] OIDC_CLIENT_SECRET empty — leaving portal client publicClient/secret untouched"
  fi

  # --- 3b. protocol mappers --------------------------------------------
  ensure_mapper() {
    mapper_name="$1"
    user_attr="$2"
    claim_name="$3"
    userinfo_claim="$4"
    multivalued="${5:-false}"
    existing=$(curl -fsS "${KC_URL}/admin/realms/${REALM}/clients/${PORTAL_UUID}/protocol-mappers/models" \
      -H "Authorization: Bearer ${TOKEN}" \
      | jq -r --arg n "${mapper_name}" '[.[] | select(.name == $n)] | length')
    if [ "$existing" -gt 0 ]; then
      echo "[kc-init] mapper '${mapper_name}' already present — skip"
      return 0
    fi
    PAYLOAD=$(cat <<EOF
{
  "name": "${mapper_name}",
  "protocol": "openid-connect",
  "protocolMapper": "oidc-usermodel-attribute-mapper",
  "consentRequired": false,
  "config": {
    "user.attribute": "${user_attr}",
    "claim.name": "${claim_name}",
    "jsonType.label": "String",
    "id.token.claim": "false",
    "access.token.claim": "true",
    "userinfo.token.claim": "${userinfo_claim}",
    "multivalued": "${multivalued}",
    "aggregate.attrs": "false"
  }
}
EOF
)
    HTTP=$(curl -s -o /tmp/mapper-resp.json -w "%{http_code}" \
      -X POST "${KC_URL}/admin/realms/${REALM}/clients/${PORTAL_UUID}/protocol-mappers/models" \
      -H "Authorization: Bearer ${TOKEN}" \
      -H "Content-Type: application/json" \
      --data "${PAYLOAD}")
    if [ "$HTTP" = "201" ]; then
      echo "[kc-init] mapper '${mapper_name}' created"
    else
      echo "[kc-init] mapper '${mapper_name}' create FAILED: HTTP ${HTTP}"
      cat /tmp/mapper-resp.json || true
    fi
  }

  ensure_mapper "decision_made" "decision_made" "decision_made" "false"
  ensure_mapper "phone_number"  "phoneNumber"   "phone_number"  "true"
  # Live role keys for the edge check; access token only, one value per role.
  ensure_mapper "roles"         "roles"         "roles"         "false" "true"
fi

# ────────────────────────────────────────────────────────────────────────────
# 5) Acting-org claim mappers (§5.1 of signals' migration design; merged in
#    from signals-dpg's own apply-user-profile.sh, Phase B)
#
# Same reason as everything above: the realm JSON is only consulted on FIRST
# import, so a realm that already exists in Keycloak's database never picks up
# newly-added protocol mappers. Re-applied here idempotently.
#
# The claim is `signals_acting_orgs` — the set of signals org ids a caller may
# assert via `x-acting-org-id`. `signals-api` deliberately gets none: it is the
# admin/provisioning client, not an acting-org caller.
# ────────────────────────────────────────────────────────────────────────────

ensure_acting_org_mapper() {
  target_client="$1"
  mapper_json="$2"

  client_uuid=$(curl -fsS "${KC_URL}/admin/realms/${REALM}/clients?clientId=${target_client}" \
    -H "Authorization: Bearer ${TOKEN}" | jq -r '.[0].id // empty')

  if [ -z "$client_uuid" ]; then
    echo "[kc-init] client '${target_client}' not found — skipping acting-org mapper"
    return 0
  fi

  existing=$(curl -fsS \
    "${KC_URL}/admin/realms/${REALM}/clients/${client_uuid}/protocol-mappers/models" \
    -H "Authorization: Bearer ${TOKEN}" \
    | jq -r '[.[] | select(.name == "signals_acting_orgs")] | length')

  if [ "${existing:-0}" -gt 0 ]; then
    echo "[kc-init] ${target_client}: signals_acting_orgs mapper already present — skip"
    return 0
  fi

  http=$(curl -s -o /tmp/kc-mapper-resp.json -w "%{http_code}" -X POST \
    "${KC_URL}/admin/realms/${REALM}/clients/${client_uuid}/protocol-mappers/models" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json" \
    --data "${mapper_json}")

  if [ "$http" = "201" ]; then
    echo "[kc-init] ${target_client}: signals_acting_orgs mapper created"
  else
    echo "[kc-init] ${target_client}: mapper create FAILED: HTTP ${http}"
    cat /tmp/kc-mapper-resp.json || true
    return 1
  fi
}

# Human tokens: read the org from the same `signalstack_org_id` user attribute
# aggregator's approval flow already populates. Inert for a signals participant,
# who has no such attribute — the claim is simply omitted.
ensure_acting_org_mapper signals-ui '{
  "name": "signals_acting_orgs",
  "protocol": "openid-connect",
  "protocolMapper": "oidc-usermodel-attribute-mapper",
  "consentRequired": false,
  "config": {
    "user.attribute": "signalstack_org_id",
    "claim.name": "signals_acting_orgs",
    "jsonType.label": "String",
    "id.token.claim": "false",
    "access.token.claim": "true",
    "userinfo.token.claim": "false",
    "multivalued": "false",
    "aggregate.attrs": "false"
  }
}'

# Service clients: a wildcard grant, preserving today's platform-wide reach for
# the integrating DPGs as an explicit, auditable grant. TODO(§5.1, Phase D):
# replace with an enumerated org list once the set each DPG legitimately
# serves is known.
for svc in aggregator-dpg voice-dpg; do
  ensure_acting_org_mapper "$svc" '{
    "name": "signals_acting_orgs",
    "protocol": "openid-connect",
    "protocolMapper": "oidc-hardcoded-claim-mapper",
    "consentRequired": false,
    "config": {
      "claim.name": "signals_acting_orgs",
      "claim.value": "*",
      "jsonType.label": "String",
      "id.token.claim": "false",
      "access.token.claim": "true",
      "access.tokenResponse.claim": "false"
    }
  }'
done

echo "[kc-init] acting-org claim mappers ready."

# ────────────────────────────────────────────────────────────────────────────
# 6) Per-client login theme
#
# `loginTheme` is a REALM-level setting, and since the Phase B merge one realm
# serves both DPGs — so both apps rendered the same login page and signals
# visitors were shown the aggregator's title and hero copy. Keycloak's
# per-client `login_theme` attribute is the override.
#
# Set here as well as in the realm JSON for the usual reason: the JSON is only
# read on FIRST import, so realms already in Postgres would never pick it up.
#
# aggregator-portal needs no entry — the realm default `otp` is already its
# theme. Only the override is applied.
# ────────────────────────────────────────────────────────────────────────────

ensure_login_theme() {
  target_client="$1"
  theme_name="$2"

  client_uuid=$(curl -fsS "${KC_URL}/admin/realms/${REALM}/clients?clientId=${target_client}" \
    -H "Authorization: Bearer ${TOKEN}" | jq -r '.[0].id // empty')

  if [ -z "$client_uuid" ]; then
    echo "[kc-init] client '${target_client}' not found — skipping login theme"
    return 0
  fi

  current=$(curl -fsS "${KC_URL}/admin/realms/${REALM}/clients/${client_uuid}" \
    -H "Authorization: Bearer ${TOKEN}" | jq -r '.attributes.login_theme // empty')

  if [ "$current" = "$theme_name" ]; then
    echo "[kc-init] ${target_client}: login theme already '${theme_name}' — skip"
    return 0
  fi

  # Merge into the existing attributes rather than PUTting a bare object — the
  # client already carries pkce.code.challenge.method and
  # post.logout.redirect.uris, and dropping those would break its login and
  # logout flows.
  curl -fsS "${KC_URL}/admin/realms/${REALM}/clients/${client_uuid}" \
    -H "Authorization: Bearer ${TOKEN}" \
    | jq --arg theme "$theme_name" '.attributes.login_theme = $theme' \
    > /tmp/kc-client-theme.json

  http=$(curl -s -o /tmp/kc-theme-resp.json -w "%{http_code}" -X PUT \
    "${KC_URL}/admin/realms/${REALM}/clients/${client_uuid}" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json" \
    --data @/tmp/kc-client-theme.json)

  if [ "$http" != "204" ]; then
    echo "[kc-init] ${target_client}: login theme PUT FAILED: HTTP ${http}"
    cat /tmp/kc-theme-resp.json || true
    return 1
  fi

  # Verify rather than trust — see the note at the top of section 1. A 204 on a
  # client update does not guarantee the attribute survived.
  applied=$(curl -fsS "${KC_URL}/admin/realms/${REALM}/clients/${client_uuid}" \
    -H "Authorization: Bearer ${TOKEN}" | jq -r '.attributes.login_theme // empty')

  if [ "$applied" != "$theme_name" ]; then
    echo "[kc-init] ${target_client}: login theme did NOT persist (got '${applied:-<unset>}', wanted '${theme_name}')"
    return 1
  fi

  echo "[kc-init] ${target_client}: login theme set to '${theme_name}'"
}

ensure_login_theme signals-ui signals

echo "[kc-init] per-client login themes ready."
