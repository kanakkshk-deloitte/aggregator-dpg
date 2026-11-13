#!/usr/bin/env bash
# Helper library for the `aggregator-e2e` skill.
#
# Source it, don't execute it:  source .claude/skills/aggregator-e2e/lib/e2e-helpers.sh
#
# Everything here is idempotent and read-only against the app; the only writes
# are the seed helpers (clearly named `seed_*`) and they all tag their rows with
# $E2E_TAG so `e2e_cleanup` can find them again. Nothing here edits a tracked
# file or a `.env` — the stack is configured with inline env vars so a run can
# never leave the developer's config mutated.
#
# Portability note: no `seq`, `timeout`, or other optional coreutils — this file
# gets sourced into whatever interactive shell the developer has, and a reshaped
# PATH (nvm, asdf) can leave those missing. Arithmetic `for (( ))` loops instead.
#
# Style note: positional parameters are assigned to named locals on entry and
# every function ends with an explicit `return`, so the control flow stays
# readable and the exit status is never an accident of the last command.

set -uo pipefail

# ---------------------------------------------------------------- configuration

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
export REPO_ROOT

# Docker-only mode: everything behind nginx, self-signed cert, login works.
export BASE_URL="${BASE_URL:-https://localhost}"
export API_URL="${API_URL:-$BASE_URL/backend}"
export MAILPIT_URL="${MAILPIT_URL:-http://localhost:8025}"
export PG_CONTAINER="${PG_CONTAINER:-aggregator-postgres}"
export NETWORK="${AGGREGATOR_NETWORK:-blue_dot}"

# Every seeded row carries this tag so cleanup is exact rather than a guess.
export E2E_TAG="${E2E_TAG:-e2e-$(date +%s)}"

# `curl` against the stack: -k because the local cert is self-signed.
c() {
  curl -sk "$@"
  return $?
}

# Status code only.
code() {
  curl -sk -o /dev/null -w '%{http_code}' "$@"
  return $?
}

psql_q() {
  local query="$1"
  docker exec "$PG_CONTAINER" psql -U aggregator -d aggregator -tAc "$query"
  return $?
}

# --------------------------------------------------------------------- reporting

E2E_PASS=0
E2E_FAIL=0
E2E_SKIP=0
E2E_RESULTS=()

# ok <name> <actual> <expected>  — records a pass/fail line.
ok() {
  local name="$1"
  local actual="$2"
  local expected="$3"
  if [[ "$actual" == "$expected" ]]; then
    E2E_PASS=$((E2E_PASS + 1))
    E2E_RESULTS+=("PASS | $name | $actual")
    echo "  PASS  $name ($actual)"
  else
    E2E_FAIL=$((E2E_FAIL + 1))
    E2E_RESULTS+=("FAIL | $name | got $actual want $expected")
    echo "  FAIL  $name — got $actual, want $expected"
  fi
  return 0
}

# skip <name> <why> — for a flow whose precondition is genuinely absent.
skip() {
  local name="$1"
  local why="$2"
  E2E_SKIP=$((E2E_SKIP + 1))
  E2E_RESULTS+=("SKIP | $name | $why")
  echo "  SKIP  $name — $why"
  return 0
}

e2e_report() {
  echo
  echo "================ AGGREGATOR E2E REPORT ================"
  printf '%s\n' "${E2E_RESULTS[@]}"
  echo "-------------------------------------------------------"
  echo "PASS=$E2E_PASS  FAIL=$E2E_FAIL  SKIP=$E2E_SKIP"
  echo "======================================================="
  [[ "$E2E_FAIL" -eq 0 ]]
  return $?
}

# ------------------------------------------------------------------ stack launch

# Brings the stack up in docker-only mode with the dev overlay (mailpit + host
# ports). Organisations are always on since migration 0028 (no flag).
stack_up() {
  if ! docker info >/dev/null 2>&1; then
    echo "Docker is not running. Start Docker Desktop, then re-run." >&2
    return 1
  fi
  # ALLOW_TRAIN_ON_BOOT: a dev/e2e database with data may migrate the user &
  # org instance upgrade at boot (never set it in a deployment).
  ( cd "$REPO_ROOT" && AGGREGATOR_NETWORK="$NETWORK" \
      ALLOW_TRAIN_ON_BOOT=true pnpm stack:up )
  return $?
}

# nginx crash-loops if it boots before the web container's DNS resolves, and it
# comes back with a 502 on /auth. One restart fixes it; this is not a retry loop
# hiding a real failure, it is the documented startup race.
fix_nginx_race() {
  if [[ "$(code "$BASE_URL/auth/realms/bluedots")" != "200" ]]; then
    ( cd "$REPO_ROOT" && docker compose restart nginx >/dev/null 2>&1 )
    sleep 5
  fi
  return 0
}

