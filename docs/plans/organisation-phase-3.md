# Implementation plan: User & Org management refactor, Phase 3 (`organisations`)

**Date:** 2026-10-05 (reworked after the decisions of the same day)
**Branch:** `refactor/user-org-management`
**Status:** Plan. Read `user-org-target-model.md` first: the decisions (§1), the schema (§2), and the org-detail move and rendering rules (§4).
**Depends on:** Phase 2 (`users`, 0027).
**Ships in:** the release train (G15).

> Delete this file in the commit that completes the train.

---

## 1. Goal

- `aggregator_orgs` is **renamed `organisations`** (ids kept), with `org_type`, `parent_id` and `org_owner`.
- **Exactly one `network_facilitator`** org (the root), owned by a **network-admin user** seeded from config (G4).
- A fixed **"Default"** aggregator org under the root, owned by the network admin.
- **Every coordinator has an org** (`users.org_id`): its parent org, or the Default org when it had none. **Admins have no `org_id`**: their orgs are `organisations.org_owner` (review M1, no FK cycle).
- **The hierarchy is always on.** `ORG_HIERARCHY_ENABLED` is removed from the API, the web and the config.
- **`url`, `locations`, company and GST number move to the org** (the §4 rules of the target model), and responses render them from the linked org.
- Tenant tables gain `org_id`.

**Unchanged:** tokens, Keycloak, Signals. Responses are byte-identical except the intended changes in target model §6.

## 2. Schema after Phase 3

```sql
CREATE TYPE org_type AS ENUM ('network_facilitator', 'aggregator');

ALTER TABLE aggregator_orgs RENAME TO organisations;
ALTER TABLE organisations RENAME COLUMN display_name  TO name;
ALTER TABLE organisations RENAME COLUMN owner_user_id TO org_owner;
ALTER TABLE organisations
  ADD COLUMN org_type   org_type,                    -- backfilled, then NOT NULL; immutable (trigger)
  ADD COLUMN parent_id  uuid REFERENCES organisations(id) ON DELETE RESTRICT,
  ADD COLUMN url        text,
  ADD COLUMN locations  jsonb NOT NULL DEFAULT '[]'::jsonb,  -- CHECK jsonb_typeof = 'array'
  ADD COLUMN legal_name text,
  ADD COLUMN gst_number text,
  ADD COLUMN known_as   text,
  ADD COLUMN created_by text, ADD COLUMN updated_by text;
-- dropped: state (folded into locations)
CHECK ((org_type = 'network_facilitator') = (parent_id IS NULL))
UNIQUE (org_type) WHERE org_type = 'network_facilitator'                 -- organisations_single_nf
UNIQUE (slug)                                                            -- was unique among live rows only (F4)
UNIQUE (lower(name)) WHERE org_type = 'aggregator' AND status IN ('pending','active')   -- today's rule (G13)
INDEX  (parent_id, status), INDEX (org_owner)

ALTER TABLE users ADD COLUMN org_id uuid REFERENCES organisations(id) ON DELETE RESTRICT;  -- coordinators only (CHECK); admins NULL
ALTER TABLE users DROP COLUMN parent_org_id;
ALTER TABLE users DROP COLUMN url, DROP COLUMN locations;   -- after the move (§3 S8–S9)
-- contact_extra loses company / gstNumber here; alternatePhone moves in Phase 4.

registration_invites: parent_org_id → org_id (FK follows the rename)
tenant tables: ADD COLUMN org_id uuid REFERENCES organisations(id) ON DELETE RESTRICT  -- backfilled, NOT NULL
```

**Immutability:** `org_type` and `slug` never change (an `organisations_lock` trigger). `parent_id` stays editable for the Phase 5 `parent/update`, which must also check for cycles and depth.

**A tenant row's `org_id` is the org at the time it was written.** It is set from the coordinator's `users.org_id` at backfill and at insert. If a coordinator later moves org (Phase 5), its existing uploads and links stay with the old org. That is the point of keeping both ids.

## 3. Migration `0028_organisations.sql`

Same guards as 0027. It runs inside the train transaction on existing instances.

