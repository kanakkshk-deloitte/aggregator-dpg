# CLAUDE.md — apps/api

Guidance specific to working inside `apps/api`. Read the root `CLAUDE.md` first (product/architecture overview) — this file covers what's non-obvious once you're actually editing files here.

## Auth is consistent but per-file, not framework-enforced

There is no global Fastify `preHandler` hook wired at `app.ts` level. All verification logic lives in one shared module, `services/auth/access-token.ts` (`authenticate`, `requireApproved`, `authenticateAny`), but **each route file re-declares its own thin local wrapper** around it — e.g. `requireAuth()` in `bulk-uploads.ts:769`, `requireApprovedAuth()` + `requireAuth()` in `dashboard.ts:589,610`. Every handler in a file calls its wrapper as its first statement (verified across all route files — no handler currently skips it), so today's code is consistent. But **nothing prevents a new route from omitting the call** — the build succeeds either way. If you add a route file, copy an existing wrapper rather than inventing a new pattern, and call it first in every handler.

Service-account-only endpoints additionally gate on `subject.startsWith('service-account-')` (`aggregator-maintenance.ts:145`) — `authenticateAny` alone accepts both end-user and service-account tokens and doesn't distinguish privilege level. **That check is known-broken and tracked separately** (`sub` is a UUID for service accounts too, on every client, so the `startsWith` can never match) — do not copy it into a new route. The correct discriminator, used by `requireActor` (`services/auth/actor/`), is `preferred_username` (`service-account-<client>` for a service account vs. the human username for a password-grant token on the same client).

## Registration status has no documented state machine — here it is

`AggregatorStatus = 'pending' | 'active' | 'inactive' | 'retired'` (`packages/db-schema/src/schema-types.ts:17`) is a bare type union in code with no transition diagram anywhere. In practice:

Every decision goes through **one service per entity** — `services/decisions/coordinator.ts` (`decideCoordinator`) and `services/decisions/org.ts` (`decideOrg`) — shared by the emailed review links and the console (`/v1/user/decision`, `/v1/org/decision`). Two deciders can race, so (Phase 5, design R3):

- **Reject** (`pending → inactive`) is a compare-and-set first (`userStore.rejectFromPending()` / `orgStore.reject()`, `WHERE status = 'pending'`, stamping the **write-once `rejected_at`**); only the winner stamps Keycloak and mails.
- **Approve** (`pending → active`) must provision Signals and enable Keycloak **before** its compare-and-set (`approveFromPending()`, the commit point). When that CAS loses to a concurrent reject (or the row is gone) it **compensates**: the Keycloak user is disabled and stamped `rejected` again. An org approval is CAS-first (owner access is granted after it wins).
- The loser gets `already_decided` (`409 ALREADY_DECIDED` with `status`, `decided_at`, `decided_by: link | console | null` on the console; the "already decided" page on a link). The compare-and-set writes `updated_by` itself: the deciding admin's `users.id` (console) or `'admin'` (a link; `LINK_DECIDER`). `decided_by` is read back from it (`deciderOf`), so a later write (a profile edit by `'self'`) makes it `null`, never a wrong answer. A failed or lost approval disables the Keycloak user again; the Signals org id is written to the row only after the approval wins.
- The free-text reject `reason` is mailed, never logged or stored.
- **The stale prune is race-safe too** (C3): `deleteIfPending(id, cutoff, beforeCommit)` deletes only a still-pending, still-stale row and runs the Keycloak delete inside that transaction while holding the row; a Keycloak failure rolls the row back, a decision that landed first leaves it alone.
- `retired` exists in the type but its transition path isn't in the approval routes above — check `aggregator-maintenance.ts` before assuming where it's set.

