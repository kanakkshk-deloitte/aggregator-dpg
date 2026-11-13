# User & Org management refactor: target model and phase map

**Date:** 2026-10-05 (reworked after the decisions of the same day)
**Status:** Plan. Every cross-phase decision is answered (§1). The per-phase designs are `users-phase-2.md`, `organisation-phase-3.md` and `cleanup-phase-4.md`; the path for existing instances is `existing-instance-migration.md`.

**Direction (2026-10-05):**

1. `aggregators` becomes **`users`**, with the complete details of the user.
2. `aggregator_orgs` becomes **`organisations`**, with the complete details of the org.
3. `org_type` is `aggregator` or `network_facilitator`, with **exactly one** `network_facilitator`.
4. Every organisation has an **`org_owner`** (a `users.id`).
5. Organisation details move from the coordinator row to `organisations`: **`url`, `locations`, company, GST number**. Responses render them **from the user's linked org**.
6. Duplicate data is removed (consent, …).
7. Existing instances must migrate easily.

---

## 1. Decisions (all answered 2026-10-05)

| #           | Decision                                                                               | Answer                                                                                                                                                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1          | Ids                                                                                    | `aggregators` is **renamed** `users`; **ids are kept**. The Keycloak `aggregator_id` attribute and claim keep naming the coordinator.                                                                                                           |
| G2          | Phase 2 as first built (`app_user`)                                                    | **Not shipped.** Accounts are rows of `users`; org owners become `users` rows with `user_type = 'admin'`.                                                                                                                                       |
| Model       | What a coordinator is                                                                  | A **user** (`user_type = 'coordinator'`) linked to **one aggregator org** (`users.org_id`). No per-coordinator child orgs.                                                                                                                      |
| Signals     | Ids in Signals                                                                         | **Unchanged.** Each coordinator keeps its own Signals org, keyed by `external_id` = its user id, as today. The tenant's Signals `slug`, `name` and `signalstack_org_id` stay on the coordinator's `users` row (public link URLs use that slug). |
| Org details | `url`, `locations`, company, GST number                                                | **Move to `organisations`**; rendered from the linked org (§4).                                                                                                                                                                                 |
| Tenant data | `bulk_uploads`, `registration_links`, `link_submissions`, `onboarding`, `campaign_job` | **Both ids:** `user_id` (the old `aggregator_id`; values unchanged) and `org_id` (new, from `users.org_id` at backfill / creation time).                                                                                                        |
| Hierarchy   | `ORG_HIERARCHY_ENABLED`                                                                | **Removed; always on.** Every coordinator belongs to an aggregator org.                                                                                                                                                                         |
| Flat data   | Coordinators with no parent org                                                        | Linked to a fixed **"Default"** aggregator org (`slug = 'default'`, `name = 'Default'`), one per instance.                                                                                                                                      |
| G4          | Owner of the NF root                                                                   | A network-admin **user seeded from config** (`organisation.root.owner_email`, else the first `ADMIN_EMAILS` entry). It also owns the Default org.                                                                                               |
| G13         | Org-name uniqueness                                                                    | Today's rule: unique among **live** aggregator orgs (case-insensitive).                                                                                                                                                                         |
| G14         | `consent.given_at`                                                                     | It comes from the ledger; old rows shift by under a second. **Accepted.**                                                                                                                                                                       |
| G15         | Windows                                                                                | **One release train, one window per instance** (every instance is at migration 0022).                                                                                                                                                           |
| G18         | Archive table                                                                          | **None.** The DB snapshot is the fallback. Values that would otherwise be lost are kept on the row (§4.2).                                                                                                                                      |
| G20         | Shared envs on `feature`                                                               | **None.**                                                                                                                                                                                                                                       |
| P3-4        | Org dropdown order                                                                     | `ORDER BY lower(name)`.                                                                                                                                                                                                                         |
| P4-3        | Consent of pruned registrations                                                        | **Kept, unlinked.**                                                                                                                                                                                                                             |
| known_as    | Labels                                                                                 | Mechanism ships; values unset.                                                                                                                                                                                                                  |
| C1 fix      | Consent PATCH hole                                                                     | Separate PR, before the train.                                                                                                                                                                                                                  |

## 2. Target model (end of the train)

```text
contact ◀─(contact_id)── users ──(org_id)──▶ organisations ──(parent_id)──▶ organisations (NF root)
                          ▲   ▲                    │ org_owner ─▶ users
                          │   └── tenant tables: user_id + org_id
                          └────── consent_record: user_id | org_id
```