# Blocks until every dependency the suite needs is actually answering.
wait_for_stack() {
  local i
  for (( i = 0; i < 90; i++ )); do
    if [[ "$(code "$API_URL/health/ready")" == "200" ]]; then
      break
    fi
    sleep 2
  done
  fix_nginx_race
  echo "health/ready   -> $(code "$API_URL/health/ready")"
  echo "web /          -> $(code "$BASE_URL/")"
  echo "keycloak realm -> $(code "$BASE_URL/auth/realms/bluedots")"
  echo "mailpit        -> $(code "$MAILPIT_URL/api/v1/messages")"
  echo "config network -> $(c "$API_URL/v1/aggregator-config" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log((j.network&&j.network.id)||j.network_id)}catch(e){console.log("UNPARSEABLE")}})')"
  return 0
}

# ------------------------------------------------------------------------- mail
#
# Mailpit is the whole reason the OTP + approval flows are testable end to end:
# the dev overlay points the api, worker AND Keycloak at it, so every address is
# deliverable and nothing escapes to a real inbox.

mail_clear() {
  c -X DELETE "$MAILPIT_URL/api/v1/messages" >/dev/null
  return 0
}

# mail_wait_for <to-or-subject-substring> [timeout-s] — newest matching message ID.
mail_wait_for() {
  local needle="$1"
  local timeout="${2:-40}"
  local i id
  for (( i = 0; i < timeout; i++ )); do
    id=$(c "$MAILPIT_URL/api/v1/messages?limit=60" |
      node -e '
        let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
          const needle=process.argv[1].toLowerCase();
          try{
            const m=(JSON.parse(s).messages||[]).find(m=>
              JSON.stringify(m.To||[]).toLowerCase().includes(needle) ||
              (m.Subject||"").toLowerCase().includes(needle));
            if(m) console.log(m.ID);
          }catch(e){}
        })' "$needle")
    if [[ -n "$id" ]]; then
      echo "$id"
      return 0
    fi
    sleep 1
  done
  return 1
}

mail_body() {
  local id="$1"
  c "$MAILPIT_URL/api/v1/message/$id" |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write((j.Text||"")+"\n"+(j.HTML||""))})'
  return 0
}

# mail_newest_recipient — address the newest message actually went to. Use this
# when a routing rule decides the recipient (see mail_extract_review_url).
mail_newest_recipient() {
  c "$MAILPIT_URL/api/v1/messages?limit=1" |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const m=JSON.parse(s).messages[0];console.log(m.To[0].Address)}catch(e){}})'
  return 0
}

# mail_extract_otp <to> — the 6-digit code from a Keycloak OTP mail.
mail_extract_otp() {
  local to="$1"
  local id
  id=$(mail_wait_for "$to") || return 1
  mail_body "$id" | grep -oE '\b[0-9]{6}\b' | head -1
  return 0
}

# mail_extract_review_url <to> — the signed review link from a review mail.
# Prints the *api* URL (PUBLIC_API_URL/admin/v1/.../read/<id>?token=...).
#
# MIND THE RECIPIENT: a coordinator WITH a parent org routes to that org's
# OWNER email (spec §6.2/§9), not to ADMIN_EMAILS. Only the flat flow goes to
# the network-admin list. Passing the wrong needle here looks like "the mail
# never arrived" when it arrived at a different address — use
# `mail_newest_recipient` if you don't know which.
mail_extract_review_url() {
  local to="$1"
  local id
  id=$(mail_wait_for "$to") || return 1
  mail_body "$id" |
    grep -oE 'https?://[^"[:space:]<]+/admin/v1/[a-z-]+/read/[0-9a-f-]+\?token=[^"[:space:]<&]+' |
    head -1
  return 0
}

# mail_extract_link <to> <path-substring> — generic signed-link puller
# (invite links, grant links, registration links).
mail_extract_link() {
  local to="$1"
  local path="$2"
  local id
  id=$(mail_wait_for "$to") || return 1
  mail_body "$id" | grep -oE "https?://[^\"[:space:]<]*${path}[^\"[:space:]<]*" | head -1
  return 0
}

# --------------------------------------------------------------------- seeding
#
# Some flows need a precondition that is itself a different flow (a coordinator
# can't register without an ACTIVE org; an invite can't exist without an owner).
# Seeding those directly keeps a failure in flow A from cascading into a
# misleading failure in flow B. Each row is tagged with $E2E_TAG.
#
# Prefer driving the real UI/API when the flow itself is under test — seed only
# the preconditions.