| Step | What                                                                                                                                                                                                                                                                                                                                                                       |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1   | `LOCK TABLE users, aggregator_orgs, registration_invites, contact` and the five tenant tables.                                                                                                                                                                                                                                                                             |
| S2   | **Blockers** (first run only, counts only): F8, a coordinator whose `parent_org_id` names a missing org (expected 0; the FK forbids it).                                                                                                                                                                                                                                   |
| S3   | Type; table and column renames; new columns.                                                                                                                                                                                                                                                                                                                               |
| S4   | **Network admin.** Read `nf.owner_email` from `migration_input` (`existing-instance-migration.md` §6). If a `contact` with that email already exists, reuse it; otherwise insert one (email, no phone). Link its `admin` `users` row. With no input at all (a fresh boot without config), use the `.invalid` placeholder, which `ensureRootOrganisation()` replaces later. |
| S5   | **NF root:** `org_type = 'network_facilitator'`, `parent_id = NULL`, `slug` / `name` from `migration_input` (`nf.slug`, `nf.name`), `status = 'active'`, `org_owner` = the network admin. Inserted only when no NF exists.                                                                                                                                                 |
| S6   | **Default org:** `slug = 'default'`, `name = 'Default'`, `org_type = 'aggregator'`, `parent_id` = the root, `status = 'active'`, `org_owner` = the network admin. Inserted only when absent. A pre-existing org with slug `default` or a live org named `Default` is renamed `-r<n>` first (F4).                                                                           |
| S7   | Existing orgs: `org_type = 'aggregator'`, `parent_id` = the root. Dead rows whose slug repeats a live one get `-r<n>` (F4).                                                                                                                                                                                                                                                |
| S8   | **Coordinators' org:** `org_id = coalesce(parent_org_id, <Default>)`; drop `parent_org_id`; extend the `user_type` CHECK (`org_id` required for coordinators, NULL for admins). **Dedupe the tenant name (M4):** `signalstack_org_name = NULL` where it equals the org's `name`; the CHECK then requires only `signalstack_org_slug`.                                      |
| S9   | **Org details** (target model §4.1, per org, per field): the org's own value (`profile->>'website'`; one Beckn location from `profile.address` + `state`) → else the single agreed coordinator value → else empty, and **never adopted for the Default org**. Move company / GST from `contact_extra` the same way.                                                        |
| S10  | **Keep what was not adopted:** for each coordinator, write the fields that differ from its org's value into `users.legacy_org_details`. Then drop `users.url`, `users.locations`, the moved `contact_extra` keys, `organisations.state` and the moved `profile` keys, all with `users_set_updated_at` disabled (the prune windows key off `updated_at`).                   |
| S10b | **Reserved identifiers (K4):** `default` and the NF slug are added to the reserved list used by `services/slug.ts`; any existing org already holding them was renamed in S6.                                                                                                                                                                                               |
| S11  | Tenant tables: add `org_id` = the owning user's `org_id`, then `NOT NULL` + FK. `registration_invites.parent_org_id` → `org_id`.                                                                                                                                                                                                                                           |
| S12  | Constraints, indexes, the `organisations_lock` and `organisations_set_updated_at` triggers. Swap `aggregator_orgs_slug_active_unique` for `UNIQUE (slug)`, and rename the name index to `organisations_name_live_unique`.                                                                                                                                                  |
| S13  | A WARNING with counts: orgs that adopted coordinator values, coordinators with `legacy_org_details`, users moved into the Default org.                                                                                                                                                                                                                                     |

## 4. Code changes