```sql
CREATE TYPE user_type AS ENUM ('admin', 'coordinator');
-- Login identities: provider-neutral, on the ACCOUNT (review A15, amended 2026-10-06)
CREATE TABLE user_identities (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider   text NOT NULL,                      -- 'keycloak' today; any IAM later
  subject    text NOT NULL,                      -- the provider's user id (Keycloak `sub`)
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider),               -- one login per provider per account
  UNIQUE (provider, subject)                     -- one account per external login
);
CREATE TYPE org_type  AS ENUM ('network_facilitator', 'aggregator');
ALTER TYPE aggregator_status RENAME TO registration_status;   -- one status vocabulary for users and orgs (M6)

users (                                          -- was aggregators (renamed, ids kept)
  -- identity: every account
  id                 uuid PRIMARY KEY,
  user_type          user_type NOT NULL,
  contact_id         text NOT NULL REFERENCES contact(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  alternate_phone    text,                       -- was contact_extra.alternatePhone
  created_by, updated_by text, created_at, updated_at timestamptz,
  -- coordinator only (NULL for admins): membership, registration, Signals tenant
  org_id             uuid REFERENCES organisations(id) ON DELETE RESTRICT,  -- the coordinator's org (M1)
  status             registration_status,        -- the coordinator's registration (M2)
  rejected_at        timestamptz,
  invite_id          uuid REFERENCES registration_invites(jti) ON DELETE SET NULL,  -- was invite_email (M3)
  signalstack_org_slug        text,                       -- was org_slug; immutable; public-link URL segment
  signalstack_org_name        text,                       -- was name; NULL = the org's name (M4)
  signalstack_org_id text,
  serves            text[],                     -- was type (design doc: Coordinator.agg_for; renamed `serves`, D4-1)
  profile            jsonb,                      -- instance-specific registration fields (0018 rule: no field that has a column)
  legacy_org_details jsonb,                     -- coordinator values its org did not adopt (§4.2; review A20)
  profile_ref        text,
  CHECK (CASE user_type
           WHEN 'coordinator' THEN org_id IS NOT NULL AND status IS NOT NULL AND signalstack_org_slug IS NOT NULL
                                   AND serves IS NOT NULL AND profile IS NOT NULL
           ELSE org_id IS NULL AND status IS NULL AND rejected_at IS NULL AND invite_id IS NULL
                AND signalstack_org_slug IS NULL AND signalstack_org_name IS NULL AND signalstack_org_id IS NULL
                AND legacy_org_details IS NULL
                AND serves IS NULL AND profile IS NULL AND profile_ref IS NULL
         END)
)
UNIQUE (contact_id, user_type)                   -- one account per person per role
UNIQUE (signalstack_org_slug)                             -- was aggregators_org_slug_unique
INDEX  (org_id)

organisations (                                  -- was aggregator_orgs (renamed, ids kept)
  id, slug, name (was display_name), status (registration_status), kc_group_id, profile, profile_ref, rejected_at,
  created_at, updated_at,
  org_type     org_type NOT NULL,                -- immutable
  parent_id    uuid REFERENCES organisations(id) ON DELETE RESTRICT,   -- NULL only for the NF
  org_owner    uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,  -- an admin user; an admin's orgs = WHERE org_owner = it
  url          text,                             -- moved from the coordinator row (§4)
  locations    jsonb NOT NULL DEFAULT '[]',      -- moved; also absorbs the org form's address + state
  legal_name   text,                             -- was contact_extra.company
  gst_number   text,                             -- was contact_extra.gstNumber
  known_as     text,
  created_by, updated_by text,
  CHECK ((org_type = 'network_facilitator') = (parent_id IS NULL))
)
UNIQUE (org_type) WHERE org_type = 'network_facilitator'
UNIQUE (slug)
UNIQUE (lower(name)) WHERE org_type = 'aggregator' AND status IN ('pending','active')

consent_record (                                 -- was aggregator_consent_record
  …unchanged columns…, subject_type, subject_id,  -- permanent audit key ('user' | 'organisation')
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  org_id  uuid REFERENCES organisations(id) ON DELETE SET NULL,
  valid_till timestamptz
)

-- tenant tables: aggregator_id → user_id (FK users ON DELETE CASCADE, as today; values unchanged)
--                + org_id (FK organisations ON DELETE RESTRICT; the org at write time)
```

