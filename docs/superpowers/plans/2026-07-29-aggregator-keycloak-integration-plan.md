# Plan: aggregator-dpg integration with signals-dpg's Keycloak implementation

**Status:** Draft for review
**Date:** 2026-07-29
**Scope:** changes in `aggregator-dpg`; companion to
`2026-07-23-keycloak-migration-design.md` (signals side, Builds 0–4 shipped in #423)

> Point-in-time record. Written from a read of aggregator-dpg at the time signals
> #423 landed. Where this plan and that repo disagree later, the repo wins.

---

## 1. What has to change, and why

signals-dpg now authenticates against a **shared `bluedots` realm** with its own
clients, validates `aud`/`azp`, accepts client-credentials bearer on the service
path, and can bound acting-org by token claim. Three consequences for aggregator:

1. **The realm is renamed.** `aggregator` → `bluedots`, one realm per instance
   shared by both DPGs (design §3.1). This is rollout step **R0** and blocks
   everything else.
2. **Service auth changes credential.** aggregator's calls into signals move
   from `x-api-key` to a client-credentials bearer (design §5).
3. **Acting-org becomes claim-bounded.** The `x-acting-org-id` header is
   unchanged, but signals will stop trusting it on its own (design §5.1).

### What does _not_ change

- aggregator's own login flow, OIDC clients, or `AuthContext`. Renaming the realm
  changes the issuer URL, not the mechanism.
- The `x-acting-org-id` header itself — same name, same value, still sent.
- `organization`/`member` remain signals-local. Nothing becomes a Keycloak group.

---

## 2. Current state in aggregator-dpg (verified)

| Thing                           | Where                                                                                                                                                           | Note                                                                                                              |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Realm export                    | `infra/keycloak/realms/aggregator-realm.json`                                                                                                                   | realm `aggregator`; clients `aggregator-portal`, `aggregator-api`; role `org_owner`                               |
| OTP SPI jar                     | `infra/keycloak/providers/keycloak-otp-1.0.0-SNAPSHOT.jar`                                                                                                      | now **also** vendored in signals-dpg                                                                              |
| OTP themes                      | `infra/keycloak/themes/otp/`                                                                                                                                    | now **also** vendored in signals-dpg                                                                              |
| Post-import fixup               | `infra/keycloak/init/apply-user-profile.sh`                                                                                                                     | unmanaged attrs, SMTP, `org_owner`, `manage-realm`, portal mappers                                                |
| Outbound signals client         | `packages/signalstack-writer/src/http.ts`                                                                                                                       | sends `x-api-key` (:106) + `x-acting-org-id`                                                                      |
| Writer factory                  | `apps/api/src/services/signalstack.ts`                                                                                                                          | gated on `SIGNALSTACK_BASE_URL` + `SIGNALSTACK_ADMIN_KEY`                                                         |
| **Client-credentials template** | `apps/web/src/lib/service-token.ts`                                                                                                                             | cache + 30s refresh lead, `aggregator-bff` client — **mirror this, don't invent**                                 |
| Keycloak admin client           | `apps/api/src/services/idp-admin/keycloak.ts`                                                                                                                   | exists; used for user attrs                                                                                       |
| Realm-name surface              | 14 files, **+ `local-setup/LOCAL_SETUP.md`** (not previously counted — e.g. the Track B snippet hardcodes `OIDC_ISSUER=http://keycloak:8080/realms/aggregator`) | compose ×3, `.env.example` ×4, init + backfill scripts, `apps/web/src/lib/oidc`, `service-token.ts`, 3 test files |

### Three composes, not one — standalone compose kept for now

| Compose                                         | Runs                                                                            | Realm today  | Fate                                                                                                                                                                                                                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aggregator-dpg/docker-compose.yml`             | aggregator only (+ nginx at `/auth`)                                            | `aggregator` | **Kept as-is for now (revised).** Earlier draft of this plan retired it (Phase A0); that's reversed — no changes to this file in this pass. Its realm identity (stay `aggregator`, or also move to `bluedots`) is deferred to a later decision. See Open Questions. |
| `aggregator-dpg/local-setup/docker-compose.yml` | **both DPGs** — `sd-keycloak`, `signals-api`, `signals-ui`, `signals-bootstrap` | `aggregator` | Owns the merged `bluedots` realm (Phase B — ownership decided).                                                                                                                                                                                                     |
| `signals-dpg/local-setup/docker-compose.yml`    | signals only                                                                    | `bluedots`   | **Unchanged.** signals keeps its own independent realm for its own standalone stack — this plan does not touch it.                                                                                                                                                  |

**The unified compose is where the merge belongs.** It already runs signals-api
and signals-ui against one Keycloak — but imports aggregator's realm, which has
no `signals-ui`/`signals-api` clients. So signals' Keycloak login is currently
impossible in the unified stack. That is the concrete bug this plan fixes.

Because the standalone compose stays, Phase B's merged realm still has to be
scoped so it doesn't leak into or conflict with that file — they remain two
separate realm identities (`aggregator` there, `bluedots` in `local-setup/`)
until the deferred decision above is made. Note the shape mismatch this
preserves: aggregator's standalone Keycloak sets `KC_HTTP_RELATIVE_PATH=/auth`
behind nginx; `local-setup/`'s does not. Not a blocker for Phase B (different
compose, different realm), but relevant whenever the deferred decision is
revisited.

### No Helm in this repo

`aggregator-dpg` has no `helm/` directory, so there is no k8s realm plumbing to
change here. Deployment-side realm config is out of scope for this plan.

---

## 3. Conventions the implementation must follow

`aggregator-dpg/.claude/rules/` is always-loaded and non-negotiable. The ones
that bear on this work:

- **`configuration-discipline.md`** — new config goes through
  `@aggregator-dpg/config-loader` + `config/env/*.yaml`, not ad-hoc
  `process.env`. The existing `SIGNALSTACK_*` vars in `apps/api/src/config.ts`
  are the pattern to extend.
- **`interfaces.md` / `base-class-pattern.md`** — cross-package contracts are
  **abstract classes**, not TS `interface`s. `SignalStackWriterBase` already is
  one; a new token-provider contract must be too.
- **`error-handling.md`** — service methods return `Result<T, BaseError>` rather
  than throwing.
- **`testing-requirements.md`** — ≥70% coverage; dep-cruiser (`pnpm dep-check`)
  fails CI on cross-service impl imports.
- Conventional Commits + husky.

---

## 4. Phased plan

Each phase is independently mergeable and inert until the phase after it. The
signals side is already flag-gated (`AUTH_PROVIDER`, `KEYCLOAK_SERVICE_CLIENT_IDS`,
`ACTING_ORG_SOURCE`), so aggregator can adopt at its own pace.

### Phase A0 — Standalone compose: deferred, no action (revised)

**Superseded.** An earlier draft of this plan retired
`aggregator-dpg/docker-compose.yml` here. That's reversed: **the file stays
exactly as it is** — no rename, no deletion, no doc changes to it — until a
separate, later decision addresses it. Nothing in Phase A/B/C/D depends on this
file changing, so deferring it blocks nothing downstream. See Open Questions
for what that later decision needs to cover (its realm identity, and whether
it's still the intended VM/prod path).

### Phase A — Realm rename, name driven by network/domain (R0; blocks everything)

**Goal:** aggregator authenticates against a per-deployment realm (e.g.
`bluedots` for the `blue_dot` network) with no behaviour change.

**Naming correction (this revision):** the target realm name is **not** a
fixed literal. This repo already has a first-class per-deployment identity
axis — `AGGREGATOR_NETWORK` (`blue_dot`/`orange_dot`/…, see
`packages/network-config`, `config/README.md`) — and the realm name must
follow the same discipline: configurable per instance, never baked into a
checked-in file. `bluedots` is the _example_ value for the default `blue_dot`
network, not a constant every deployment gets.

1. **Implemented.** `infra/keycloak/realms/aggregator-realm.json` renamed to
   `infra/keycloak/realms/realm.json`. Its `"realm"` field is now the template
   placeholder `__KEYCLOAK_REALM__`, substituted by `render-realm.sh` at
   container boot from a required `KEYCLOAK_REALM` env var (fail-hard if
   unset — same treatment as the existing `__PUBLIC_BASE_URL__`/`__SMTP_*__`
   substitutions, added to `render-realm.sh`). `docker-compose.yml` and
   `local-setup/docker-compose.yml` pass `KEYCLOAK_REALM: ${KEYCLOAK_REALM:-bluedots}`
   into the `keycloak` service's environment (the `bluedots` here is a
   compose-level _default_, overridable per deployment via `.env` — the same
   pattern `AGGREGATOR_NETWORK:-blue_dot}` already uses, not a hardcoded
   constant). Client ids, the OTP browser flow, themes, SMTP and `org_owner`
   are untouched.
2. **Implemented.** Swept realm-name references across compose files,
   `.md` docs (`CLAUDE.md`, `SETUP.md`, `QUICKSTART.md`,
   `local-setup/LOCAL_SETUP.md`), code comments (`access-token.ts`,
   `attributes.ts`, `oidc/index.ts`, `keycloak.ts`), `infra/env.template` /
   `infra/env.local`, and the two integration/unit test files that reference
   a literal realm value. **Now complete (2026-07-31).** The env templates
   previously blocked by file-access permissions have been swept:
   `.env.example` (root) and `apps/api/.env.example` → `KEYCLOAK_REALM=bluedots`;
   `apps/web/.env.example` and `infra/env.local` → `OIDC_ISSUER=…/realms/bluedots`
   (the latter had contradicted its own `KEYCLOAK_REALM=bluedots` line).
   `apps/worker/.env.example` needed no realm change (it references no
   `KEYCLOAK_*`/`OIDC_*` var at all — but see the Phase C gap below).

   **Bug this sweep uncovered — the cause of the realm rename silently not
   taking effect.** `local-setup/.env.example` ended up defining
   `KEYCLOAK_REALM` **twice**: the new Phase A block near the top set
   `bluedots`, while the pre-existing `# ─── Keycloak (aggregator identity)`
   section further down still set `aggregator`. dotenv/compose are
   **last-one-wins**, so every stack built from this template — and every
   `.env` copied from it — booted realm `aggregator` while the file appeared
   to say `bluedots`. Confirmed live: `docker compose config` resolved
   `aggregator` for all six substitution sites, and Keycloak imported the
   merged realm under that name. The duplicate is removed and replaced with a
   comment warning against re-adding it. **Anyone with an existing `.env` must
   delete the stale second assignment by hand** — and, because Keycloak
   persists realms in Postgres and `--import-realm` skips an existing realm,
   must then `docker compose down -v` for the rename to take effect.

3. **Implemented.** The 14 test files that pinned `KEYCLOAK_REALM = 'aggregator'`
   as an arbitrary fixture string are now `'bluedots'` for consistency (the
   literal value doesn't affect what these unit tests assert, so this was a
   cosmetic-but-safe bulk update, verified green: 12 files / 94 tests).
4. **Not started.** **Migrate existing Keycloak users, preserving their ids.**
   Non-negotiable: aggregator's `aggregator_id`, `signalstack_org_id` and
   `decision_made` live as user attributes keyed to the Keycloak `sub`, and
   `AuthContext.userId` is that `sub`. Use signals' verified finding —
   `POST /users` on 26.5.5 **ignores** a supplied id; `partialImport` honours
   it. signals' script (`signals-dpg/apps/api/scripts/migrate_users_to_keycloak.ts`)
   is a DB→Keycloak migration (better-auth rows → Keycloak shells) — aggregator's
   case is Keycloak→Keycloak (existing `aggregator`-realm users → the renamed
   realm), a different shape of script that still needs writing. **Only
   matters for an environment with real existing users** (staging/prod); a
   fresh local-only stack has none to migrate.

**Reversible:** re-import under the old realm name until signals migrates users at R4.

**Gate:** aggregator login green against the new realm; every user attribute intact;
`§6.3 spike 2` overlap check run — no email/phone collision between aggregator's
users and signals' `user` rows.

### Phase B — Merge the realm in the unified local stack

**Goal:** one Keycloak, one `bluedots` realm, both DPGs' clients, in
`local-setup/docker-compose.yml`.

1. **Implemented.** Realm ownership — decided: aggregator-dpg. The combined
   realm (with both DPGs' users/roles/clients) is canonical in
   `aggregator-dpg/infra/keycloak/` — this reverses the plan's earlier "B1"
   lean toward signals-dpg. Rationale: `local-setup/` already lives in and is
   driven from aggregator-dpg, so it owns the realm it boots. **signals-dpg's
   own `infra/keycloak/realms/bluedots-realm.json` is untouched** — it keeps
   serving signals' independent standalone stack (§2's second table). The two
   realm files are deliberately separate artifacts from here on: aggregator's
   is the combined one; signals' is the standalone one. This settles design
   open question 6 in the opposite direction from that doc's default
   assumption — flag that back to the signals-side design if it hasn't
   accounted for it.
2. **Implemented.** Merged the client sets into aggregator's `realm.json`:
   `aggregator-portal`, `aggregator-api`, `aggregator-bff`, `signals-ui`,
   `signals-api`, `aggregator-dpg`, `voice-dpg` — the last four (plus the
   `signals_participant`/`signals_admin` realm roles and the
   `service-account-signals-api` user) copied verbatim from signals'
   `bluedots-realm.json`. Client secrets converted to render-realm.sh
   placeholders (`__SIGNALS_API_SECRET__`, `__SIGNALSTACK_CLIENT_SECRET__`,
   `__VOICE_DPG_SIGNALS_SECRET__`) rather than committing signals' dev literals
   — soft-defaulted in `render-realm.sh` (not fail-hard), since the standalone
   `docker-compose.yml` (Phase A0, deferred/untouched) imports this same realm
   template but never sets them and must keep booting unaffected.
3. **Implemented, unchanged.** OTP flow alias stayed `aggregator-otp-browser` —
   no rename needed, no import-order race (one realm file, one owner).
4. **Implemented.** Merged the two init scripts into aggregator's
   `init/apply-user-profile.sh`: replaced aggregator's crude sed-based
   unmanaged-attributes block with signals' jq-based one (declares
   `phoneNumber`/`phoneNumberVerified`, **relaxes `required` on
   email/firstName/lastName**, verifies rather than trusts), kept aggregator's
   SMTP/`org_owner`/`manage-realm`/portal-mapper blocks as-is, and appended
   signals' acting-org claim-mapper block (`signals-ui` gets a
   `signalstack_org_id`-sourced mapper; `aggregator-dpg`/`voice-dpg` get the
   hardcoded `"*"` grant — this is also Phase D step 1, arriving for free).
5. **Implemented.** `local-setup/docker-compose.yml`'s `signals-api` (+
   `signals-bootstrap`, sharing the `&signals-env` anchor) now gets
   `AUTH_PROVIDER` (default `dual`), `KEYCLOAK_BASE_URL`,
   `KEYCLOAK_REALM`, `KEYCLOAK_API_CLIENT_ID=signals-api`,
   `KEYCLOAK_API_CLIENT_SECRET`. **Caveat surfaced by this wiring, not resolved
   by it:** signals' own `resolveUiAuthProvider` (`apps/ui/src/lib/keycloak-config.ts`)
   maps `dual` to _still show the OTP screen by default_ — flipping the
   visible login UI needs `AUTH_PROVIDER=keycloak` or signals' own
   `VITE_AUTH_PROVIDER` canary override, neither of which this phase sets.
   `dual` is the correct safe default to land on (matches signals' own
   R2/R3 rollout step), just don't expect the UI to visibly change yet.
6. **Implemented.** Updated `local-setup/LOCAL_SETUP.md` §9: prose now
   describes the shared realm + both client sets + the `dual`-mode caveat
   above, and the cross-DPG bullet notes the bearer migration is still
   pending (Phase C). The standalone-compose references were **not** removed
   (that reversal — see Phase A0 above — predates this phase; nothing to undo
   here).

**Not verified end-to-end** — no live Keycloak instance in this session; JSON/shell
syntax and `docker compose config` validated, but the actual boot sequence
(realm import → `keycloak-init` → mapper creation → signals-api JWT validation)
has not been run. Do that before treating the gate below as met.

**Gate:** in the unified stack — aggregator login works, signals accepts a
Keycloak-issued token on `dual` (visible via `GET /api/v1/auth/config` and,
once the UI override is set, an actual browser login), and `GET /users/profile`
shows `phoneNumber` declared with email/firstName/lastName **not** required.

### Phase C — Service auth: `x-api-key` → client-credentials

**Goal:** aggregator calls signals with a bearer token. Fully reversible inside
signals' dual-accept window.

1. **Implemented.** Added `SignalStackTokenProviderBase` (abstract class,
   `getToken(): Promise<Result<string, BaseError>>`) to
   `packages/signalstack-writer/src/interface.ts`, and a concrete
   `KeycloakClientCredentialsTokenProvider` (client-credentials grant,
   in-process cache, ~30s refresh lead — mirrors
   `apps/web/src/lib/service-token.ts`) in the new `./keycloak-token-provider`
   subpath. Lives in the **package**, not `apps/api`, because `apps/worker`
   constructs the same `HttpSignalStackWriter` and needs the identical impl —
   putting it in `apps/api` would have meant duplicating the grant logic
   instead of duplicating ~15 lines of factory wiring (which the two apps
   already did for apikey mode). A `SignalStackTokenProviderFake` (testing.ts)
   covers both apps' factory tests and the writer's own bearer-mode tests
   without a real Keycloak.
2. **Implemented.** `HttpSignalStackWriterConfig` now takes `apiKey?` OR
   `tokenProvider?` (constructor throws if both or neither are set). Header
   construction moved from a constructor-time static field to a per-call
   `buildHeaders()` — required because a bearer token can expire mid-lifetime
   where a static api-key never could. `x-acting-org-id` composition is
   unchanged at every one of the 8 call sites.
3. **Implemented.** Added to both `apps/api/src/config.ts` and
   `apps/worker/src/config.ts`: `SIGNALSTACK_AUTH_MODE` (`apikey`|`bearer`,
   default `apikey`), `SIGNALSTACK_CLIENT_ID`, `SIGNALSTACK_CLIENT_SECRET`.
   `KEYCLOAK_URL`/`KEYCLOAK_REALM` are read via `process.env` in `apps/api`
   (matching `idp-admin`'s existing precedent there) and added to the zod
   schema in `apps/worker` (no existing Keycloak precedent to match there —
   the worker had never touched Keycloak before this).
4. **Implemented, effectively for free.** The retry behavior needed no new
   code: `buildHeaders()`/`getToken()` is called once per public method,
   _before_ entering `requestWithRetry`'s loop, so every retry attempt
   (including a `503`) reuses the same already-fetched token rather than
   re-deriving one. Covered by a dedicated test
   (`bearer-auth.test.ts`: "reuses the same token across retry attempts").
5. **Implemented.** `getSignalStackWriter()` in both apps now branches on
   `SIGNALSTACK_AUTH_MODE`: `bearer` requires client id/secret +
   `KEYCLOAK_URL`/`KEYCLOAK_REALM` (warns and disables push if any are
   missing, same pattern as the existing apikey-missing warning); `apikey`
   is unchanged.

**Local-setup wiring — turned out to need no manual step, unlike apikey.**
The original plan assumed `SIGNALSTACK_CLIENT_SECRET` would be copy-pasted
after boot the same way `SIGNALSTACK_ADMIN_KEY` is (§4 of `LOCAL_SETUP.md`) —
but that assumption doesn't hold. `SIGNALSTACK_ADMIN_KEY` is _minted by
signals at first boot_ (non-deterministic, printed to logs, nothing to set
until then). `SIGNALSTACK_CLIENT_SECRET` is an **operator-chosen** credential,
same shape as the `aggregator-{api,portal,bff}` secrets that already exist —
so it was templated through `render-realm.sh` in Phase B (the
`__SIGNALSTACK_CLIENT_SECRET__` placeholder) and the _same_ `.env` var name is
read by `aggregator-api`/`aggregator-worker` in Phase C. One value, set once,
consistent everywhere — no post-boot copy-paste step exists to defer.
**What genuinely stays undone** — not a wiring choice, a real gap — is the
signals-side prerequisite below; nothing in this repo can satisfy it.

**signals-side prerequisites (not addressed by this plan — a different repo's
config/data):** `AUTH_PROVIDER=dual`/`keycloak` **and**
`KEYCLOAK_SERVICE_CLIENT_IDS=aggregator-dpg` on signals-api, plus the seeded
service org (`pnpm db:seed:services`) whose slug matches the client id.
Without these, flipping `SIGNALSTACK_AUTH_MODE=bearer` here gets a `403` from
signals — expected, not a bug in this implementation.

**Not verified end-to-end** — no live Keycloak/signals instance in this
session. Typecheck, lint, dep-check, and the full test suite
(`pnpm -w typecheck` / `lint` / `test` / `dep-check`) all pass, including new
unit tests for the token provider, the writer's bearer path, and both apps'
factory branching — but nothing has exercised a real client-credentials grant
against a booted Keycloak, or a real signals instance's bearer acceptance.

**Gate:** every signals call succeeds on bearer; signals logs show zero
`x-api-key` traffic from aggregator (signals' R6 gate). **Not yet
verifiable** until the signals-side prerequisites above are met in a running
stack.

### Phase D — Acting-org claim

**Goal:** aggregator's tokens carry `signals_acting_orgs` so signals can verify
the assertion instead of trusting it.

1. **Implemented (arrived via Phase B, step 4).** The merged realm already
   gets a hardcoded `signals_acting_orgs = "*"` mapper on the `aggregator-dpg`
   client — this was signals' own mapper JSON, ported into aggregator's
   `init/apply-user-profile.sh` alongside the rest of the acting-org
   claim-mapper logic when the init scripts were merged, not a separate step
   done here.
2. **Narrow `"*"` to an enumerated list.** This is the point of the change.
   aggregator uses the acting org two ways — `SIGNALSTACK_ACTING_ORG_ID`
   (deployment-fixed, platform-wide) and a **per-call** `signalstackOrgId` from
   each coordinator's row. The claim must therefore cover the platform org plus
   every aggregator org this deployment serves. **Produce that set** — it is the
   deliverable of this phase, and signals cannot derive it.
3. Keep sending `x-acting-org-id`. Only stop if the grant names exactly one org.

**signals-side:** `ACTING_ORG_SOURCE=claim_preferred` (falls back to the header
when a token has no claim, so no simultaneous deploy is needed), then
`claim_required` once verified.

**Gate:** asserting an org outside the grant returns
`403 ACTING_ORG_NOT_GRANTED`; every legitimate call still succeeds.

### Phase E — Cleanup (hold)

Retire `SIGNALSTACK_ADMIN_KEY` and the apikey branch in the writer. **Only after**
signals' Build 5 / R8 removes `x-api-key` server-side. Holding this preserves the
rollback path.

---

## 5. Sequencing and reversibility

```
A0 (standalone compose — deferred, no-op) ── A (realm rename) ──► B (merge local realm) ──► C (service auth) ──► D (acting-org claim) ──► E (cleanup)
                                                    R0                    local only              R6                     R6+                  R8
```

A0 is a placeholder, not a step — it does nothing in this pass and blocks
nothing. A blocks everything after it. B is local-only and can proceed in
parallel with C planning. C and D are independently flag-gated on the signals
side. **A–D are all reversible; E is not.**

---

## 6. Risks

| #   | Risk                                                                                                                                                 | Mitigation                                                                                                                                                                                                                                                                                                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Realm rename loses user ids**, orphaning `aggregator_id` / `signalstack_org_id` / `decision_made` and breaking `AuthContext.userId`                | `partialImport`, never `POST /users`. Reconcile 1:1 before cutover — signals' script is the reference                                                                                                                                                                                                                                      |
| 2   | **OTP flow alias collision** — first import wins, silently                                                                                           | Pick `bluedots-otp-browser`, delete the other, assert `browserFlow` post-import                                                                                                                                                                                                                                                            |
| 3   | **Losing signals' user-profile relaxation** when merging init scripts                                                                                | Phone-only signals users cannot log in. Signals' script fails loudly if `required` survives — keep that assertion in the merged script                                                                                                                                                                                                     |
| 4   | **Client id ≠ org slug**                                                                                                                             | signals returns `403 SERVICE_ACCOUNT_NOT_PROVISIONED`. Client id must be `aggregator-dpg`                                                                                                                                                                                                                                                  |
| 5   | **Shared realm collapses isolation** — an aggregator token is realm-valid against signals                                                            | signals validates `aud`/`azp` against separate human/service allowlists. Realm roles share one namespace: do not add unprefixed roles                                                                                                                                                                                                      |
| 6   | Email/phone uniqueness now spans both user populations                                                                                               | Run the overlap check (design §6.3 spike 2) before Phase A completes                                                                                                                                                                                                                                                                       |
| 7   | Duplicated SPI jar/themes drift between repos                                                                                                        | **Ownership decided the other way from the original draft:** aggregator's copy is canonical (§ Phase B). signals-dpg keeps its own vendored copy for its independent standalone realm — that duplication is now permanent, not transitional. Mirror changes by hand both ways until/unless the SPI moves into a shared, versioned artifact |
| 8   | ~~Retiring `aggregator-dpg/docker-compose.yml`~~ — moot for now; the file is kept as-is (Phase A0 deferred). Re-raise if/when its removal is decided | n/a while deferred                                                                                                                                                                                                                                                                                                                         |

---

## 7. Open questions

**Resolved (this revision):**

1. ~~B1 or B2 for realm ownership~~ — **decided: aggregator-dpg owns the combined
   realm**; signals-dpg keeps its own independent one. See Phase B step 1.
2. ~~Who owns the merged init script~~ — **decided: aggregator-dpg**
   (`init/apply-user-profile.sh`), co-located with the realm it configures.

**Still open:**

1. **The enumerated acting-org set** for Phase D — needs a product answer about
   which orgs each deployment legitimately serves.
2. Does `voice-dpg` need its signals service org seeded now, or defer? (Its
   client exists in the realm but no org is seeded, so bearer auth would 403.)
3. **Standalone `aggregator-dpg/docker-compose.yml` fate — deferred, not
   decided.** Kept as-is for this pass (Phase A0). When this is revisited it
   needs to cover: (a) whether it also moves to `bluedots` or stays `aggregator`
   as a separate realm identity, and (b) whether it's still the intended
   VM/prod deploy path or something else replaces it — today's root
   `Signals-dots/CLAUDE.md` and this repo's own "Local stack run modes" section
   both describe it as the prod/VM posture, so leaving it untouched keeps that
   description accurate for now.