| Package / file                                                                         | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/db-schema/src/schema.ts`                                                     | `organisations` (renames and new columns), `orgTypeEnum`; `users.orgId` (with `parentOrgId`, `url`, `locations` removed); tenant `orgId`; `registrationInvites.orgId`.                                                                                                                                                                                                                                                                                              |
| `services/organisation-store/` (new: interface, postgres, memory, testing, seed)       | `findById`, `findBySlug`, `findRoot`, `findDefault`, `listActiveAggregators()` (sorted by `lower(name)`, P3-4), `listChildren`. `seed.ts` holds `ensureRootOrganisation()`, which reconciles the root's slug, name and owner and the Default org with config at boot; it is idempotent, takes an advisory lock and logs counts.                                                                                                                                     |
| `services/aggregator-org-store/`                                                       | Becomes a thin layer over `organisations` (`org_type = 'aggregator'`), or is merged into the organisation store. **Recommendation: merge** (P3-1).                                                                                                                                                                                                                                                                                                                  |
| `services/aggregator-store/` → `services/user-store/` (M6)                             | The `Aggregator` domain object keeps its shape. `org_name` = `coalesce(signalstack_org_name, org.name)`, and the Signals upsert sends the same value (M4). `parentOrgId` = `users.org_id`, except **`null` when it is the Default org**, so formerly-flat coordinators read as today. `url`, `locations` and `contact.company` / `gstNumber` are rendered from the org, falling back to `legacy_org_details` per field when the org's is empty (target model §4.3). |
| `routes/aggregator-profile.ts`                                                         | PATCH: `url`, `locations`, or company / GST in `contact` → `409 ORG_DETAILS_READ_ONLY` (a new code in `errors/codes.ts`). Everything else is unchanged.                                                                                                                                                                                                                                                                                                             |
| `routes/aggregator-registrations.ts`                                                   | **Always** requires `org_id` or an invite (the flag branch is removed); the target org must be an active `aggregator` org. `url` / `locations` / company / GST in the body are **accepted and ignored** for one release, with a `warn` log (R2), then rejected.                                                                                                                                                                                                     |
| `routes/aggregator-orgs.ts`, `routes/aggregator-org-approvals.ts`, `routes/invites.ts` | Always registered (no flag). Org create maps `website`, `address` + `state`, company and GST to columns. `GET /v1/orgs` lists active aggregator orgs, including Default, sorted by name.                                                                                                                                                                                                                                                                            |
| `routes/aggregator-maintenance.ts` (prune)                                             | Stale coordinator: DELETE `users` (tenant rows cascade, consent links set to NULL, contact GC). Stale org: DELETE `organisations` (invites cascade), then delete its owner's admin row **only if** it owns no other org and is not the NF / Default owner, then its Keycloak user and group, as today (review K6).                                                                                                                                                  |
| `config.ts` (API) and web config                                                       | **Remove `ORG_HIERARCHY_ENABLED`.** Fail fast if it is still set to `false`, with a clear message, so no instance silently assumes flat mode.                                                                                                                                                                                                                                                                                                                       |
| `services/registration-notify.ts`, approval emails                                     | Owner routing reads `org_owner`. A Default-org coordinator's approval goes to `ADMIN_EMAILS`, as flat mode did. Org details in emails come from the org (R3).                                                                                                                                                                                                                                                                                                       |
| Signals upsert (`aggregator-approvals.ts`, `access-token.ts`)                          | **No change**: `external_id` = user id, with `signalstack_org_name` / `signalstack_org_slug` / domains.                                                                                                                                                                                                                                                                                                                                                             |
| `apps/worker`                                                                          | Tenant inserts set `org_id` from the user (the bulk and campaign paths that create rows). Reads are unchanged.                                                                                                                                                                                                                                                                                                                                                      |
| `packages/network-config`                                                              | The `organisation:` block: `root.{slug, name, owner_email}`, `known_as` (empty), optional `limits`. `default_aggregators` from the old plan is **dropped**: the Default org covers it.                                                                                                                                                                                                                                                                              |
| `scripts/sql/organisation-{preflight,verify}.sql`                                      | New; run by `user-org-migrate.sh`.                                                                                                                                                                                                                                                                                                                                                                                                                                  |

### 4.1 Web (`apps/web`)

- **Registration:** remove every `ORG_HIERARCHY_ENABLED` branch. The coordinator form always shows the org selector (sorted, Default included) and the invite path. The org tab is always on.
- **The schemas** (`config/**/schemas/aggregator/registration.v1.json`, every brand): mark `url`, `locations` and the company / GST contact fields as **org details**, with a schema annotation such as `"x-org-detail": true`.
  - In **registration mode** they are hidden: the coordinator does not enter org data.
  - In **profile mode** (the read-only `/profile` page, which renders the same schema) they are shown, filled from the profile GET, which already renders them from the org.

  This keeps the single-schema design (`lib/aggregator-schema.server.ts`) and needs one rule in the dual-mode renderer.

- **Org registration schemas:** add optional company / GST fields where a brand wants them.

## 5. Verification

**Verify (`organisation-verify.sql`); every check must be 0:**

| #   | Check                                                                                                            |
| --- | ---------------------------------------------------------------------------------------------------------------- |
| V1  | the number of `network_facilitator` orgs is not exactly 1, or an aggregator org has no parent                    |
| V2  | coordinators with a NULL `org_id`, or whose `org_id` is not an `aggregator` org; admins with a non-NULL `org_id` |
| V3  | orgs with a NULL or dangling `org_owner`, or an owner who is not an `admin`                                      |
| V4  | tenant rows whose `org_id` differs from their user's `org_id` at backfill (a backfill guard only)                |
| V5  | no Default org                                                                                                   |

**Informational:**

- V6: the root owner is still the placeholder;
- V7: counts of `legacy_org_details` by field;
- V8: orgs with empty details.

**Tests:**

- **Unit:**
  - the adoption rule (own value, agreed value, conflicting values, the Default org never adopting);
  - rendering with and without the fallback;
  - the PATCH 409;
  - registration ignoring org fields;
  - the flag-removal boot check;
  - response snapshots: unchanged for every case except the intended §6 changes, which are asserted explicitly.
- **Integration:** the train from 0022 with fixtures (flat; hierarchy; coordinators of one org with agreeing and with conflicting `url` / `locations`; an org with its own website and address; an existing org named "Default"); a re-run is a no-op; `org_type` / `slug` updates raise; a second NF fails.
- **Browser (`aggregator-e2e`):**
  - a formerly-flat instance: a coordinator's profile still shows its registered url and locations (the fallback), and registration now shows the selector with Default;
  - a hierarchy instance: the profile shows the org's url and locations; org registration with website and address; approvals; login; dashboard; links; bulk upload; campaigns.

## 6. Risks

| Risk                                                                  | Mitigation                                                                                                                                                                                          |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A coordinator now sees its org's url / locations instead of its own   | Intended (direction 5). Its own value is kept in `legacy_org_details`, and the change is listed in target model §6. The pre-flight counts affected coordinators per org (F13), so they can be told. |
| A formerly-flat instance's users are surprised by the org selector    | The Default org is preselected when it is the only active org.                                                                                                                                      |
| An owner email in config matches an existing contact that has a phone | S4 reuses the existing contact (looked up by email), so no duplicate person is created.                                                                                                             |
| A Beckn location cannot be built from a brand's `address` shape       | It stays in the org's `profile` and is counted (F6).                                                                                                                                                |
| Removing the flag hides a misconfiguration                            | Boot fails fast if `ORG_HIERARCHY_ENABLED=false` is still set.                                                                                                                                      |

## 7. Phase-local decisions

| #    | Question                                                    | Recommendation                                                         |
| ---- | ----------------------------------------------------------- | ---------------------------------------------------------------------- |
| P3-1 | Merge `AggregatorOrgStore` into the new `OrganisationStore` | **Merge**: one table, one store.                                       |
| P3-2 | Preselect the Default org in the registration dropdown      | **Only when it is the only active org.**                               |
| P3-3 | Keep the `limits` config (max children / depth)             | **Keep it as optional and off**; it costs one locked count per create. |

## 8. Review changes (2026-10-06): these override the text above

| #   | Change                                                                                                                                                                                                                                                                                                                                                                |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A3  | **Removing the flag:** delete `ORG_HIERARCHY_ENABLED` from `docker-compose.yml` (both services), `local-setup/docker-compose.yml`, `infra/env.template`, the e2e skill and the docs. For one release the API and web **ignore** the variable with a `warn` instead of failing (replaces "fail fast" in §4 / §6).                                                      |
| A6  | **Keycloak prerequisite for formerly-flat instances:** the `org_owner` realm role and the `aggregator-api` `manage-realm` grant (`infra/keycloak/init/apply-user-profile.sh` §1b; the deployment realm is in bluedots-automation). Pre-flight F19 checks them through the admin API; the runbook lists the step.                                                      |
| A11 | Slugs: S6/S7 suffix **every** duplicate group except the newest live row, and include the NF slug. Org create (`aggregator-orgs.ts:400`) gets a suffix retry like `createAggregatorWithSlug`.                                                                                                                                                                         |
| A12 | `findByOwnerEmail` excludes the NF and Default orgs and orders live-first, then newest. Invite, grant and org-selector paths require `org_type = 'aggregator'` (the NF root is never selectable; Default is).                                                                                                                                                         |
| A13 | `resolveOwnerRouting()` (`aggregator-registrations.ts:803`) routes Default-org coordinators to `ADMIN_EMAILS` on **both** the fresh and the reclaim paths, keyed on the org's id. This replaces the `registration-notify.ts` row in §4.                                                                                                                               |
| A14 | **Every tenant insert sets `org_id`:** `bulk-uploads-store/postgres.ts`, `registration-links-store/postgres.ts` (from the coordinator), `public-registration-links.ts:608` (`link_submissions`, from its link), `campaign-job-store/postgres.ts` (from the coordinator; API-side, not worker), and worker `link-metrics-rollup.ts:100` (`onboarding`, from its link). |
| A16 | `organisations_lock` exempts the NF row's `slug` (reconciled from config); every aggregator org's slug stays immutable.                                                                                                                                                                                                                                               |
| A20 | `legacy_org_details` is its own nullable `jsonb` column on `users` (not a `profile` key).                                                                                                                                                                                                                                                                             |
| A21 | Remove `x-updatable` from `url` / `locations` (and the company / GST fields) wherever `x-org-detail` is added, in every brand schema.                                                                                                                                                                                                                                 |
| A23 | `onboarding.org_slug` → `signalstack_org_slug` (worker `bulk-finalise.ts:54`, `link-metrics-rollup.ts:54` read `aggregators.orgSlug` → `users.signalstackOrgSlug`).                                                                                                                                                                                                   |
| A9  | S8–S11 run with the `*_set_updated_at` triggers disabled; covered by the shared `updated_at`-unchanged verify check.                                                                                                                                                                                                                                                  |
| A25 | 0028 reads `migration_input` and **drops** it at the end of the step.                                                                                                                                                                                                                                                                                                 |