**Why the coordinator keeps `signalstack_org_slug` / `signalstack_org_name`.** They are the identity of the coordinator's **Signals organisation** (`external_id` = user id, `slug`, `name`), and `signalstack_org_slug` is the `[org]` segment of every public registration-link URL. Moving them would rename Signals orgs and break published links. The **organisation's** own `slug` and `name` are separate: today they are the parent org's.

**Future: one user in several orgs.** Today an account belongs to at most one org (`users.org_id` for coordinators; `org_owner` for admins). When a user may belong to several orgs, `users.org_id` becomes a membership table (`user_orgs (user_id, org_id, role, status)`), and the coordinator's per-org tenant columns move onto that membership row. The schema keeps this additive:

- identities hang off `users.id`, not off an org or a contact;
- tenant data already carries both `user_id` and `org_id`;
- nothing else keys on `users.org_id`.

**Identity provider independence.** The app talks to the IAM only through the `IdpAdminAdapter` port (`services/idp-admin/interface.ts`), and the database stores only `provider + subject`. The Keycloak attribute `aggregator_id` (= `users.id`) is the provider-side link; another provider needs an equivalent claim, or a lookup by `user_identities`.

**Naming rule (review A23; option C chosen 2026-10-07).**

- `org_id` always means `organisations.id`.
- **A coordinator's own Signals organisation**, the separate space in Signals that holds that coordinator's participants, uploads, links and campaigns (called the "Signals tenant" elsewhere in these docs), is always described by `signalstack_org_*` columns on the coordinator's `users` row:
  - `signalstack_org_id`: the id Signals returns;
  - `signalstack_org_slug`: was `org_slug`; the Signals slug, and the `[org]` segment of public registration-link URLs;
  - `signalstack_org_name`: was `name`; NULL means "use the linked org's name".
- `onboarding.org_slug` is renamed `signalstack_org_slug` too.
- These are **not** the coordinator's organisation (`organisations.slug` / `name`), and **not** the person (`contact.name`).
- `user_type` / `org_type` are the only type columns.
- API response fields (`org_slug`, `org_name`) are unchanged.

**One relation, one home (review M1–M5, A15, `plan-review-2026-10-06.md`):**