# seed_active_org — prints the new org UUID.
# The owner is an identity-only admin account in `users` (migration 0027),
# linked to its `contact`; the org (an aggregator org under the network root,
# migration 0028) references it through org_owner.
seed_active_org() {
  psql_q "WITH c AS (
            INSERT INTO contact (id, email, name)
            VALUES (contact_id_of('$E2E_TAG-owner@example.org', NULL), '$E2E_TAG-owner@example.org', 'E2E Owner')
            ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email
            RETURNING id),
          u AS (
            INSERT INTO users (user_type, contact_id, status, profile, created_by, updated_by)
            SELECT 'admin', c.id, NULL, NULL, 'e2e', 'e2e' FROM c
            ON CONFLICT (contact_id, user_type) DO UPDATE SET updated_by = EXCLUDED.updated_by
            RETURNING id)
          INSERT INTO organisations (slug, name, org_type, parent_id, org_owner, status)
          SELECT '$E2E_TAG-org', 'E2E Org $E2E_TAG', 'aggregator',
                 (SELECT id FROM organisations WHERE org_type = 'network_facilitator'), u.id, 'active'
            FROM u
          RETURNING id;" | head -1 | tr -d '[:space:]'
  return 0
}

# seed_invite <org-id> [email] — prints JTI= and TOKEN= for a pending invite,
# minted with the api's own signer so the token is byte-identical to production.
seed_invite() {
  local org="$1"
  local email="${2:-$E2E_TAG-coord@example.org}"
  local script="$REPO_ROOT/apps/api/src/__e2e_mint_invite.ts"
  cat > "$script" <<'TS'
/** Generated by the aggregator-e2e skill. Removed by `e2e_cleanup`. */
import { getRegistrationInvitesStore } from './services/registration-invites-store/index.js';
import { mintInviteToken } from './services/invite-token.js';
const org = process.env.SEED_ORG_ID;
const email = process.env.SEED_EMAIL;
if (!org || !email) throw new Error('SEED_ORG_ID + SEED_EMAIL required');
const invites = getRegistrationInvitesStore();
const c = await invites.create({
  parentOrgId: org, email,
  expiresAt: new Date(Date.now() + 14 * 864e5),
  createdBy: 'e2e-skill',
});
if (!c.ok) throw new Error(JSON.stringify(c.error));
const { token } = await mintInviteToken({ jti: c.value.jti, org, email });
console.log('JTI=' + c.value.jti);
console.log('TOKEN=' + token);
process.exit(0);
TS
  # `pnpm exec` runs the workspace's own pinned tsx. Deliberately NOT `npx`,
  # which will fetch and execute a package (and its lifecycle scripts) from the
  # network if the binary happens to be missing.
  ( cd "$REPO_ROOT/apps/api" &&
    SEED_ORG_ID="$org" SEED_EMAIL="$email" \
    AGGREGATOR_NETWORK="$NETWORK" \
    INSTANCE_ENV=development NODE_ENV=development \
    pnpm exec tsx --env-file=.env src/__e2e_mint_invite.ts 2>/dev/null |
    grep -E '^(JTI|TOKEN)=' )
  rm -f "$script"
  return 0
}

# ------------------------------------------------------------------- cleanup

e2e_cleanup() {
  local org_ids
  rm -f "$REPO_ROOT/apps/api/src/__e2e_mint_invite.ts"
  # Match people through `contact` (0025) and their `users` accounts (0027).
  # Coordinators go first (an org with coordinators cannot be deleted, 0028).
  # Deleting an org releases its owner's admin account (organisations_owner_ad)
  # and the delete triggers GC the contact rows once nothing references them.
  org_ids=$(psql_q "SELECT o.id FROM organisations o
                      JOIN users u ON u.id = o.org_owner
                      JOIN contact c ON c.id = u.contact_id
                    WHERE o.slug LIKE '$E2E_TAG%' OR c.email LIKE '$E2E_TAG%';")
  psql_q "DELETE FROM users a USING contact c
          WHERE c.id = a.contact_id AND a.user_type = 'coordinator'
            AND c.email LIKE '$E2E_TAG%';" >/dev/null
  psql_q "DELETE FROM users WHERE user_type = 'coordinator'
            AND signalstack_org_name LIKE 'E2E %$E2E_TAG%';" >/dev/null
  psql_q "DELETE FROM registration_invites WHERE email LIKE '$E2E_TAG%';" >/dev/null
  psql_q "DELETE FROM organisations o USING users u, contact c
          WHERE u.id = o.org_owner AND c.id = u.contact_id AND o.org_type = 'aggregator'
            AND o.slug <> 'default' AND c.email LIKE '$E2E_TAG%';" >/dev/null
  psql_q "DELETE FROM organisations WHERE slug LIKE '$E2E_TAG%';" >/dev/null
  echo "cleaned rows tagged $E2E_TAG (orgs: $(echo "$org_ids" | tr '\n' ' '))"
  echo "NOTE: Keycloak users created by the run stay in the local dev realm."
  return 0
}
