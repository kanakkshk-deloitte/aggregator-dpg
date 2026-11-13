# Implementation plan: User & Org management refactor, Phase 5 (`/v1/org/*` and `/v1/user/*` APIs)

**Date:** 2026-09-30
**Branch:** `refactor/user-org-management` (same branch as Phases 1–3)
**Status:** Plan only. Nothing here is implemented. Decisions marked **⚠ REVIEW** need your call before R1.
**Depends on:** the release train: Phase 2 (`users`), Phase 3 (`organisations`) and Phase 4 (cleanup). See the banner below: the rest of this header predates the restructure.
**Companions:** `contact-table-phase-1.md` (§0, §9), `users-phase-2.md`, `user-org-refactor-decisions.md`, `cross-cutting-phase-6.md`.

> Delete this file in the commit that completes Phase 5 (repo convention for `docs/plans/`).

## ▶ Update 2026-10-05: renumbered and re-based on the new target model

This was Phase 4. The phases were restructured (`user-org-target-model.md` §5), and this plan now runs **after** the release train (Phase 2 `users`, Phase 3 `organisations`, Phase 4 cleanup). The body below was written against the old model. Read every name through this table until the plan is reworked, which should happen before its R1:

| Old name in this file                                 | Now                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app_user`, `app_user_type`                           | `users`, `user_type` (Phase 2)                                                                                                                                                                                                                                      |
| `organisation`                                        | `organisations` (`aggregator_orgs` renamed, Phase 3)                                                                                                                                                                                                                |
| `org_type` `'NetworkFacilitator'` / `'Aggregator'`    | `'network_facilitator'` / `'aggregator'`                                                                                                                                                                                                                            |
| `organisation.primary_user_id`                        | `organisations.org_owner`                                                                                                                                                                                                                                           |
| `organisation_member(organisation_id, user_id, role)` | **dropped**: the account's org is `users.org_id`; "many admins" = several `admin` users with the same `org_id`                                                                                                                                                      |
| `extension = 'aggregator'` / `'aggregator_org'`       | **gone**: only real organisations are org rows (the NF root, the Default org, registered aggregator orgs)                                                                                                                                                           |
| `aggregators` row                                     | a `users` row (`user_type = 'coordinator'`) **with the same id**, linked to its aggregator org by `users.org_id`. It keeps its own Signals tenant (`signalstack_org_slug`, `signalstack_org_name`, `signalstack_org_id`). Tenant data carries `user_id` + `org_id`. |
| `aggregator_consent_record`                           | `consent_record` with `user_id` / `org_id`                                                                                                                                                                                                                          |
| `depth` (stored)                                      | not stored; compute it, or add it here if `max_depth` reads need it                                                                                                                                                                                                 |

**Design impacts to carry into the rework:**

- **Token → account mapping (§2.2):** the `aggregator_id` claim **is the coordinator's `users.id`** (G1), so coordinators resolve without any lookup change. Admin and NF-admin tokens resolve by `users.kc_sub`. An org admin's scope is `organisations.org_owner = me` (plus `users.org_id`).
- **Authorisation scope (§2.4):** "my org and its subtree" walks `organisations.parent_id`.
- **The NF admin** already exists as the owner of the root (G4). This phase adds its login and replaces `ADMIN_EMAILS` routing.
- **Claim renames** (`aggregator_id` → `user_id`, plus an `org_id` claim) are allowed here, with a dual-claim release (G8).
- **Hierarchy flag:** `ORG_HIERARCHY_ENABLED` no longer exists (always on, Phase 3). References below to "like `ORG_HIERARCHY_ENABLED`" describe the flag mechanism only.
- **Org details** (`url`, `locations`, company, GST) live on the org since Phase 3; coordinator PATCH refuses them with `409 ORG_DETAILS_READ_ONLY`, so `/v1/org/update` (org admin) is where they are edited.
- **Deployment:** this phase is additive (new routes); it may roll out live unless it renames claims.

---

## 1. What the design doc asks for, and what exists today

**Doc:** `/v1/org/{create, metadata/update/<id>, parent/update/<id>, user/update/<id>, read/<id>, search}` and `/v1/user/{create, metadata/update/<id>, contact/update/<id>, read/<id>, search}`. `contact/update` requires OTP verification of the new email/phone. An org has several admins and one primary. `org_type` is set only at creation.

| Fact today                                                                                                                          | Evidence                                                                                                                                                                                                                                  | Consequence for Phase 4                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Only coordinators log in. The web layout rejects any token without `aggregator_id`.                                                 | `apps/web/src/app/(protected)/layout.tsx:67`; `apps/web/src/lib/jwt.ts:84-107` (`classifyNonCoordinator` → `org_no_portal`)                                                                                                               | An org console needs a login path for admins (§6).                                                   |
| The Keycloak portal gate denies users without `aggregator_id` or without `decision_made=approved`.                                  | `infra/keycloak/realms/realm.json` authenticatorConfig `aggregator-portal-cond-no-aggregator-id`, `aggregator-portal-cond-not-approved`; reconciled by `infra/keycloak/init/apply-portal-gate.py`                                         | Admin login needs a gate change, in this repo **and** in the deployment realm (bluedots-automation). |
| Org owners' Keycloak users stay **disabled**. Owners act only through signed grant/approval/invite tokens.                          | Phase 2 plan §1; `apps/api/src/services/grant-token.ts:1-14` ("their Keycloak user is deliberately disabled (#699)")                                                                                                                      | Enabling owner login is an explicit rollout step (R3).                                               |
| The NF admin is `ADMIN_EMAILS` plus signed email links, not a user. Approvals are HTML pages served by the API.                     | `apps/api/src/config.ts:91`; `routes/approval-shared.ts:155` (`verifyApprovalToken`)                                                                                                                                                      | NF-admin authz needs the Phase 3 NF admin `app_user`.                                                |
| Auth is per-file wrappers around `access-token.ts`; nothing enforces them.                                                          | `apps/api/CLAUDE.md:5-7`; `routes/bulk-uploads.ts:862`, `routes/registration-links.ts:782`                                                                                                                                                | New route files copy the wrapper pattern; §2.3 adds a test that closes the gap for the new routes.   |
| `authenticateAny` accepts any valid token; the only correct service-account discriminator is a positive `preferred_username` match. | `services/auth/access-token.ts:363-400`; `campaign/auth.ts:121-160`; `apps/api/CLAUDE.md:9`                                                                                                                                               | Service-account routes use that pattern, never `sub.startsWith`.                                     |
| Tokens carry no user type and no org. Phase 2 deliberately changes no claims.                                                       | `access-token.ts:26-64` (`AuthContext`); Phase 2 P2-D7                                                                                                                                                                                    | The actor is resolved from the DB by `kc_sub` (§2.2).                                                |
| Profile PATCH changes the phone **without OTP** and mirrors it to Keycloak first.                                                   | `routes/aggregator-profile.ts:179-245` (`idp.setAttributes` at `:232`)                                                                                                                                                                    | The new `contact/update` is the OTP-verified path; the old one stays for contract reasons (D4-6).    |
| There is no SMS sender in this repo. Phone OTP exists only inside the Keycloak OTP SPI, as a **login** authenticator.               | `realm.json` flows `aggregator-portal-otp-forms` (`otp-identifier-form`, `otp-channel-choice-form`), config `otpChoice.ttl=300`, `codeLength=6`, `maxRetries=3`, `phoneAttribute=phoneNumber`; no SMS module under `apps/` or `packages/` | Drives the OTP decision (§4).                                                                        |
| `IdpAdminAdapter` can set attributes but cannot change a user's email/username.                                                     | `services/idp-admin/interface.ts:52-128`; username defaults to email at `keycloak.ts:54`                                                                                                                                                  | A new abstract method is needed for contact changes (§4.4).                                          |
| Responses are snake_case objects with no envelope; route schemas are Zod, and swagger is generated from them.                       | `routes/aggregator-profile.ts:85-106`; `app.ts:111-123`; `scripts/dump-openapi.ts`                                                                                                                                                        | New routes follow the same style; the spec grows additively (§5).                                    |
| The existing org paths are plural: `/v1/orgs/create`, `/v1/orgs`, `/admin/v1/orgs/*`.                                               | `openapi.json` paths; `routes/aggregator-orgs.ts:138,523`                                                                                                                                                                                 | The doc's singular `/v1/org/*` does not collide with them.                                           |

## 2. Authorisation model

### 2.1 Principals

| Principal                 | How it is recognised                                                                                                                                                                             | Scope                                                                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **NF admin**              | End-user token → `app_user` (`user_type='admin'`) with a membership in the org whose `org_type='NetworkFacilitator'` (the Phase 3 root).                                                         | Every org and user on the instance.                                                                                                                                   |
| **Org admin**             | End-user token → `app_user` (`admin`) with an `organisation_member` row in an `Aggregator` org. `organisation.primary_user_id` marks the primary contact.                                        | Their org plus its descendants (§2.4).                                                                                                                                |
| **Coordinator**           | End-user token → `app_user` (`coordinator`). Today's `aggregator_id` claim stays the binding for all existing routes; it equals the id of the coordinator's own `organisation` row (Phase 3 O1). | Self, plus a read of their own and parent org.                                                                                                                        |
| **Service account (BFF)** | `authenticateAny` + a **positive** `preferred_username` match against `USER_ORG_API_SERVICE_ACCOUNTS` (default `service-account-aggregator-bff`), copying `campaign/auth.ts:121-160`.            | Anonymous self-registration only: `org/create` and `user/create` in `pending` state, the same as today's `/v1/orgs/create` and `/v1/aggregator-registrations/create`. |

The `aggregator-api` service account is **not** accepted on the new routes. It is the realm-admin client, and a leaked BFF secret must not reach admin paths either (root `CLAUDE.md`, Identity/OIDC).

### 2.2 Token → `app_user` mapping

New module `apps/api/src/services/auth/actor.ts`:

```ts
export type Actor =
  | { kind: 'service'; subject: string; username: string }
  | {
      kind: 'user';
      userId: string;
      kcSub: string;
      userType: 'admin' | 'coordinator';
      memberships: {
        orgId: string;
        orgType: 'NetworkFacilitator' | 'Aggregator';
        depth: number;
        isPrimary: boolean;
      }[];
      isNfAdmin: boolean;
      aggregatorId?: string;
    };

/** Resolves the caller of a /v1/org or /v1/user route. Never throws; returns Result. */
export async function resolveActor(req: FastifyRequest): Promise<Result<Actor, BaseError>>;
```

1. `authenticateAny(req)` (`access-token.ts:363`) verifies signature, issuer, `azp`.
2. Service account → `preferred_username` must be in the allow-list, or `403 FORBIDDEN` (`reason: NOT_SERVICE_CLIENT`).
3. End user → one indexed query: `app_user` by `kc_sub` (`app_user_kc_sub_unique`, `0027_app_user.sql:78`) joined to `organisation_member` and `organisation` (`isPrimary` = `organisation.primary_user_id = app_user.id`).
4. No row by `kc_sub`, but the token has `aggregator_id` → resolve through `aggregators.user_id`, then stamp `kc_sub` (the Phase 2 R1 lazy-stamp rule). Otherwise `403 USER_NOT_PROVISIONED`.
5. `app_user.status <> 'active'` → `403 NOT_APPROVED` (the same code the existing wrappers use, `bulk-uploads.ts:865`).

**DB lookup, not token claims (D4-1).** Memberships and primary status change without a re-login, the Phase 2 rule is "no token change", and the deployment realm lives in another repo. The cost is one indexed query per request. No cache in Phase 4; Phase 5c revisits it.

### 2.3 Enforcement point

- Two new route files, `routes/v1-org.ts` and `routes/v1-user.ts`. Each declares a local `requireActor(req, policy)` wrapper and calls it as the **first statement of every handler**, the pattern `apps/api/CLAUDE.md:5-7` prescribes.
- The policy is a named entry in `services/authz/policy.ts` (for example `ORG_UPDATE_METADATA`), a pure function `(actor, target) => 'allow' | 'deny' | 'not_found'`. Phase 5c replaces the bodies with permission-set checks; the call sites do not change.
- Each route also declares `config: { policy: '<NAME>' }`. A unit test builds the app, enumerates every `/v1/org/*` and `/v1/user/*` route, and fails if one lacks a `policy` or if its handler source does not call `requireActor` first. This is the test-time guard the per-file pattern lacks.
- **Out-of-scope targets return 404, not 403**, so the API is not an existence oracle for org and user ids.

### 2.4 Scope rule

`orgScope(actor)` = the actor's membership orgs plus their descendants, via a recursive CTE on `organisation.parent_id` (index `organisation_parent_status_idx`), bounded by the stored `depth` and the Phase 3 `max_depth` config. NF admin = all orgs, no CTE. The CTE lives in the org store (`Result`-returning, per `.claude/rules/interfaces.md` §4).

### 2.5 Authz matrix

| Route                                 | NF admin   | Org admin                                    | Coordinator                                  | BFF service                                           |
| ------------------------------------- | ---------- | -------------------------------------------- | -------------------------------------------- | ----------------------------------------------------- |
| `POST /v1/org/create`                 | any parent | child of an org in scope (**⚠ REVIEW** D4-2) | –                                            | self-registration, `pending`, parent must be `active` |
| `PATCH /v1/org/metadata/update/<id>`  | ✓          | own org and descendants                      | –                                            | –                                                     |
| `PATCH /v1/org/parent/update/<id>`    | ✓          | – (moving a subtree is a network decision)   | –                                            | –                                                     |
| `PATCH /v1/org/user/update/<id>`      | ✓          | own org and descendants                      | –                                            | –                                                     |
| `GET /v1/org/read/<id>`               | ✓          | in scope                                     | own parent org, reduced view (no admin list) | –                                                     |
| `POST /v1/org/search`                 | ✓          | in scope                                     | –                                            | – (the registration dropdown keeps `GET /v1/orgs`)    |
| `POST /v1/user/create`                | ✓          | users in orgs in scope                       | –                                            | coordinator/admin self-registration, `pending`        |
| `PATCH /v1/user/metadata/update/<id>` | ✓          | users in scope                               | self                                         | –                                                     |
| `PATCH /v1/user/contact/update/<id>`  | –          | –                                            | –                                            | –                                                     |
| … same route, `<id>` = caller         | self       | self                                         | self                                         | –                                                     |
| `GET /v1/user/read/<id>`              | ✓          | users in scope                               | self                                         | –                                                     |
| `POST /v1/user/search`                | ✓          | users in scope                               | –                                            | –                                                     |

`contact/update` is **self-only** in every role (D4-5): the OTP proves possession of the new address, and only the account holder can prove that. An admin-assisted recovery flow is out of scope.

## 3. Routes and schemas

### 3.1 Where the schemas live

- New subpath `@aggregator-dpg/shared-primitives/user-org`, next to `./contact`, so the API routes and the web BFF share one definition. Only `zod` and `shared-primitives` imports (`.claude/rules/interfaces.md` §5).
- Naming per `.claude/rules/interfaces.md` §2: `<Entity>Schema`, `<Action>RequestSchema`, `<Action>ResponseSchema`, inferred type = name without `Schema`.
- Wire style matches the existing API: snake_case keys, no envelope, ISO timestamps as strings, errors from the `ERR` catalogue (`errors/codes.ts:526`) via `errorResponses(...)`.
- `contact` in every new response is the **masked** shape by default (D4-7). That avoids a contract change when Phase 5 turns masking on.

### 3.2 Entities

```ts
export const OrgTypeSchema = z.enum(['NetworkFacilitator', 'Aggregator']);
export const UserTypeSchema = z.enum(['Admin', 'Coordinator']); // wire casing per doc; DB enum is lower-case (0027)
export const ServesSchema = z.enum(['Seeker', 'Provider', 'ServiceProvider']); // validated against network domainIds at boot
export const EntityStatusSchema = z.enum(['pending', 'active', 'inactive', 'retired']); // = AggregatorStatus

export const MaskedContactSchema = z.object({
  name: z.string(),
  email: z.string(),
  phone: z.string().nullable(),
  masked: z.boolean(), // false only for self-reads (and, in Phase 5, contact.unmask)
});
export const UserSchema = z.object({
  id: z.string().uuid(),
  user_type: UserTypeSchema,
  serves: z.array(ServesSchema), // [] for admins
  status: EntityStatusSchema,
  contact: MaskedContactSchema,
  metadata: z.record(z.unknown()), // schema-registry validated, see UpdateUserMetadataRequestSchema
  orgs: z.array(z.object({ org_id: z.string().uuid(), is_primary: z.boolean() })), // from organisation_member + primary_user_id
  created_at: z.string(),
  updated_at: z.string(),
});
export const OrgSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  org_type: OrgTypeSchema,
  known_as: z.string().nullable(), // instance enum from config; null for NF
  parent_id: z.string().uuid().nullable(), // null only for the NF root
  primary_contact: z.string().uuid().nullable(), // app_user.id (doc: primary_contact → user uuid)
  status: EntityStatusSchema,
  profile: z.record(z.unknown()),
  created_at: z.string(),
  updated_at: z.string(),
});
```

`contact.id` never appears on the wire (Phase 1 D13).

### 3.3 Org routes

| Route                                | Request                                                                                                                                                                                           | Response                                                                                              | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /v1/org/create`                | `CreateOrgRequestSchema` = `{ name, org_type: 'Aggregator', known_as, parent_id, profile?, primary_contact: CreateUserRequestSchema['contact'] & { name }, consent?: AgreementAcceptanceSchema }` | `201 CreateOrgResponseSchema` = `{ org: OrgSchema, primary_user: UserSchema, invite_sent: boolean }`  | `org_type: 'NetworkFacilitator'` is refused (`ORG_TYPE_NOT_CREATABLE`): the root is seeded at setup. `parent_id` and `primary_contact` are **required** (doc). Checks: `known_as` in the instance enum, parent `active`, Phase 3 `max_children` / `max_depth` (its `ORG_CHILD_LIMIT` / `ORG_DEPTH_LIMIT`, reusing its locked-parent check), contact pre-checks reused from org create (`OWNER_ALREADY_REGISTERED`, `PHONE_EXISTS`; decisions D7). Admin-initiated → org `active`, primary user **invited** (§3.5). BFF-initiated → org and user `pending`, consent required, approval by the parent's admins.                                                                                                                                          |
| `PATCH /v1/org/metadata/update/<id>` | `UpdateOrgMetadataRequestSchema` = `{ name?, known_as?, profile? }`; `.strict()`, so `org_type`, `parent_id`, `status` are rejected                                                               | `200 { org: OrgSchema }`                                                                              | `org_type` is immutable (`ORG_TYPE_IMMUTABLE` if sent). Name uniqueness reuses the `0016` rule.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `PATCH /v1/org/parent/update/<id>`   | `UpdateOrgParentRequestSchema` = `{ parent_id }`                                                                                                                                                  | `200 { org: OrgSchema }`                                                                              | One transaction: lock the moved row and the new parent (`FOR UPDATE`, same order as live writes, decisions M1), reject cycles (`ORG_PARENT_CYCLE`), recheck `max_children` on the new parent and `max_depth` for the deepest descendant (`ORG_CHILD_LIMIT` / `ORG_DEPTH_LIMIT`), then **recompute the stored `depth` for the whole subtree** (Phase 3 O10). Phase 3 makes `parent_id` immutable by trigger; this route is the one sanctioned writer and sets the same session flag the Phase 3 sync uses (`aggregator_dpg.org_sync`) inside its transaction. Only `Aggregator` orgs with `extension='aggregator_org'` can be moved in Phase 4 (**⚠ REVIEW** D4-12: moving a coordinator's own org between parents also rewrites its approval routing). |
| `PATCH /v1/org/user/update/<id>`     | `UpdateOrgUsersRequestSchema` = `{ primary_contact?: uuid, link?: uuid[], unlink?: uuid[] }`, at least one key                                                                                    | `200 { org: OrgSchema, admins: UserSchema[] }`                                                        | The new primary must be an `active` admin member (`PRIMARY_NOT_MEMBER`; Phase 3's deferrable `organisation_primary_member_fk` backs it in the DB); cannot unlink the primary or the last admin (`LAST_ADMIN`). Linking an existing user creates a membership; creating a new user is `user/create`. Keycloak group membership (`addUserToGroup`, `interface.ts:120`) follows the DB, KC after the DB commit, with a logged compensating step on KC failure.                                                                                                                                                                                                                                                                                            |
| `GET /v1/org/read/<id>`              | –                                                                                                                                                                                                 | `200 ReadOrgResponseSchema` = `{ org: OrgSchema, admins: UserSchema[], child_count: number }`         | Coordinator view omits `admins`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `POST /v1/org/search`                | `SearchOrgsRequestSchema` = `{ filter: { org_type?, parent_id?, known_as?, status?, name_prefix? }, cursor?, limit (1..100, default 20) }` (`OrgFilter extends Filter`)                           | `200 SearchOrgsResponseSchema` = `Paginated<Org>` via `paginatedSchema(OrgSchema)` plus `next_cursor` | Always intersected with `orgScope(actor)`. No free-text search on contact fields (they will be encrypted in Phase 5).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

### 3.4 User routes

| Route                                 | Request                                                                                                                                                                                                                 | Response                                                                                                              | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/user/create`                | `CreateUserRequestSchema` = `{ user_type, serves? (required and non-empty iff Coordinator), org_id, contact: { name, email, phone }, metadata?, consent?: AgreementAcceptanceSchema }`                                  | `201 CreateUserResponseSchema` = `{ user: UserSchema, invite_sent: boolean }`                                         | `phone` through `normalisePhone`, `email` through `normaliseEmail` (Phase 1 §3.1). The same person may hold one admin and one coordinator account (`app_user_contact_type_unique`, 0027:77), which resolves the U3 carve-out. Admin-initiated → **invite** (§3.5). BFF-initiated → `pending`, consent required, fail-closed ledger write **before** provisioning (`apps/api/CLAUDE.md` "Consent-ledger write"). Coordinator creation in Phase 4 keeps writing the legacy `aggregators` row too (through the Phase 3 compatibility layer), so every existing coordinator route keeps working. |
| `PATCH /v1/user/metadata/update/<id>` | `UpdateUserMetadataRequestSchema` = `{ name?, metadata?, serves? }`, `.strict()`                                                                                                                                        | `200 { user: UserSchema }`                                                                                            | `contact.name` is the only contact field editable here (a name change is not a re-key, Phase 1 §3.3). `serves` is editable only by an admin in scope (not self) and stays in step with `aggregators.type` until Phase 5c. `user_type` is immutable.                                                                                                                                                                                                                                                                                                                                          |
| `PATCH /v1/user/contact/update/<id>`  | `UpdateUserContactRequestSchema` = discriminated union on `step`: `{ step: 'request', email?, phone? }` (at least one) or `{ step: 'verify', challenge_id, email?, phone?, codes: { email?: string, phone?: string } }` | `request` → `202 { challenge_id, channels: ('email'\|'phone')[], expires_at }`; `verify` → `200 { user: UserSchema }` | Self-only. Full design in §4.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `GET /v1/user/read/<id>`              | – (`<id>` may be `me`)                                                                                                                                                                                                  | `200 ReadUserResponseSchema` = `{ user: UserSchema }`                                                                 | `masked: false` only when the caller is the user.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `POST /v1/user/search`                | `SearchUsersRequestSchema` = `{ filter: { org_id?, user_type?, serves?, status? }, cursor?, limit }` (`UserFilter extends Filter`)                                                                                      | `200 SearchUsersResponseSchema` = `paginatedSchema(UserSchema)`                                                       | Scope-intersected. Lookup by exact email/phone is **not** offered in Phase 4; if it is needed it goes through the Phase 5 blind index.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

### 3.5 "Create" versus "invite"

- **Every admin-initiated create is an invite (D4-3).** The row is written `pending`, the Keycloak user is created **disabled** (as org owners are today), and an invite email carries a signed token (a new `aud: 'aggregator-user-invite'`, minted like `services/invite-token.ts`, secret from `APPROVAL_TOKEN_SECRET` via `token-common.ts:24`).
- The invitee opens `/(public)/register/accept`, accepts the agreements (the fail-closed ledger write), and completes the first OTP login. Only then does the user become `active` and the KC user enabled.
- **Why:** the consent ledger records the subject's own acceptance; an admin cannot consent on someone's behalf, and an active account without a consent row is exactly what fail-closed forbids.
- Re-sending an invite reuses the rate limiter (`services/rate-limiter/index.ts:73` `consume`), like `org-invite-resend-rate.ts`.

### 3.6 New error codes

Add to `errors/codes.ts`: `ORG_TYPE_NOT_CREATABLE`, `ORG_TYPE_IMMUTABLE`, `ORG_PARENT_CYCLE`, `PRIMARY_NOT_MEMBER`, `LAST_ADMIN`, `USER_NOT_PROVISIONED`, `CONTACT_UNCHANGED`, `OTP_CHALLENGE_NOT_FOUND` (covers expired), `OTP_INVALID`, `OTP_ATTEMPTS_EXCEEDED`, `OTP_CHANNEL_UNAVAILABLE`. Reuse Phase 3's `ORG_CHILD_LIMIT`, `ORG_DEPTH_LIMIT`, and `NOT_FOUND`, `FORBIDDEN`, `NOT_APPROVED`, `PHONE_EXISTS`, `USER_EXISTS`, `OWNER_ALREADY_REGISTERED`, `CONFLICT`, `RATE_LIMITED`, `IDP_UNAVAILABLE`, `DB_UNAVAILABLE`.

## 4. OTP verification for `contact/update`

### 4.1 Options

| Option                            | How                                                                                                                                                                           | For                                                                                                                                                | Against                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Reuse the Keycloak OTP SPI** | A Keycloak required action / application-initiated action (`kc_action=…`) added to the SPI jar, which sends a code to the _new_ address and updates the user.                 | The SMS gateway already lives inside the SPI. One OTP implementation in the ecosystem.                                                             | The SPI today is a **login authenticator** only (`otp-identifier-form` + `otp-channel-choice-form`). It sends to the user's _existing_ `phoneNumber` attribute. Verifying a _new_ address means new Java in the external repo (`sanketika-labs/keycloak-otp-authenticator`) and a new deployment image in bluedots-automation. It is a browser-redirect flow, so the API cannot drive it, and it would update Keycloak **before** the DB, with no hook for the contact pre-checks, the re-key or the consent/audit writes. |
| **B. App-side OTP** (recommended) | The API issues and checks the challenge (Redis), sends email via `getMailer()` and SMS via a new `SmsSenderBase` port, then applies the change to the DB and Keycloak itself. | Everything is in one transaction boundary under our control: pre-checks, the re-key, the KC sync, the audit. Testable with fakes. No realm change. | Needs an SMS adapter in this repo. Two OTP implementations exist (login in KC, contact change in the API).                                                                                                                                                                                                                                                                                                                                                                                                                 |
| C. Hybrid                         | Email in the app, phone through the KC SPI.                                                                                                                                   | –                                                                                                                                                  | Two flows for one form; the worst of both.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

**Recommendation (D4-4): B.** Phone-channel availability is a config question (the SMS gateway credentials), not a code one.

### 4.2 Flow

1. **`step: 'request'`**
   - `requireActor` → self-only check.
   - Normalise and validate (`normaliseEmail`, `normalisePhone`). Nothing changed → `400 CONTACT_UNCHANGED`.
   - Pre-check uniqueness against `contact` (the same checks profile PATCH uses, `aggregator-profile.ts:225-229` `assertPhoneFree`; email → `USER_EXISTS`, phone → `PHONE_EXISTS`). The pre-check runs **before** sending a code, so a code is never sent to an address that cannot be used. This reveals that an address is taken, the same as registration does today.
   - Rate-limit per user and per target address (`consume`, `rate-limiter/index.ts:73`), limits from config.
   - Create challenge `otp:contact:<challenge_id>` in Redis with TTL `CONTACT_OTP_TTL_SECONDS` (default 300, the SPI's `otpChoice.ttl`): `{ user_id, email_hmac?, phone_hmac?, code_hmac: { email?, phone? }, attempts: 0 }`. HMACs are keyed with `CONTACT_OTP_SECRET`. **No plaintext address or code is stored.**
   - Send one code per changed channel: 6 digits (`CONTACT_OTP_LENGTH`, the SPI's `codeLength`), email through the mailer, SMS through `SmsSenderBase`. A channel with no configured sender → `503 OTP_CHANNEL_UNAVAILABLE` before anything is stored.
   - `202 { challenge_id, channels, expires_at }`.
2. **`step: 'verify'`**
   - The client re-sends the new email/phone with the codes. The API recomputes their HMACs and compares them with the challenge. A mismatch → `OTP_INVALID`, so a challenge cannot be redeemed for a different address.
   - Constant-time compare per channel. **Every** changed channel must verify. Each failure increments `attempts`; at `CONTACT_OTP_MAX_ATTEMPTS` (default 3, the SPI's `maxRetries`) the challenge is deleted → `OTP_ATTEMPTS_EXCEEDED`.
   - Success → delete the challenge first (single use, `GETDEL`), then apply §4.3.
3. After success, send a **notice to the old email** ("your contact details were changed"). It contains no new values. Best-effort, logged.

### 4.3 Applying the change

The contact is the person, so the change applies to **every** `app_user` on that contact (one person may hold an admin and a coordinator account, P2-D3). This deliberately replaces Phase 1's refusal of a shared re-key (decisions D19) for this route only (**⚠ REVIEW** D4-5).

1. **Pre-check again** inside the transaction (the race between request and verify).
2. **Keycloak first, for every linked `kc_sub`**, the same order profile PATCH uses (`aggregator-profile.ts:232-245`, "aborting before DB write"): email + username (username = email, `keycloak.ts:54`) and the `phoneNumber` attribute. That attribute is what OTP login looks up (`otpChoice.phoneAttribute=phoneNumber`), so a DB-only change would lock the user out. The old values are kept in memory for compensation.
3. **DB transaction:** `changeContact` (`db/contact-writes.ts:136`) re-keys the contact. The FKs are `ON UPDATE CASCADE`, so `aggregators`, `aggregator_orgs` and `app_user` follow (Phase 3 adds no FK to `contact`; memberships reference `app_user.id`, which does not change). A shared contact is allowed on this path (a new `allowShared: true` option; the default stays refusing). Append a row to the new `contact_change_audit` (user id, actor id, channels verified, timestamp; **no values**).
4. **DB failure** → revert Keycloak to the old values (logged at `error` if the revert fails, with `user_id` only, never the address) → `503 DB_UNAVAILABLE`.

### 4.4 New ports

| Port                                                            | Where                                                                                                     | Shape                                                                                                                                                                                                              |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `IdpAdminAdapter.updateIdentity(userId, { email?, username? })` | `services/idp-admin/interface.ts` (+ `keycloak.ts`, `testing.ts`)                                         | `Promise<IdpResult<void>>`. Maps `409` to `USER_EXISTS`. Timeout via `safeFetch`; **no blind retry**, per `apps/api/CLAUDE.md` "Known gap", since a username change is not idempotent against a concurrent change. |
| `SmsSenderBase.send({ to, templateKey, vars })`                 | new `packages/sms-provider` (`./interface`, `./http`, `./testing`), modelled on `packages/voice-provider` | `Promise<Result<void, BaseError>>`; timeout plus one retry on 5xx or timeout; the body is never logged.                                                                                                            |
| `ContactOtpService`                                             | `apps/api/src/services/contact-otp/` (`interface.ts` abstract class, `redis.ts`, `testing.ts`)            | `request(...)`, `verify(...)`, both returning `Result`.                                                                                                                                                            |

Keycloak's `editUsernameAllowed` is unset in `realm.json`. Whether the admin API may still change the username must be verified in `keycloak.integration.test.ts` before R2. If it may not, the realm flag goes in both realms (**⚠ REVIEW** D4-8).

## 5. Coexistence with the existing endpoints

### 5.1 Rules

1. **No existing contract changes.** Every path in today's `openapi.json` keeps byte-identical request, response and error schemas. The same rule applies to their behaviour and error codes, with one exception: the flagged profile PATCH switch-off in D4-6.
2. **The old routes stay registered** and keep their own handlers. They are not re-implemented on top of the new service. That keeps their byte-identical output (for example the jsonb key order in `contact`, decisions D9) free of risk.
3. **One write path per table.** Both old and new routes write through the same stores and `db/contact-writes.ts`, so invariants (uniqueness, GC, re-key) cannot drift.
4. **New routes sit behind `USER_ORG_API_ENABLED`** (default `false`), read once at boot by the API and the web app (like `ORG_HIERARCHY_ENABLED`). When it is off, the route files `return` before registering, so they 404, the same mechanics as `aggregator-orgs.ts:74`.
5. **Mapping of old to new** (for the web migration, not a redirect):

| Old                                                                       | New                                                                                                 |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `POST /v1/orgs/create` (BFF)                                              | `POST /v1/org/create` (BFF)                                                                         |
| `GET /v1/orgs` (dropdown)                                                 | stays; `POST /v1/org/search` is for authenticated consoles                                          |
| `POST /v1/aggregator-registrations/create`                                | `POST /v1/user/create` (`Coordinator`)                                                              |
| `GET/PATCH /v1/aggregators/profile/me`                                    | `GET /v1/user/read/me`, `PATCH /v1/user/metadata/update/<id>`, `PATCH /v1/user/contact/update/<id>` |
| `POST /admin/v1/invites` (grant token)                                    | `POST /v1/user/create` by a logged-in org admin                                                     |
| `/admin/v1/orgs/*`, `/admin/v1/aggregator-registrations/*` (signed links) | stay; an approval console on top of the new APIs is a later step                                    |

### 5.2 OpenAPI drift

- `scripts/dump-openapi.ts` must also set `USER_ORG_API_ENABLED=true`, as it already does for `ORG_HIERARCHY_ENABLED` (the "spec describes what the API CAN serve" comment). Otherwise the new routes never reach `openapi.json`.
- The CI drift check (`ci.yml:76-77`) will show the diff as **additive** new paths plus new component schemas. Add a test, `openapi-legacy-paths.test.ts`: it loads a frozen snapshot of the pre-Phase-4 `paths` object (committed as a fixture at R1) and asserts that each of those paths is deep-equal in the freshly generated spec. That makes "old contract unchanged" a failing test instead of a reviewer's eye.
- New tags: `org`, `user`. `deprecated: true` on old operations happens only at R5, because it changes their spec bytes (it is a contract release).

## 6. Web screens

### 6.1 Letting admins log in

Today owners cannot log in in three places: the KC user is disabled; the KC portal gate denies without `aggregator_id`; and the web layout rejects org-owner tokens (`layout.tsx:67`, `jwt.ts:103-107` `org_no_portal`).

| Option                                         | Change                                                                                                                                                                                                                                                                                                                                                          | For                                                                                    | Against                                                                                                            |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **A. Same client, widened gate** (recommended) | Gate: allow `aggregator_id` present **or** realm role `org_owner` (already assigned at approval, `realm.json` roles), both still requiring `decision_made=approved`. Enable owner KC users at approval, plus a one-off script for existing owners (`--dry-run`, idempotent). The web layout routes by actor (from `GET /v1/user/read/me`) instead of rejecting. | One login page, one session model, no new secret. `org_owner` finally means something. | Touches the coordinator gate; the deployment realm is owned by bluedots-automation, so the change lands there too. |
| B. Separate `aggregator-console` client        | A new confidential client and gate for admins; add it to `KEYCLOAK_ALLOWED_AZP`.                                                                                                                                                                                                                                                                                | The coordinator gate is untouched.                                                     | A new secret in `render-realm.sh`, a second OIDC config in web, and the same cross-repo realm change.              |

**Recommendation (D4-9, ⚠ REVIEW): A.** Also rename `org_owner` semantics to "org admin" in docs only; the role name stays to avoid a realm migration. NF admins get the same role plus an NF membership (Phase 3).

### 6.2 Screens (new route group `(console)`, same app)

All BFF routes use `callApi` (the caller's token). Only the anonymous create routes use `proxyServiceRequest`, per `apps/web/CLAUDE.md` "Two auth helpers".

| #   | Screen                                                                                                            | Who                  | APIs                                                          |
| --- | ----------------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------- |
| W1  | **My account**: read contact (unmasked, self), edit name/metadata, "Change email/phone" with a two-step OTP modal | everyone             | `user/read/me`, `user/metadata/update`, `user/contact/update` |
| W2  | **Org overview**: metadata, parent, primary contact, child orgs                                                   | org admin, NF        | `org/read`, `org/search`                                      |
| W3  | **Edit org** metadata (`org_type` shown read-only)                                                                | org admin, NF        | `org/metadata/update`                                         |
| W4  | **Org users**: list, invite admin or coordinator, change primary, link/unlink                                     | org admin, NF        | `user/search`, `user/create`, `org/user/update`               |
| W5  | **Create child org** (hidden when `max_children`/`max_depth` reached)                                             | org admin (D4-2), NF | `org/create`                                                  |
| W6  | **Network tree** with "move org"                                                                                  | NF                   | `org/search`, `org/parent/update`                             |
| W7  | **Accept invite**: agreements (reuses `components/consent/` scroll-gated modal) → OTP login                       | invitee              | the invite token, then `user/read/me`                         |

The coordinator portal migrates **screen by screen** behind `USER_ORG_API_ENABLED`: W1 replaces the read-only `/profile` first (the "Request an update" stub, `ProfileFormView.tsx:76-79`, goes away); registration forms move last. Each screen keeps the old one reachable until its switch is verified. The grant-token invite page (`register/invite`) stays until owners can log in on every instance, then is retired at R5.

## 7. Rollout

Same rhythm and safety rules as Phases 1–2: each release works against the next release's schema; migrations are idempotent (`IF NOT EXISTS`), double as the pre-deploy script, take `pg_advisory_xact_lock`, `lock_timeout 5s`, and `SET LOCAL ROLE` to the table owner (decisions D1, D3, B2); destructive steps get their own release.

| Step   | Content                                                                                                                                                                                                                                                                                                                                          | Rollback                                                                                                 |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| **R0** | Migration `0030_user_org_api.sql` (the next number after the train's 0029): `app_user.metadata jsonb NOT NULL DEFAULT '{}'`; `contact_change_audit` (append-only; FK to `app_user` `ON DELETE SET NULL`; **no contact values**); no new org index (Phase 3's `organisation_parent_status_idx` serves the scope CTE). Additive and inert for N−1. | none needed                                                                                              |
| **R1** | `resolveActor`, `policy.ts`, **read** routes (`org/read`, `org/search`, `user/read`, `user/search`) behind the flag. Shared schemas subpath. `dump-openapi.ts` flag, the legacy-paths snapshot test.                                                                                                                                             | flag off                                                                                                 |
| **R2** | **Write** routes: create/invite, metadata, parent, user update, `contact/update` with `ContactOtpService`, `updateIdentity`, `sms-provider`. Invite token + accept endpoint. Still behind the flag; exercised on a staging instance.                                                                                                             | flag off; rows written are ordinary rows                                                                 |
| **R3** | Admin login: portal gate change (`apply-portal-gate.py` + the deployment realm), owner enable at approval + one-off enable script, web layout routing, console screens W2–W7 and W1. Flag on per instance.                                                                                                                                       | gate reconciler restores the old gate; flag off; owners can be re-disabled by the same script in reverse |
| **R4** | Coordinator portal migrates screen by screen (W1 first, then registration). The old routes are still served and still tested. Optionally (D4-6) set `PROFILE_PATCH_CONTACT_ENABLED=false` on an instance once no client uses the old phone edit.                                                                                                 | per-screen revert                                                                                        |
| **R5** | Contract release: mark the old operations `deprecated: true` in the spec, retire the grant-token invite page, announce removal. Removal itself is a later major release.                                                                                                                                                                         | code-only                                                                                                |

**Gates:** R3 needs the Phase 2 V-check "every coordinator has `kc_sub`" at 0 missing (otherwise lazy stamping covers it, but the console lists would show gaps). R4 needs the R2 route tests green on staging with real SMTP and SMS.

## 8. Verification

| Layer                                                                     | What                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unit (Vitest, fakes per `.claude/rules/testing.md`)                       | A **table-driven authz matrix**: every §2.5 principal × every route → expected status (including 404 for out-of-scope). Schema tests for every `*RequestSchema` (strictness: `org_type` in metadata update rejected). `ContactOtpService`: TTL expiry, attempts cap, single use, address-swap rejection, no plaintext in Redis (assert on the stored value). |
| Route guard                                                               | Enumerate registered routes: every `/v1/org/*`, `/v1/user/*` declares `config.policy` and calls `requireActor` first.                                                                                                                                                                                                                                        |
| Contract                                                                  | `openapi-legacy-paths.test.ts` (§5.2); the existing drift check.                                                                                                                                                                                                                                                                                             |
| Integration (`*.integration.test.ts`, the Postgres CI job, decisions D15) | Shared-contact re-key cascades to all `app_user`, `aggregators`, `aggregator_orgs`; concurrent primary change (one wins, `LAST_ADMIN` never violated); parent move cycle and depth rejection; the scope CTE uses an index; KC `updateIdentity` against the realm (D4-8).                                                                                     |
| Web                                                                       | Component tests for the OTP modal and the console layout's actor routing; BFF route tests that they use `callApi`.                                                                                                                                                                                                                                           |
| E2E                                                                       | Extend the `aggregator-e2e` skill: owner login → invite admin → invitee accepts → contact change via email OTP (Mailpit) → coordinator portal still works unchanged.                                                                                                                                                                                         |

## 9. Risks

| Risk                                                      | Mitigation                                                                                                                                                                      |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Widening the portal gate lets an unintended population in | The gate still requires `decision_made=approved`; `org_owner` is only assigned at approval; the web layout re-checks via the DB actor. Integration test on the gate reconciler. |
| KC and DB diverge on a contact change                     | KC-first with compensation (§4.3), the same shape as profile PATCH; verify SQL compares `contact.email` with KC for a sample (script, counts only).                             |
| A new route skips the wrapper                             | The route-guard test (§2.3).                                                                                                                                                    |
| An SMS gateway is not available on some instances         | `OTP_CHANNEL_UNAVAILABLE` fail-closed; email-only change still works.                                                                                                           |
| Old and new routes disagree on invariants                 | One write path (stores + `contact-writes.ts`); both route families share the integration suite.                                                                                 |
| Masked-by-default surprises console users                 | Self-reads are unmasked; admins see masked values until Phase 5 RBAC grants `contact.unmask`.                                                                                   |

## 10. Decisions

| #              | Decision                                      | Options                                                        | Recommended                                                                                      |
| -------------- | --------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| D4-1           | Actor source                                  | token claims / **DB lookup by `kc_sub`**                       | DB lookup; no claim changes (Phase 2 P2-D7).                                                     |
| D4-2 ⚠ REVIEW  | May an org admin create child orgs?           | NF only / **org admin within limits**                          | Org admin within `max_children`/`max_depth`; the doc's multi-level model implies it.             |
| D4-3 ⚠ REVIEW  | Admin "create" semantics                      | active immediately / **always invite**                         | Always invite: consent must be the subject's own.                                                |
| D4-4 ⚠ REVIEW  | OTP for `contact/update`                      | KC SPI / **app-side** / hybrid                                 | App-side, with a new `sms-provider` port. Which SMS gateway (the one the SPI uses) is your call. |
| D4-5 ⚠ REVIEW  | Contact change on a shared contact            | refuse (Phase 1 D19) / **apply to all accounts of the person** | Apply to all; self-only; notify the old email.                                                   |
| D4-6 ⚠ REVIEW  | Profile PATCH still changes phone without OTP | leave / **per-instance flag to switch it off after R4**        | The flag, default on (no behaviour change until an operator flips it).                           |
| D4-7 ⚠ REVIEW  | Contact in new responses                      | plain / **masked by default, `masked` flag**                   | Masked from day one, so Phase 5 is not a contract change.                                        |
| D4-8           | KC username edit                              | assume it works / **verify in integration test before R2**     | Verify; if blocked, set `editUsernameAllowed` in both realms.                                    |
| D4-9 ⚠ REVIEW  | Admin login                                   | **widen the portal gate** / separate client                    | Widen the gate (§6.1 A).                                                                         |
| D4-10          | `contact/update` shape                        | one PATCH with `step` / separate `/verify` route               | One PATCH with `step`, to keep the doc's route list.                                             |
| D4-11          | Flag                                          | reuse `ORG_HIERARCHY_ENABLED` / **new `USER_ORG_API_ENABLED`** | New flag; the hierarchy flag keeps its current meaning.                                          |
| D4-12 ⚠ REVIEW | Which orgs `parent/update` may move           | **parent orgs only** / also coordinator orgs                   | Parent orgs only in Phase 4; moving a coordinator's org changes who approves it.                 |