- A coordinator's org is `users.org_id`; an admin's orgs are `organisations.org_owner`. There is no FK cycle, so inserts need no deferred constraints.
- **Registration state** lives on the coordinator user and on the org, each for its own registration. An admin account has none; it can log in when its Keycloak user is enabled.
- **The tenant name** is stored only when it differs from the org's name. Signals and `org_name` read `coalesce(signalstack_org_name, org.name)`.
- **The invite** is referenced (`invite_id`), not copied.
- **Login identities are provider-neutral and belong to the account:** `user_identities (user_id, provider, subject)`. They are **not** on `contact` (a person's data) and have **no** Keycloak-specific column, so another IAM provider is a new `provider` value, and an account can hold more than one login.

## 3. Where every current column goes

### 3.1 `aggregators` → `users` (Phase 2 renames; later phases move columns)

| Column                                                                 | Goes to                                                                                                                                                                                        | Phase |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `id`, `contact_id`, `status`, `rejected_at`, audit columns             | stay (`users`); `status` uses the renamed enum `registration_status`                                                                                                                           | 2 / 4 |
| `org_slug`                                                             | `users.signalstack_org_slug` (immutable rule moves with it)                                                                                                                                    | 2     |
| `invite_email`                                                         | `users.invite_id`: the consumed invite with that email for that org. When none matches (a deleted invite), the email is kept in `users.profile.legacy_invite_email` and `invite_id` stays NULL | 4     |
| `name`                                                                 | `users.signalstack_org_name`, set to NULL where it equals the linked org's name (M4)                                                                                                           | 2 / 3 |
| `signalstack_org_id`, `profile`, `profile_ref`                         | stay                                                                                                                                                                                           | 2     |
| `parent_org_id`                                                        | `users.org_id` (NULL → the Default org)                                                                                                                                                        | 3     |
| `url`, `locations`, `contact_extra.company`, `contact_extra.gstNumber` | **`organisations.url` / `locations` / `legal_name` / `gst_number`** by the adoption rule (§4.1); values not adopted are kept in `users.legacy_org_details` (§4.2)                              | 3     |
| `type`                                                                 | `users.serves` (`ARRAY[type]`)                                                                                                                                                                 | 4     |
| `actor_type`                                                           | dropped (always `'aggregator'`; `type` holds the same value)                                                                                                                                   | 4     |
| `contact_extra.alternatePhone`                                         | `users.alternate_phone`; then `contact_extra` is dropped                                                                                                                                       | 4     |
| `consent`                                                              | dropped; the ledger is the record                                                                                                                                                              | 4     |
| (new)                                                                  | `user_type` on `users`; logins in `user_identities` (A15)                                                                                                                                      | 2     |

### 3.2 `aggregator_orgs` → `organisations`

| Column                                        | Goes to                                                                                                                                                                         | Phase |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `contact_id`, `owner_kc_sub`                  | the owner's `users` row (`user_type = 'admin'`): `users.contact_id`; the subject goes to `user_identities` (`provider = 'keycloak'`); the org gets `owner_user_id` → `users.id` | 2     |
| table name, `display_name`, `owner_user_id`   | `organisations`, `name`, `org_owner`                                                                                                                                            | 3     |
| `state`, `profile.address`, `profile.website` | `locations`, `url` (§4.1)                                                                                                                                                       | 3     |
| (new)                                         | `org_type`, `parent_id`, `legal_name`, `gst_number`, `known_as`                                                                                                                 | 3     |

### 3.3 Other tables

| Table                                  | Change                                                                                               | Phase |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----- |
| tenant tables (5)                      | `aggregator_id` → `user_id` (FK follows the rename); `org_id` added and backfilled                   | 2 / 3 |
| `registration_invites.parent_org_id`   | → `org_id`, FK follows the rename                                                                    | 3     |
| `aggregator_consent_record`            | → `consent_record`; typed `user_id` / `org_id`; `valid_till`                                         | 4     |
| `contact_gc()` and the delete triggers | rewritten to check `users` only (the function names tables in its body, so it would break on rename) | 2     |

## 4. Moving the org details, and rendering them

### 4.1 Adoption rule (per organisation, in the Phase 3 migration)

For each of `url`, `locations`, `legal_name`, `gst_number`:

1. **The org's own value** wins when it has one (parent orgs: `profile.website`, `profile.address` + `state`).
2. **Otherwise, adopt the coordinators' value** when every linked coordinator that has one agrees (exactly one distinct non-empty value).
3. **Otherwise leave it empty.** This is always the case for the Default org: it is a bucket of unrelated flat coordinators, so their values never become its value.

### 4.2 Nothing is lost: `legacy_org_details`

There is no archive (G18), so a coordinator value that was **not** adopted is kept on the coordinator's own row: `users.legacy_org_details = {url, locations, company, gstNumber}`. Only the fields that differ from the org's are kept. The pre-flight reports the counts per org (F13).

### 4.3 Rendering (profile GET, approval emails, anything that shows a coordinator)

| Field                                                      | Rendered from                                                                                                                                                                                                                   |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`, `locations`, `contact.company`, `contact.gstNumber` | **The linked org** (`users.org_id`). **When the org's field is empty**, fall back to the coordinator's `legacy_org_details`, so a flat coordinator in the Default org still sees what it registered until real org data exists. |
| `org_name`, `org_slug`                                     | `coalesce(users.signalstack_org_name, org.name)` / `users.signalstack_org_slug`: the Signals tenant identity, byte-identical for every existing row.                                                                            |
| `contact.name`, `email`, `phone`, `alternatePhone`         | `contact` + `users.alternate_phone`.                                                                                                                                                                                            |

**Visible effect:** a coordinator whose own value differed from an org value that exists now sees the **org's** value. That is the intended change (direction 5). The fallback keeps everyone else byte-identical.

### 4.4 Writes

- **Profile PATCH** of `url`, `locations` or company / GST by a coordinator would change data **shared by every coordinator of the org**, so it is **refused** with a new `409 ORG_DETAILS_READ_ONLY`. The web never sends a profile PATCH, so there is no UI change. The org's details are edited by its owner through the Phase 5 org APIs.
- **Coordinator registration** no longer collects these fields. They are removed from the coordinator `registration.v1.json` schemas (base and brands). If an old client still sends them, the API **accepts and ignores** them for one release (logged at `warn`), then rejects them.
- **Org registration** maps the form's `website`, `address` + `state` to `url` / `locations`, and gains optional company / GST fields per brand schema.

## 5. Phase map

All phases land on `feature` as separate PRs and ship in **one release train** (G15). Every existing instance goes from migration 0022 to the end in one window (`existing-instance-migration.md`).

| Phase | Name                | Content                                                                                                                                                                                                                                                | Migration  | Plan                                   |
| ----- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- | -------------------------------------- |
| 1     | `contact`           | One record per person.                                                                                                                                                                                                                                 | 0025, 0026 | shipped (#825)                         |
| fix   | consent PATCH       | Remove `consent` from the profile PATCH body. Own PR, before the train.                                                                                                                                                                                | none       | `docs/consent-duplication-analysis.md` |
| 2     | **`users`**         | Rename `aggregators` → `users`; `user_type`; identity-only admin rows for org owners; `user_identities`; tenant `aggregator_id` → `user_id`; `contact_gc` on `users`; the org owner via `owner_user_id`. Replaces the `app_user` design.               | 0027       | `users-phase-2.md`                     |
| 3     | **`organisations`** | Rename `aggregator_orgs` → `organisations`; `org_type`, NF root (+ NF admin), Default org, `parent_id`, `org_owner`; `users.org_id`; the hierarchy flag removed; org details moved (§4); tenant `org_id`.                                              | 0028       | `organisation-phase-3.md`              |
| 4     | **cleanup**         | Consent → ledger only (`consent_record`, typed FKs, `valid_till`); `type` → `serves`; drop `actor_type`; `alternate_phone`; drop `contact_extra`; `invite_email` → `invite_id`; enum `registration_status`; the remaining `aggregator_*` object names. |            | 0029                                   | `cleanup-phase-4.md` |
| 5     | APIs                | `/v1/org/*`, `/v1/user/*`, admin and NF-admin login, owner console (org detail edits live here).                                                                                                                                                       | —          | `apis-phase-5.md`                      |
| 6     | cross-cutting       | PII encryption, agreements, RBAC.                                                                                                                                                                                                                      | —          | `cross-cutting-phase-6.md`             |

**Why this order.** `organisations.org_owner` and the NF admin need `users` rows, so users come first. Org details can move only once `users.org_id` exists. Cleanup comes last because it depends on both.

**Branch consequence.** The `app_user` commits (old Phase 2, 0027/0028) are removed from `refactor/user-org-management`; `backup/user-org-pre-rebase` keeps them. Reusable parts are ported into the new Phase 2: login-identity recording (`recordKcSubject` → `recordIdentity`, writing `user_identities`), the verify-script pattern, the owner-subject reads and writes, and the tests. **The migration numbers 0027–0029 are reused**, which is safe because no shared environment ever applied the old 0027/0028 (G20). Local dev databases that did must be recreated, or have those two rows deleted from `drizzle.__drizzle_migrations` along with the `app_user` objects (`existing-instance-migration.md` §8).

## 6. API and contract changes (intended)

| Change                                                                               | Phase | Who notices                                                                                     |
| ------------------------------------------------------------------------------------ | ----- | ----------------------------------------------------------------------------------------------- |
| Profile PATCH no longer accepts `consent`                                            | fix   | nobody (the web never PATCHes)                                                                  |
| Profile GET renders `url` / `locations` / company / GST from the org (fallback §4.3) | 3     | coordinators whose value differs from an existing org value                                     |
| Profile PATCH of org details → `409 ORG_DETAILS_READ_ONLY`                           | 3     | nobody (the web never PATCHes)                                                                  |
| Coordinator registration ignores org-detail fields (one release), then rejects them  | 3     | old clients only                                                                                |
| The hierarchy is always on: coordinator registration requires `org_id` or an invite  | 3     | **flat instances**: the registration form shows the org selector; the Default org is selectable |
| `GET /v1/orgs` sorted by name; includes the Default org                              | 3     | registration dropdown                                                                           |
| `consent.given_at` sub-second shift for old rows (G14)                               | 4     | nobody (not displayed)                                                                          |

**Unchanged:** tokens and Keycloak (`aggregator_id` = user id, as today); Signals payloads (`external_id`, `name`, `slug`, `domains`); every other response.

## 7. Review of 2026-10-06

`plan-review-2026-10-06.md` records:

- the corner cases (K1–K12);
- the simplifications applied here (M1–M7);
- the reads and writes per operation;
- the **revert** design (V1–V3): `user-org-migrate.sh revert` takes an instance back to the 0022 schema **keeping post-go-live writes**, and a CI round-trip test proves it (`existing-instance-migration.md` §13).

## 8. Remaining review items (small; recommendation in bold)

| #   | Question                                                                               | Recommendation                                                                                                    |
| --- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| R1  | Show the Default org in the registration dropdown, or only use it for migrated data?   | **Show it**: a fresh or formerly-flat instance otherwise has no org to pick until one is registered and approved. |
| R2  | How long old clients may send org details on coordinator registration before rejection | **One release.**                                                                                                  |
| R3  | Should the org's details also appear in the org approval email?                        | **Yes**, once they are columns (Phase 3), at no extra cost.                                                       |