**Rejection cooling window (#726).** A rejected coordinator/org cannot re-register until `REGISTRATION_COOLING_MINUTES` (default `720` = 12h) has elapsed since `rejected_at`. The window is measured from the **write-once `rejected_at`**, never the mutable `updated_at` (any later write would move it — the race we designed around). On the public submit path (`aggregator-registrations.ts` email+phone, `aggregator-orgs.ts` owner_email) a rejected match within the window → `409 REGISTRATION_COOLING` with `error.fields.retry_after` (ISO); once elapsed the **same row is revived** to `pending` (`rejected_at` cleared) and the review link re-sent — the disabled Keycloak user/group stay intact, nothing is deleted or re-created. The shared verdict helper is `services/registration-cooling.ts` (`coolingRetryAfter`), imported by both routes so they can't drift. `rejected_at` is `NULL` for rows rejected before migration `0021`; the helper falls back to `updated_at` for those.

## Consent lives only in the ledger, written in the create transaction (migration 0029)

`consent_record` (was `aggregator_consent_record`) is the only home of consent: `users.consent` is gone, and the profile's `consent` is composed from the coordinator's newest `registration` / `registration-backfill` row (`given_at` = its `accepted_at`). Rows carry the permanent audit key (`subject_type` `user` | `organisation` + `subject_id`) and typed `user_id` / `org_id` links that drop to NULL when the subject is deleted; a trigger refuses every other UPDATE and every DELETE.

Registration is fail-closed in **one transaction**: `aggregatorConsentWriter()` (`routes/aggregator-registrations.ts`) and `orgConsentWriter()` (`routes/aggregator-orgs.ts`) read the consent config first, then hand `store.create()` a `recordConsent` hook that writes the ledger row **inside** the create transaction (through `getConsentLedger().withExecutor(tx)`). A ledger failure throws, so the contact, the account / org and the consent all roll back and the store answers `CONSENT_WRITE_FAILED`. Keycloak is provisioned only after that commit. **Do not move the ledger write out of the transaction or after provisioning** — that would let a subject exist without a consent record. Rows of subjects deleted later (a Keycloak failure, the stale prune) stay, unlinked. The profile PATCH refuses `consent` (400): consent is read-only after registration.

**Consent is recorded once, at registration — the profile PATCH cannot change it (ae842508, breaking).** `PATCH /v1/aggregators/profile/me` has no `consent` key and its body schema is `.strict()`, so a body that sends `consent` is refused with `400 SCHEMA_VALIDATION`; the store's update path no longer writes `aggregators.consent`. Do not re-add it — a client-supplied consent object would let the stored record and the append-only ledger disagree.

## Known gap: Keycloak calls have timeout but no retry — flagged, not fixed here

`.claude/rules/error-handling.md` requires "retry transient failures at least once with exponential backoff" on every external call. `services/idp-admin/keycloak.ts` (582 lines) routes every admin call through `safeFetch` (`:530`), which applies `AbortSignal.timeout(HTTP_TIMEOUT_MS)` uniformly — but **there is no retry loop anywhere in this file**. This is a real, verified deviation from the repo-wide rule, not a doc gap. If you're touching this file for an unrelated reason, don't assume retry exists; if you're adding retry, be aware Keycloak admin calls (user enable, role assign) are not all naturally idempotent — check each call site's side effects before wrapping it in a blind retry.

## Accounts live in `users` (migration 0027)

`aggregators` was renamed `users` (ids kept: the Keycloak `aggregator_id` attribute, the token claim and the Signals `external_id` still point at the same rows). Things that are easy to get wrong:

- **Two account types share the table.** `user_type = 'coordinator'` rows are coordinators (registration state + their own Signals org: `signalstack_org_slug` / `signalstack_org_name` / `signalstack_org_id`). `user_type = 'admin'` rows are org owners and hold **identity only** — every coordinator column is NULL (`users_role_shape_chk`). The column defaults (`status`, `profile`) remain for coordinator inserts, so an admin insert must write explicit NULLs — use `db/account-writes.ts` `linkAdminAccount`, never a hand-written insert.
- **The user store sees coordinators only.** Every read AND write in `services/user-store/postgres.ts` goes through `coordinator(...)` (`user_type = 'coordinator'`). An admin id must never resolve as an aggregator — keep that filter on any new query.
- **An org's owner is `organisations.org_owner`** (an admin account; one per person, shared by every org they own; `owner_user_id` before 0028). Deleting an org releases the owner's account once it owns nothing else — a database trigger (`organisations_owner_ad`), whatever path deletes the org. A Keycloak owner user is deleted by the stale prune only when the owner has no other org (`orgStore.ownerIsShared`).
- **IdP logins are provider-neutral** — `user_identities (user_id, provider, subject)`, provider `IDP_PROVIDER` (`services/idp-admin/provider.ts`). Recorded once, never overwritten (`MISMATCH`), one account per external login (`DUPLICATE`). Coordinators' logins are recorded lazily (review link, first approved request) via `services/identity-store/record.ts`.
- **Coordinator columns since 0029:** `serves text[]` (network domain ids; `'{}'` = every domain; the domain object's `type` is its first entry, and `actor_type` is always `'aggregator'`), `alternate_phone` (the Beckn `contact.alternatePhone`), `invite_id` (the consumed invite; the invited address is read through it, else `profile.legacy_invite_email`). Admin rows have `serves = '{}'` and NULL for the others (`users_role_shape_chk`).
- **Drizzle names follow the columns** (0029): `users.signalstackOrgSlug` / `signalstackOrgName`, tenant tables' `userId`, `onboarding.signalstackOrgSlug`, `campaignPiiAudit.actorSignalstackOrgId`, `registrationStatusEnum`; the `aggregators` / `aggregatorOrgs` aliases are gone. The domain objects, the session and the queue payloads keep `aggregatorId` (the token claim is renamed in Phase 5), and the store directories keep their names until then.
- **Migrations at boot are guarded** (`db/migration-guards.ts`): `runMigrations()` refuses an applied migration that is not in the journal, and refuses to apply the user & org instance upgrade (0023 onwards) at boot on a database that holds data — existing instances migrate with the instance-upgrade tool (`src/tools/instance-upgrade.ts`, run from the API image; `docs/user-org-migration-runbook.md`). Dev / e2e databases can set `ALLOW_TRAIN_ON_BOOT=true`; never a deployment.
- **The instance-upgrade tool** (`src/tools/instance-upgrade.ts`, `node dist/tools/instance-upgrade.js check | run | data | enrich | enable-owners`, or the whole DB+Keycloak sequence as one resumable, validate-then-run command `run-all --snapshot-taken <id>`) is split into **three layers**, run in order:
  - **Schema** — `run` takes a database from exactly 0022 to the latest migration in **one transaction** that applies every migration (`db/migrate-core.ts` `applyPending`, which writes the same `__drizzle_migrations` rows drizzle does) and runs every verify gate, committing only when all are 0. The migrations hold the DDL **and the DML coupled to it** (a constraint backfill, a retype that reads the column it then drops, a seed→re-point→constrain sequence): that data move is part of the schema change and must stay in the migration.
  - **Standalone data** — `data` (`instance-upgrade-data.ts`, loaded lazily) runs data migrations that have **no** ordering dependency on a DDL step, each in its own transaction with a verify. `DATA_STEPS` is **empty** today (0027–0029's data moves are all schema-coupled); it is the home + policy for future ones. Config-free, like `check` / `run`.
  - **External deps** — `enrich` / `enable-owners` (`instance-upgrade-online.ts`, loaded lazily) do the Keycloak work; they need the full API env. (The boot reconcile `services/organisation-root.ts` is the runtime half of this layer.)
  - `check` / `run` / `data` are **config-free** (no `config.ts` import; only `DATABASE_URL` + `AGGREGATOR_NETWORK`). The operator SQL lives in `scripts/sql/` (`instance-upgrade-check.sql`, `*-verify.sql` with a `category` column, `fixes/`) and is copied into the image at `/app/sql`. It never prints row data — keep it that way. **Rule for a new migration:** DDL + only schema-coupled DML in the `.sql`; standalone data in a `DATA_STEPS` entry; external work in the online step.

## Person contacts live in `contact` (migrations 0025 / 0026)

A coordinator's and an org owner's name / email / phone are stored once, in `contact`, and referenced by `users.contact_id` (since 0027 an org owner is an admin `users` row; every FK to `contact` is named `contact_id`; a second one in the same table would take a role prefix). The stores compose the Beckn `contact` the API has always returned (`contact` row + `users.alternate_phone` for `alternatePhone`, and the org's `legal_name` / `gst_number` for `company` / `gstNumber` since 0028), in the legacy jsonb key order, so responses are byte-identical to before. Things that are easy to get wrong:

- **`contact.id` is PII.** It is `sha256(lower(email):phone)` (`contactId()` in `@aggregator-dpg/shared-primitives/contact`, `contact_id_of()` in SQL — golden vectors pin them together). Never log it or put it in a URL.
- **One person per email and per phone, across coordinators AND org owners** (`contact_email_unique`, `contact_phone_unique`). The phone is the OTP login key. Org create pre-checks this (`PHONE_EXISTS` / `OWNER_ALREADY_REGISTERED`) and profile PATCH too (`PHONE_EXISTS` / `USER_EXISTS`), both before touching Keycloak; the unique indexes are the backstop.
- **Write through `db/contact-writes.ts`, inside the store's transaction.** Changing an email or phone re-keys the row in place (FKs are `ON UPDATE CASCADE`). It is refused when the contact is shared by two roles (`SharedContactError` → 409 `CONFLICT`) or when the new email + phone already form another person's contact (`ContactTakenError` → `USER_EXISTS`); rows are never merged.
- **Orphan contacts are collected by the database** (`contact_gc()` from the `users` `AFTER DELETE` trigger; an org delete releases its owner's account first) — do not add app-side deletes.
- **Store errors never echo the driver message**: Drizzle puts the query parameters (emails, phones) in it. Log the SQLSTATE and constraint name instead.
- **Existing instances run a pre-flight before deploying** — `docs/contact-migration-runbook.md` (stop-the-world; `scripts/contact-migrate.sh preflight | dry-run | apply | verify`). 0025 is also the pre-deploy script, so it must stay idempotent.
- **A new migration's journal `when` must exceed every earlier entry's.** The migrator skips by that high-water mark, not by hash, so a smaller `when` is silently never applied. `runMigrations()` holds an advisory lock, so replicas booting together are safe.

## Organisations (migration 0028)

`aggregator_orgs` was renamed `organisations` (ids kept) and the hierarchy flag is gone: the org routes are always registered. Things that are easy to get wrong:

- **One root, one Default.** Exactly one `org_type = 'network_facilitator'` org (the root, `parent_id` NULL); every other org is `aggregator` under it. An org registers under the root (no `parent_id`) or under an active non-Default aggregator org (`GET /v1/orgs/parents` lists the choices). `organisations.depth` (root 0) is set by the store; `max_depth`, `max_children` and `max_total_orgs` (config `aggregator.organisation.hierarchy`) are checked under one advisory lock (`aggregator-dpg:org-tree`) taken first in every tree write: create, revive of a rejected org, move (`PATCH /v1/org/parent/update/:id`, network admin), a `known_as` change and a `known_as_values` list change. Each org defines the "known as" values of its direct children (table `org_known_as`, one row per org holding the list as jsonb in the shape the API serves; no row for an empty list; `known_as_values` on the wire); a child's `known_as` is a key from that list or the built-in `aggregator`, with no depth rule. The `Organisation` domain object does not carry the list: read it with `orgStore.knownAsValues(id)`, and `known_as_name` is picked from the parent's row by a join. Only `GET /v1/org/read/:id` and `GET /v1/org/hierarchy` return a list, and only when `fields` asks: the read's `fields=known_as_values` adds `org.known_as_values`, its `fields=parent.known_as_values` adds `org.parent` (`{ id, name, known_as_values }`, the parent's stored list; `null` unless the caller owns the parent), and the hierarchy's `fields=known_as_values` adds `network.known_as_values`. The choices for a child (`knownAsChoices`: the parent's list, else only `aggregator`) live in `@aggregator-dpg/shared-primitives/user-org`, so the API and the console share them. `OrgSchema` has no list; the read uses `OrgReadOrgSchema`; the `fields` parameter is built with `fieldsQuerySchema` from `@aggregator-dpg/shared-primitives/dto`. See `docs/org-hierarchy.md`. The fixed **Default** org (`slug = 'default'`, `DEFAULT_ORG_SLUG`) holds coordinators that had no org. Both are owned by admin accounts reconciled at boot by `services/organisation-root.ts` (`ensureRootOrganisation()`: root owner = first `ADMIN_EMAILS`, Default owner = `DEFAULT_ORG_OWNER_EMAIL` else the root's; also mirrors both orgs and configured owners into Keycloak and gives those owners sign-in access, soft-failing). A configured address that is a coordinator's, or a Default owner who already owns another org, is **refused** (logged; the current owner stays): one login is one account. A replaced owner leaves the group; once it owns nothing it loses `org_owner` and its sessions, and is disabled only when its Keycloak user carries `created_by = aggregator-owner` (a reused login may be a Signals account). The migration seeds placeholders (`network`, `network-admin@nf.invalid`).
- **The organisation store sees aggregator orgs only.** Every read and write in `services/organisation-store/postgres.ts` goes through `scoped()` (`org_type = 'aggregator'`); only `findRoot()` returns the root. Owner lookups (`findByOwnerEmail` / `findByOwnerPhone`) also skip the Default org — the network admin owns it and must not read as "already an org owner". The store keeps its `displayName` field for now.
- **Every coordinator has an org** (`users.org_id`, required by `users_role_shape_chk`); `Coordinator.parentOrgId` is that id, Default included, and `isDefaultOrg` says which. Coordinator registration requires `org_id` or an invite (`400` otherwise). The Default org is selectable only while it is the only active org (`GET /v1/orgs` hides it otherwise); a Default registration names its own organisation (never "Default").
- **Approval tokens always carry the org claim**, Default included; the decision path rejects a mismatch. A link without the claim (minted before 0028) is refused on read, decision and regenerate; regenerate binds the fresh token to the coordinator's current org and never re-binds a link minted for another org. Default-org reviews go to `DEFAULT_ORG_OWNER_EMAIL`, else `ADMIN_EMAILS`.
- **Org details belong to the org.** `url`, `locations`, `contact.company` and `contact.gstNumber` are rendered from the coordinator's org (`organisations.profile` keys `website` / `gst_number`, columns `locations` / `legal_name`), falling back per field to the coordinator's own values in `users.legacy_org_details` (`services/user-store/org-details.ts`). Profile PATCH of any of them → `409 ORG_DETAILS_READ_ONLY`, and so does a coordinator registration that sends `url` / `locations` for a real org; a Default registration keeps them as `legacy_org_details`. The `organisations.url` / `gst_number` columns are no longer read or written (migration 0033 copied their values into `profile`); they are dropped in a later migration. The Default org's details are never editable.
- **Org fields are schema-driven.** Every field of the deployment's `org-registration.v1.json` except `display_name`, `owner`, `consent`, `address` and `state` lives in `organisations.profile` (the default schema has `website`, `gst_number`, `domains`; brands add their own). `services/org-schema-validator.ts` compiles that schema with Ajv and validates these fields at registration (`POST /v1/orgs/create`; keys the schema does not declare are dropped) and on console edits (`profile` in `PATCH /v1/org/metadata/update/:id`; only properties marked `x-updatable`; `null` removes a key; the store merges keys in one statement). Markers it reads: `x-network-domains` (choices = the network's domain ids), `x-check: "gstin"` (GSTIN check character via `@aggregator-dpg/shared-primitives/org-details`, stored upper-cased); formats and messages come from the schema's `pattern` + `x-error-message`. A bad field answers one `400 SCHEMA_VALIDATION` with `fields.field_errors` (field → message) and saves nothing; stored values are never re-checked. A new org field is a schema change only. Name, `legal_name`, `description` and `locations` stay fixed fields (columns). Only the org's owner edits any of them; anyone else in reach, the network admin included, gets `403` and sees the details read-only. `known_as` is not an org detail: the owner of the org's parent sets it through `PATCH /v1/org/known-as/update/:id` (the network admin for a top-level org, `ownsParentOf` in `routes/v1-org.ts`), and an owner edits its own `known_as_values` list through the same route (body `known_as_values` instead of `known_as`; the response adds the saved list). Org create maps `address` / `coordinates` to `locations` (`services/org-location.ts`).
- **Tenant rows carry `org_id`** (the user's org at insert time), filled by a `BEFORE INSERT` trigger (`tenant_set_org_id`) — inserts never pass it.

## Console: `/v1/user/*` and `/v1/org/*` (Phase 5)

Org owners and the network admin sign in to the same portal (the Keycloak gate admits the `org_owner` realm role; see the root `CLAUDE.md`) and manage their orgs through `routes/v1-user.ts` and `routes/v1-org.ts`. Things that are easy to get wrong:

- **Who is calling comes from the database, every request.** `requireActor(req)` (`services/auth/actor/`) verifies the token, refuses a service account (`preferred_username` starts with `service-account-`), then resolves: a token with `aggregator_id` → that coordinator, **only when its recorded login (`user_identities`) is this token's subject** (the database, not a token claim, is the authority for who a coordinator is); without → `user_identities` by subject → an admin and the active orgs it owns (never by email). No account → `403 USER_NOT_PROVISIONED`; an admin owning no active org → `403 NOT_ORG_ADMIN`; a coordinator not approved → `403 NOT_APPROVED`. Only `GET /v1/user/read/me` admits a coordinator. The resolver's contract mirrors RBAC's `ActorResolverBase` (handoff: `docs/plans/phase-5-rbac-handoff.md`).
- **The network admin is the root's owner** (the first `ADMIN_EMAILS`). Like every owner, it reaches only what it owns: the root and the orgs it owns (the Default org) and their coordinators; an owner reaches the orgs it owns (Default included when it owns it) and their coordinators. `reachableOrgIds` never means "every org". With RBAC enforced, coordinator management (`/v1/user/search`, `read/:id`, `decision`, `metadata/update`, `create`) also needs `org.manage` in the coordinator's org (`services/authz/manage-scope.ts`, #873); the shipped Network Admin role lacks it, so the network admin manages coordinators only in orgs it owns, and out-of-scope ids answer 404. Listing and reading coordinators (`user/search`, `read/:id`) also accept `network.administer` with a `view` scope, but the scope stays the orgs the caller owns: nobody sees the coordinators of an org it does not own, the network admin included. The org routes (`org/search`, `read`, `metadata/update`) take `org.manage` or `orgs.onboard` (`anyCapability`). Those route-level permissions are decided at the edge (next section); `manage-scope.ts` is the API's own per-organisation check.
- **An owner also reads, view-only, the direct children of its own orgs, and nothing deeper** (`services/authz/view-scope.ts`, `orgStore.childIds`). The network admin owns the root, so it reads the top-level orgs. Org read/search use this view reach; a search filter (`parent_id`, `descendants_of`, `status`, `name_prefix`) only narrows it, so no request returns a grandchild. Coordinator read/search keep the owned reach. Every write (edits, invites, roles, org metadata) keeps the owned reach; editing a visible child answers 403, anything deeper 404. The owner contact of a child org is masked in every RBAC mode, and those reads log `relation: 'below'`.
- **An org's registration is decided by its parent's owner.** The review email goes to the parent org's owner (`services/org-registration-notify.ts`; `ADMIN_EMAILS` for a top-level org), and `POST /v1/org/decision/:id` answers 404 to anyone but the parent's owner. Every owner may decide: the built-in Org Admin role holds `orgs.onboard` (migration 0035). A rejection must carry a reason, on the console route (`OrgDecisionRequestSchema`) and on the emailed review page. RBAC is unchanged: roles held in an org do not apply below it (`docs/org-hierarchy.md`).
- **Out of reach is `404`, not `403`** (`services/authz/scope.ts`), so ids cannot be probed; `403` means the actor's kind cannot use the route at all (an owner on `org/access/repair`, a caller setting `known_as` on an org whose parent it does not own, the network admin editing the details of an org it does not own). A search with an out-of-reach `org_id` is an empty page.
- **The Default org takes no invites and its details are not editable**, for every principal. Its owner still decides its coordinators.
- **Contact data is plain within reach** (P5-8); every single read (`user/read/:id`, `org/read/:id`) logs actor id and target id. Console logs carry ids and field names only — never values, contact data or a reject reason.
- **The network admin acting in someone else's org mails that org's owner** (`notifyOwnerOfAdminAction`, what changed by field name): coordinator invites, decisions and domains served, and an org move. When the owner of a parent org changes a child's `known_as`, the child's owner gets its own email (`notifyOwnerOfParentAction`), unless the same account owns both.
- **Decisions and edits share a per-actor budget** (`CONSOLE_WRITE_RATE_*`, fail-open). Invites have no per-organisation hourly limit, by decision: throttling how often invites are sent is the API gateway's job (Kong), not the API's. Each request is capped at `INVITE_MINT_MAX_RECIPIENTS`, and the grant-authed `/invites` route also has a per-IP throttle. The console invite reaches the API from the web BFF inside the cluster, so only the gateway limit on the web host applies to it.
- **Invites** (`POST /v1/user/create`) share `services/invites/mint.ts` with the grant route: an address already a coordinator of this org is reported under `existing` and not mailed; any other existing account gets a "you already have an account" mail and counts as `sent` (no probing).
- **Owner access.** Org approval enables the owner's Keycloak user, grants `org_owner` and adds the group (`grantOwnerAccess`); `POST /v1/org/access/repair/:id` re-runs it; the release's one-off `train enable-owners` does it for owners approved before Phase 5. No invite grant is minted any more (approval, expired-grant recovery and the "already registered" resend all mail the sign-in link); grants already sent work until they expire.
- **Paging is keyset with an opaque cursor** (base64url JSON): coordinators by `(date_trunc('milliseconds', created_at) desc, id desc)` — the cursor is a JS `Date`, and rows inserted in one transaction share an instant, so both sides compare at millisecond precision — orgs by `(lower(name), id)`.

## Route permissions are decided at the edge, not in the API

An Envoy + OPA edge in front of the API decides every route's permission before the request arrives (`docs/rbac/rbac-edge-enforcement.md`). The API does **not** check route permissions itself any more (decision E6: each check exists in one place). Things that are easy to get wrong:

- **`config.rbac` is still required on every route**, and the app refuses to boot without it (`assertRouteDeclared`). It is no longer enforced here: `pnpm --filter @aggregator-dpg/api routes:dump` exports the declarations to `policy/rbac/edge/routes.json`, which the edge policy (`policy/rbac/edge.rego`) matches requests against. **A changed declaration needs `routes:dump` re-run**; CI fails on drift.
- **The API keeps what the edge cannot decide**: account state (`requireApproved`, `requireActor`), reach (404), the per-organisation checks (`manage-scope.ts`, `checkCapability` with `strict` on role assignment), contact masking and the assignment rules. `recordRouteCaller` only records a coordinator's login.
- **An instance with `RBAC_MODE=enforce` must run the edge.** The API cannot tell whether one is in front of it (decision E7). Without it, every route that predates RBAC still has its account-type checks, but nothing checks the route permission.
- **The edge reads roles from the token's `roles` claim**: a multivalued, admin-only Keycloak user attribute that the API keeps in step (`services/authz/token-roles.ts`). It is rewritten after every role change (assign, revoke, leaving an org, a coordinator decision, an org approval), by a sweep every `RBAC_TOKEN_ROLES_SWEEP_MS` (failed writes, expired PII Access) and by a full reconcile at boot and every `RBAC_TOKEN_ROLES_RECONCILE_MS` (`token-roles-sweep.ts`). **A new path that adds or removes a role must call `requestTokenRolesSync`.** A revoked role keeps working until the user's token is refreshed, about 5 minutes (decision E6).
- **The edge's role catalogue comes from the API**: `edge-catalogue.ts` pushes the snapshot and the RBAC mode to OPA (`PUT /v1/data/catalogue`) at boot and on every refresh tick. OPA down, or empty after a restart, refuses everything (fail closed).

## RBAC built-in roles are seeded by migration, not loaded from config (0031)

The six built-in roles and the permission catalogue live in **code** — `BUILTIN_ROLES` and `CAPABILITIES`/`permissionDefinitions` in `packages/rbac` — and are seeded into the `permission` / `role` / `role_permission` tables by migration **`0031_rbac_seed.sql`** (0030 creates the tables). There is **no `config/rbac.yaml`** and no per-network/brand override any more: built-ins are identical on every instance and change only with a **new migration** (never by editing 0031 — the migrator skips an applied migration by the journal high-water mark). `initRbac` (`services/authz/runtime.ts`) just loads the role snapshot at boot — no file load, no sync. Custom roles are still written at runtime (`custom-roles.ts`). Changing a built-in role means editing `BUILTIN_ROLES` **and** adding a migration with upsert INSERTs; the integration drift test (`services/rbac-catalogue/__tests__/postgres.integration.test.ts`) fails until the seed matches `permissionDefinitions(CAPABILITIES)` + `BUILTIN_ROLES`. 0031 is generated from those two sources, so regenerate rather than hand-edit.

## CUSTOM-ROLES deploy toggle (`RBAC_CUSTOM_ROLES_ENABLED`)

A deploy-time switch for the network-admin role-authoring capability, **default
`false` (opt-in)**, `config.ts` next to `RBAC_MODE`. It is **subordinate to
`RBAC_MODE`**: with `RBAC_MODE=off` nothing is loaded and this flag has no
effect. When it is off (and RBAC is on), the full-off semantics are:

- **One gating point:** `loadSnapshot` (`services/authz/runtime.ts`) drops
  non-built-in roles, so the in-process snapshot is built-in-only everywhere —
  at boot (`initRbac`) and on every refresh (`refreshOnce`). Existing custom-role
  **assignments go inert automatically** because `effectivePermissions`
  (`packages/rbac`) skips any held role absent from the snapshot; the rows are
  **not** deleted and revive if the flag is turned on.
- **Authoring routes are not registered.** `POST /v1/roles/create`,
  `PATCH /v1/roles/update/:key`, `POST /v1/roles/delete/:key` exist only when the
  flag is on — off they 404 and are absent from the OpenAPI spec. `GET /v1/roles`
  stays registered (built-in-only via the snapshot). The three
  `custom-roles.ts` functions also carry a `custom_roles_disabled` guard that
  maps to the same 404 (defense in depth; the primary gate is not-registering).
- **`GET /v1/user/roles/:id` filters inert assignments.** When off, `listUserRoles`
  drops `additional` rows whose role is not in the (built-in-only) snapshot, so
  the read matches what actually grants anything.
- **Surfaced to web:** `GET /v1/aggregator-config` always carries
  `features: { custom_roles: <flag> }` (always-present, like `signals_ui_urls`).
- **Only the edge limits authoring to the network admin** (`network.administer`,
  strict). Inside the API the three routes call `requireActor`, which admits
  any org owner, so an instance that turns the flag on must run the edge
  (decision E8).

## Bulk-upload: the API only validates, reserves, and enqueues

Streaming CSV parsing is entirely `apps/worker`'s job (see `apps/worker/CLAUDE.md`). The API side (`routes/bulk-uploads.ts`) does: presigned S3 PUT → `/start` validates the object exists via `headObject` (size-0 check + `BULK_UPLOAD_MAX_BYTES` as belt-and-braces, since a presigned PUT can't itself cap size) → `store.markUploaded` → `enqueueBulkFileProcess` (`services/bulk-queue/index.ts`, `jobId = uploadId` for idempotent enqueue — a retry of `/start` can't double-enqueue). If enqueue fails after `markUploaded` succeeds, the row is left `uploaded` with no active job — recovery relies on the worker's stuck-job watchdog (`cron-watchdog.ts`, see `apps/worker/CLAUDE.md`), not a retry here.

**Rate limits (#848).** Two fixed-window Redis buckets in `services/bulk-upload-rate.ts`, keyed by the authenticated user id (i.e. per coordinator): `POST /v1/bulk-uploads` allows **5 per hour** and `GET /v1/bulk-uploads/template` **30 per hour**. Exceeding either returns `429 RATE_LIMITED` with `retryAfterSeconds`. The numbers are hard-coded constants, not env config, and the limiter fails open on a Redis error.

## Health probes & observability

`/health/live` is a static liveness probe (no dependencies). `/health/ready` probes Postgres (`select 1`) + Redis (`ping`) with a 2s per-dependency timeout, returning `503` and naming the failing dependency otherwise. On `SIGTERM` the shutdown path drains Fastify and the PG pool, then `Promise.allSettled` closes the rate-limiter, Redis, and the bulk queue — **do not add a long-lived connection without also closing it here**, or shutdown will leak it.

`signalstack-writer` forwards an optional `requestId` as the `x-request-id` header from request-scoped call sites (dashboard, public-lookup, registration-links, approvals) so a trace correlates across services. The worker `onboard`/login-backfill paths have no request context and don't propagate it (known follow-up).

A Signals `409 PROFILE_LIMIT_REACHED` is mapped to `SIGNALSTACK_PROFILE_LIMIT_REACHED` and categorised as `limit_reached` (not `system_error`) in `errors.csv`, and surfaced on registration links. More generally, the bulk worker classifies a failed push by **Signals' own error code** (forwarded by the writer as `details.upstreamCode`), using `SIGNALS_REJECTION_CATEGORY` in `apps/worker/src/jobs/bulk-row-process.ts`. Row-data rejections (`INVALID_ITEM_STATE`, `FST_ERR_VALIDATION`, `MISSING_IDENTIFIER`, `AGE_REQUIRED`, `USER_LEVEL_INCOMPLETE`, `CONSENT_DECLINED`, `U18_NOT_ALLOWED`, `LOCATION_OUTSIDE_COUNTRY`) are `validation`; `DOMAIN_LOCKED`, `USER_ALREADY_EXISTS` and `IDENTITY_CONFLICT` are `duplicate`; anything unlisted stays `system_error`. A non-system row's errors.csv reasons are Signals' per-field `fields` as `field: message` lines (signals-dpg#785), else its bare `message`, never the `signalstack [CODE]: …` transport chain. A new Signals data error is one line in that table. Note that `onboard` is **no longer idempotent** — it always inserts, bounded only by the profile cap.

## Public registration submit — two things that are not obvious from the route

**`item_locations` is transport metadata, not a profile field (#778).** The submit body may carry `item_locations` — the coordinates the registrant picked from the address autocomplete. `public-registration-links.ts` reads it and then **deletes it from the body**, exactly like the consent and birth-year keys, so it never reaches Ajv or the signalstack `item_state`. It is validated locally (strict numbers, lat/lng bounds, max 25 entries) rather than forwarded blind: signals would answer with its own 400 that this route cannot attribute back to the offending key. Absent or empty means no suggestion was chosen — or no Maps key is configured — and signals geocodes the address text instead, which is the behaviour that predates the field.

**The local `participants` mirror is gone (#780, then migration 0024).** It deduped per phone and used to report `skipped`, which after the client-side gate came down meant a participant was told "already registered" while a second profile had just been created upstream — it pushed to Signals regardless of its own UPSERT result, so the local verdict was simply wrong. #780 stopped it deciding the outcome; 0024 removed the table. Signals is the identity authority; the route skips **only** when the identity is genuinely owned by ANOTHER aggregator — tenant isolation, not deduplication, and sourced from Signals' `owned_elsewhere`, never from a local row. The `link_submissions` row is still inserted before the push and corrected in the same transaction, so a submission that created a profile is never recorded as a duplicate.

**There is no deduplication on either onboarding path.** Verified empirically: two identical public-link submissions both return 201 `passed` and produce two distinct Signals profiles. This is consistent with the `onboard` note above — it always inserts. If dedup is wanted it belongs in Signals, where the identity actually lives; a per-aggregator table cannot see other aggregators anyway.

**A rejected field is named, never a generic push failure (#904).** The route's own Ajv failure returns `400 SCHEMA_VALIDATION` whose `detail` reads `Website: Please enter a valid web address.` (one sentence per field, Signals' wording via `@aggregator-dpg/network-config/field-errors`) plus `fields.field_errors`. A Signals `400 INVALID_ITEM_STATE` on the push is the participant's data, not a server fault: it is returned as the same `400 SCHEMA_VALIDATION` with Signals' per-field messages, not `502 SIGNALSTACK_PUSH_FAILED`.

**Brand `attribution` on `/v1/aggregator-config` is opt-in (signals-dpg#720).** The response only carries an `attribution` array when the resolved `brand.json` declares one, so every deployment that does not is byte-identical to before.

## Campaign PII audit log (#617)

`campaign_pii_audit` is **append-only** and records every campaign action that
**releases data** — export, voice and email. Status/list GETs are deliberately
NOT audited: the rule is data release, not API traffic, and clients poll every
5-10s.

- A campaign writes **two** rows sharing `correlation_id = campaign_job.id`:
  `requested` from the API, `completed` from the worker on terminal status.
- `event` is the phase, `outcome` is the result. `outcome` is NULL on
  `requested` rows.
- `piiFields` (on the `requested` row) carries **field NAMES and counts
  only, never values** — see the interface's module doc
  (`packages/campaign-audit/src/interface.ts:8-9`). The voice channel is the
  one place this needed active enforcement: `content.variables` is
  caller-supplied free text (not a schema-validated field-name list), so
  before it is copied into `piiFields` it passes through
  `apps/api/src/campaign/audit-field-names.ts`'s
  `sanitizeAuditFieldNames`/`auditFieldNameEntries`, which keeps only
  identifier-shaped strings, each at most `MAX_FIELD_NAME_LENGTH` (64) chars,
  and at most `MAX_FIELD_NAME_COUNT` (50) of them per row, replacing whatever
  it drops with a count — `+N redacted (non-identifier)` for shape failures,
  `+N redacted (too long)` for an over-length entry, `+N redacted (over
limit)` once the count cap is reached — three distinct markers, never
  folded together, so each count means what it says and never the raw value
  itself. Known residual gap: a single-word ASCII value up to 64 characters
  (e.g. a first name with no space) is indistinguishable from a real field
  name by that filter and passes through unredacted; don't rely on it to
  catch that case.
- The writer (`@aggregator-dpg/campaign-audit`) is **write-only** — no update,
  delete or read. That absence IS the append-only guarantee; do not add one.
- Writes are **best effort**: they happen after the operation is already durable
  and never fail a campaign.
- The `completed` row carries the four outcome-count columns
  (`resolved_count`, `skipped_count`, `failed_count`, `sent_count`), plus
  (export channel only) `recipient_ref` and `destination`. All are populated
  at every point that writes a `completed` row — the worker's success
  roll-up and final-attempt-failure paths (`campaign-process/index.ts`), and
  the watchdog's stalled-job sweep (`jobs/cron-watchdog.ts`, see below) —
  from `rollUpStatus`/`countItems`'s item-status tally
  (`services/campaign-job-client.ts`), never re-queried separately.
  `toAuditCounts()` (same file) does the mapping:
  - **`resolved_count` ← `resolved + submitted`.** Voice items terminate at
    `submitted`, never `resolved` or `sent` — handing a contact to Raya IS
    the release, so it must be counted. Without this, a fully successful
    voice campaign would audit as `outcome: 'succeeded'` with every count at
    zero, which reads as "measured, and nothing happened" rather than "not
    measured" — worse than leaving the columns null. This mirrors
    `deriveJobStatus`'s own `succeeded = resolved + submitted + sent`
    grouping, so the counts and the derived status agree about what counts
    as a release. `sent_count` stays strictly confirmed-delivered (export/
    email's own success write).
  - **`skipped_count` aggregates three item statuses that are deliberate
    no-ops rather than a release** — `skipped_not_owned`,
    `skipped_no_contact`, and `duplicate_active` — never split across the
    fixed audit columns.
    `recipient_ref`/`destination` are an OPERATOR address and the deterministic
    S3 export key respectively (`resolveExportRecipient`/`exportObjectKey`,
    `campaign-process/index.ts`) — both helpers are shared between the send
    path and the audit write so the two cannot drift, and both are left unset
    for voice/email (an operator address must never be attributed to a channel
    that never released one).
- **`error_code` is dual-purpose — not a stable enumeration.** Depending on
  which code path wrote the row it holds either a genuine error code (the
  watchdog's `stalled`, below) or a raw exception class name
  (`err.constructor.name`, `campaign-process/index.ts`'s worker-completion
  write) — usually the literal string `Error`, since most thrown errors in
  this codebase are plain `Error`s rather than a named subclass. Query this
  column expecting free text, not a fixed set of values.
- **The stalled-job watchdog also writes a `completed` row** (#617
  follow-up): `jobs/cron-watchdog.ts`'s stall sweep force-fails a
  `processing` job whose heartbeat went stale, which is a terminal
  transition per §6 of the design doc — the worker may have died mid-run
  after already releasing data to some participants, which is exactly the
  case with the least room for a missing completion record. That row has
  `outcome: 'failed'`, `error_code: 'stalled'`, and the counts above, plus
  (export channel only) `destination` and `recipient_ref` — the sweep's
  `.returning()` also selects `requested_by` (alongside `channel`/
  `signalstack_org_id`), so it recomputes `recipient_ref` with the exact same
  `resolveExportRecipient` helper a normal export completion uses, against
  the worker's own export-recipient config. Still an operator address, never
  a participant's.

Find gaps (audit rows that should exist and do not):

```sql
SELECT j.id, j.channel, j.status, j.created_at
FROM campaign_job j
LEFT JOIN campaign_pii_audit a
  ON a.correlation_id = j.id AND a.event = 'requested'
WHERE a.id IS NULL;
```

The mirror check (every `completed` has a `requested`) must exclude
`channel = 'dump'` if querying `campaign_pii_audit` directly: that channel's
rows predate its removal and never had a `requested` row.

The reverse gap — a job that reached a terminal status but never got its
`completed` row — is exactly the anomaly the watchdog fix above closes;
`campaign_job` never had `channel = 'dump'` rows, so no exclusion is needed
here:

```sql
SELECT j.id, j.channel, j.status, j.created_at
FROM campaign_job j
LEFT JOIN campaign_pii_audit a
  ON a.correlation_id = j.id AND a.event = 'completed'
WHERE j.status IN ('completed', 'partial', 'failed')
  AND a.id IS NULL;
```

## Tests

Mixed convention within this app: most route/service files have a sibling `*.test.ts` (e.g. `aggregator-approvals.test.ts`), but several service subpackages use a `__tests__/` folder instead (`services/idp-admin/__tests__/`, `services/user-store/__tests__/`). Either is fine here; match whichever convention the file you're touching already uses. One `.integration.test.ts` exists (`services/idp-admin/keycloak.integration.test.ts`), excluded from `pnpm -w test` per the repo-wide rule.
