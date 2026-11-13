# Existing instances: migrating their data to the new user & org model

**Date:** 2026-10-05 (reworked after the decisions of the same day)
**Status:** Plan; **superseded for the operator tool and the execution** by `user-org-migrate-tool-simplification.md` and `docs/user-org-migration-runbook.md` (one window for Phases 1–5, one transaction, snapshot-only rollback — so §3, §6, §9, §13 and §14's tool items no longer apply; §4's catalogue lives on in `scripts/sql/train-check.sql`). Companion to `user-org-target-model.md`. The phase designs are `users-phase-2.md`, `organisation-phase-3.md` and `cleanup-phase-4.md`.

---

## 1. Where existing instances actually are

| Ref                                                                          | Last migration             |
| ---------------------------------------------------------------------------- | -------------------------- |
| `origin/main` (2026-10-01)                                                   | `0022_campaign_pii_audit`  |
| `origin/develop`                                                             | `0022_campaign_pii_audit`  |
| release tags `202609-s1-rc3`, `202609-s1-rc3-alimco`, `v1.0.0-mobile-testv2` | `0022_campaign_pii_audit`  |
| `origin/feature`                                                             | `0026_contact_drop_legacy` |

**Every deployed instance is at 0022**, and no shared environment runs `feature` (G20). The train adds the following:

| Migration            | From                           | What                                         |
| -------------------- | ------------------------------ | -------------------------------------------- |
| 0023, 0024           | already on `feature`           | drop `aggregator_profile` and `participants` |
| 0025, 0026           | already on `feature` (Phase 1) | `contact`                                    |
| 0027 `users`         | Phase 2                        |                                              |
| 0028 `organisations` | Phase 3                        |                                              |
| 0029 `cleanup`       | Phase 4                        |                                              |

So every instance jumps **0022 → 0029 in one window** and never runs an in-between release. That is why the plan has no compatibility code, no sync triggers and no multi-release contract steps.

## 2. Principles

| #   | Principle                                                                 | In practice                                                                                                                                         |
| --- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | **One window per instance**                                               | The whole train runs in one stop-the-world window (G15).                                                                                            |
| E2  | **One operator tool**                                                     | `scripts/user-org-migrate.sh` covers every phase.                                                                                                   |
| E3  | **Rehearse on a clone, where the data lives**                             | `dry-run` copies the database **on the same server**, migrates the copy and verifies it. No PII leaves the environment.                             |
| E4  | **Never lose data silently, without an archive table** (G18)              | Every value the train removes from a row either moves to its new home or is **kept on a surviving row** (§5). The DB snapshot is the full fallback. |
| E5  | **Resolve what is deterministic; refuse only what is ambiguous**          | Every refusal comes with a documented fix (§4).                                                                                                     |
| E6  | **Nothing outside the database changes**                                  | No Keycloak or token change (`aggregator_id` = user id, as today), and no Signals change (`external_id`, `slug`, `name` and domains are unchanged). |
| E7  | **Zero required config**                                                  | New config falls back to values the instance already has (§6). The Default org needs no config.                                                     |
| E8  | **Migrations run as a job, not at API boot, on existing instances** (G16) | A failed check means "not applied", never a crash-looping deployment. Boot-time migration stays for fresh instances.                                |
| E9  | **One transaction for the whole train** (G19)                             | A failure anywhere leaves the database exactly at 0022.                                                                                             |

## 3. The operator tool: `scripts/user-org-migrate.sh`

It runs from the **release tag** being deployed (it refuses otherwise, unless `--allow-untagged` is passed for rehearsals). It uses the same connection options as `contact-migrate.sh` (`DATABASE_URL`, `PG_CONTAINER` or `PSQL_CMD`), and the same image can run it as a Kubernetes Job.

| Command      | Live-safe        | What it does                                                                                                                                                                                                                                                                                                                                       | Exit code                              |
| ------------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `inspect`    | yes              | Applied level and pending files; **detects foreign migrations** (a `drizzle.__drizzle_migrations` hash that does not match the tag's file, e.g. a dev DB that ran the abandoned `app_user` 0027/0028); the instance shape (flat or hierarchy, from data); row counts; the config values that will be used (§6); DB size and an estimated duration. | 1 on foreign migrations                |
| `preflight`  | yes              | Every §4 check against the live database at its current schema (0022).                                                                                                                                                                                                                                                                             | 1 if any **blocker**                   |
| `dry-run`    | yes              | `pg_dump \| psql` into `<db>_umig_<timestamp>` on the same server, then the config seed, every pending migration and `verify`, with timings, then a **revert round trip** on the copy (§13.3). The scratch DB is dropped unless `--keep`.                                                                                                          | 1 if a migration or a gate fails       |
| `fix <name>` | yes              | Runs a documented fix (`scripts/sql/fixes/*.sql`) in a transaction, printing counts. `--dry` rolls it back.                                                                                                                                                                                                                                        | 0 / 1                                  |
| `apply`      | **pods at zero** | Requires `--snapshot-taken <id>` and a passing `dry-run` at the current level. Writes the config seed, then runs the pending migrations through `migrateWithLock` (the API's own code) in one transaction.                                                                                                                                         | 1 on failure; nothing applied          |
| `verify`     | yes              | Every phase's verify SQL; counts only.                                                                                                                                                                                                                                                                                                             | 1 if a gate fails                      |
| `enrich`     | yes, after start | The online follow-ups (§7).                                                                                                                                                                                                                                                                                                                        | 0, with a report                       |
| `report`     | yes              | A counts-only summary for the change record (before and after counts, users moved to Default, `legacy_org_details` counts, the remaining informational findings).                                                                                                                                                                                  | 0                                      |
| `revert`     | **pods at zero** | Rebuilds the database in the 0022 shape from the current data and swaps it in (§13). Keeps post-go-live writes; the migrated database is kept as `<db>_train`.                                                                                                                                                                                     | 1 on failure; the live DB is untouched |

At our volumes the train takes seconds: 0025 measured about 0.17 ms per row. `dry-run` measures each instance.

## 4. Pre-flight catalogue (against the 0022 schema)

**auto:** resolved by the migration and reported. **info:** reported only. **blocker:** a human chooses, using the named fix.

| #   | Check                                                                                                                                                                                                                     | Category                                                        | Resolution                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | One email with several phones, or one phone with several emails (Phase 1)                                                                                                                                                 | **blocker**                                                     | The conflict report lists the rows. Correct the contact, or `fix retire-registration <id>`.                                                                                           |
| F2  | Non-canonical phones, blank emails (Phase 1)                                                                                                                                                                              | **auto** if `normalisePhone` gives one answer, else **blocker** | `fix normalise-phones`.                                                                                                                                                               |
| F3  | A person who is both a coordinator and an org owner                                                                                                                                                                       | info                                                            | Supported: one contact, two `users` rows (`admin` + `coordinator`).                                                                                                                   |
| F4  | Org slug or name clashes: a dead org repeating a live slug (the slug becomes globally unique); an existing org with slug `default` or live name `Default`                                                                 | **auto**                                                        | The dead or clashing row gets `-r<n>`. Coordinator `signalstack_org_slug`s (Signals slugs, public URLs) are **never** changed.                                                        |
| F5  | `actor_type` other than `'aggregator'`                                                                                                                                                                                    | **auto**                                                        | Lossless (`type` holds the same value); dropped in Phase 4.                                                                                                                           |
| F6  | An org `profile.address` / `state` that cannot become a Beckn location                                                                                                                                                    | info                                                            | Kept in the org's `profile`.                                                                                                                                                          |
| F7  | `type` / `aggregator_type` not in the network's current domains                                                                                                                                                           | info                                                            | Copied as-is into `serves`; the Signals upsert already falls back to all domains.                                                                                                     |
| F8  | A coordinator whose `parent_org_id` names a missing org                                                                                                                                                                   | **blocker** (expected 0)                                        | Investigate: the FK must have been dropped by hand.                                                                                                                                   |
| F9  | Stale pending registrations                                                                                                                                                                                               | info                                                            | Optionally prune before the window.                                                                                                                                                   |
| F10 | A coordinator with a `consent` value but no ledger row                                                                                                                                                                    | **auto**                                                        | Phase 4 writes a ledger row from it (`source = 'registration-backfill'`).                                                                                                             |
| F11 | An owner of several orgs (rejected and new)                                                                                                                                                                               | info                                                            | One `admin` row owns all of them; its `org_id` = the newest live org.                                                                                                                 |
| F12 | Size and estimated duration                                                                                                                                                                                               | info                                                            | `inspect`.                                                                                                                                                                            |
| F13 | **Org details that will not be adopted**: per org, coordinators whose `url` / `locations` / company / GST differ from the org's value, or disagree with each other; every flat coordinator (the Default org never adopts) | info                                                            | Kept per coordinator in `users.legacy_org_details` and shown as a fallback while the org's value is empty. The list is the "who will see a different value" notice (target model §6). |
| F14 | Coordinators with no parent org                                                                                                                                                                                           | info                                                            | Linked to the Default org; their API response still says `parent_org_id: null`.                                                                                                       |
| F15 | An owner of several orgs whose `owner_kc_sub` values disagree (two Keycloak users for one person)                                                                                                                         | **blocker** (expected 0)                                        | `fix choose-owner-subject <contact>`: pick the live org's subject.                                                                                                                    |
| F16 | Database objects outside the migrations that name `aggregators` / `aggregator_orgs` (views, functions, triggers; via `pg_depend` and a scan of `pg_proc`)                                                                 | **blocker** if any is unknown                                   | Drop or adapt them before the window. Known objects (`contact_gc`, the delete triggers) are handled by 0027.                                                                          |
| F17 | Foreign migration hashes (a DB that ran the abandoned `app_user` 0027/0028)                                                                                                                                               | **blocker**                                                     | Dev databases only (G20): recreate, or `fix drop-app-user` (removes those journal rows and the `app_user` objects).                                                                   |

## 5. Where removed values go (no archive)

| Removed from          | Value                                         | Kept where                                                                        |
| --------------------- | --------------------------------------------- | --------------------------------------------------------------------------------- |
| coordinator row       | `url`, `locations`, company, GST              | the org (when adopted) **and/or** `users.legacy_org_details` (when not)           |
| coordinator row       | `parent_org_id`                               | `users.org_id` (NULL → Default; the API still reports `null`)                     |
| coordinator row       | `consent`                                     | `consent_record` (`valid_till` included; a missing ledger row is backfilled, F10) |
| coordinator row       | `type`, `actor_type`                          | `serves` (`actor_type` is redundant)                                              |
| coordinator row       | `contact_extra.alternatePhone`                | `users.alternate_phone`                                                           |
| org row               | `contact_id`, `owner_kc_sub`                  | the owner's `admin` `users` row                                                   |
| org row               | `state`, `profile.website`, `profile.address` | `locations`, `url` (an unmappable shape stays in `profile`, F6)                   |
| ledger                | `subject_type` names                          | renamed values; the `subject_id`s are kept                                        |
| coordinator row       | `name` equal to its org's name                | `coalesce(signalstack_org_name, org.name)` gives back the same value (M4)         |
| coordinator row       | `invite_email`                                | `invite_id`, or `profile.legacy_invite_email` when the invite is gone             |
| admin rows (backfill) | owner `status`                                | not copied: the org's own `status` is the record (M2)                             |

Nothing is dropped without one of these homes, so a wrong mapping can be corrected **online** from the surviving values. Only a full rollback needs the snapshot.

## 6. Config seed: right values on the first run

`apply` (and `runMigrations()` on a fresh instance) writes config-derived values into `migration_input (key, value)` before the migrations run. 0028 reads them with a placeholder fallback.

| Key              | Source, first present wins                                       |
| ---------------- | ---------------------------------------------------------------- |
| `nf.slug`        | `organisation.root.slug` → `brand.url_slug`                      |
| `nf.name`        | `organisation.root.name` → `legal_name` → `name`                 |
| `nf.owner_email` | `organisation.root.owner_email` → the first `ADMIN_EMAILS` entry |

The Default org is fixed (`default` / `Default`) and needs no input. `ensureRootOrganisation()` at boot keeps the root in step when config changes later.

## 7. `enrich`: online follow-ups after the window

Idempotent, resumable, rate-limited, counts-only logs; not required for correctness.

| Step              | What                                                                                                                          | Why                                                                                                             |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Keycloak subjects | For each coordinator with no `keycloak` identity: `idp.findByAttribute('aggregator_id', <user id>)` → a `user_identities` row | Coordinators would otherwise get it only at their next login; Phase 5 (login by subject) needs it for everyone. |
| Owner names       | `backfill-owner-contact-names.ts`                                                                                             | Org owners' names were only ever stored in Keycloak (Phase 1 D8).                                               |

## 8. What the single window removes from the design

| Item                                                                | Why it is not needed                                                                                                                   |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| N−1 compatibility code (fallback reads, dual writes, sync triggers) | No instance runs an intermediate release. Each phase PR still leaves `feature` coherent and tested.                                    |
| The `app_user` table and its triggers (old Phase 2)                 | Replaced by `users` (G2). The abandoned commits stay on `backup/user-org-pre-rebase`, and dev DBs that applied them are caught by F17. |
| Separate contract releases                                          | The contract steps run in the same transaction, behind the verify gates (E9).                                                          |
| Queue drain                                                         | Ids and payload field names are unchanged, so queued jobs stay valid. Stopping the workers is enough.                                  |
| A migration archive                                                 | Every removed value has a surviving home (§5); the snapshot covers a full rollback (G18).                                              |
| Per-phase runbooks                                                  | One runbook: §9.                                                                                                                       |

## 9. Runbook (per instance)

| When                         | Step                                                                                                                                                                                                                                            |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T−7 days                     | `inspect`, `preflight`, `dry-run`. Fix the blockers and re-run until `dry-run` passes. Record the duration. Confirm the config values `inspect` prints. **Notify the coordinators listed under F13**, who will see their org's url / locations. |
| T−1 day                      | Re-run `preflight` and `dry-run`. Optionally prune stale pending registrations (F9).                                                                                                                                                            |
| T0                           | Announce. Scale **API and worker to 0**.                                                                                                                                                                                                        |
| T0 + 1 min                   | Take the DB snapshot and note its id.                                                                                                                                                                                                           |
|                              | `apply --snapshot-taken <id>`. On failure nothing is applied: scale back up on the old image.                                                                                                                                                   |
|                              | `verify`.                                                                                                                                                                                                                                       |
|                              | Deploy the new API, worker and web images (boot finds nothing pending).                                                                                                                                                                         |
|                              | Smoke checks: coordinator OTP login, dashboard, profile (org details shown), an approval link, a public link submit (old URL still works), a bulk upload, and coordinator registration with the org selector.                                   |
|                              | Scale up; `enrich`; `report`.                                                                                                                                                                                                                   |
| Rollback **before scale-up** | Restore the snapshot and redeploy the previous tag. Nothing is lost; no Keycloak or Signals undo is needed.                                                                                                                                     |
| Rollback **after scale-up**  | `revert` (§13): it rebuilds the 0022 shape **keeping the writes made since go-live**. Then deploy the previous tag with its previous env. The snapshot is the last resort.                                                                      |

**Expected downtime:** the `dry-run` duration, plus the snapshot, plus pod start. Minutes.

## 10. Testing the migration path

- **Fixtures at 0022.** The integration suite migrates a scratch DB to **0022 only** (`INTEGRATION_MIGRATIONS_FOLDER`) and seeds the legacy shape:
  - a flat instance (coordinators with their own url / locations / company / GST);
  - a hierarchy instance with invites, whose coordinators of one org **agree** on url / locations in one org and **conflict** in another;
  - an org with its own `website` / `address` / `state` (`up-gzb` shape);
  - an existing org named "Default";
  - a rejected org plus a new org with the same owner, including disagreeing `owner_kc_sub` values for the F15 blocker test;
  - a person who is both a coordinator and an owner;
  - a coordinator with consent but no ledger row;
  - orphan ledger rows;
  - every status;
  - a non-`aggregator` `actor_type`.

  It then applies the train and asserts every verify gate, §5 (each removed value found in its home), and the response snapshots against the 0022 code, with the intended changes asserted explicitly.

- **Re-run and failure:** `apply` twice is a no-op; a failure injected in 0029 leaves the DB at 0022.
- **Foreign-migration detection:** a DB with the abandoned 0027/0028 is refused (F17).
- **Per instance:** `dry-run` in each real environment before its window.
- **CI:** an advisory "train from 0022" job next to `db-integration`.

## 11. Risks

| Risk                                                              | Mitigation                                                                                              |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| A data shape exists that no fixture covers                        | `dry-run` on the instance's own data; a failing gate rolls the whole train back.                        |
| Locks held for the whole train                                    | Pods are at zero; the duration is measured beforehand.                                                  |
| A wrong mapping is found after go-live                            | Every removed value has a surviving home (§5), so it is corrected online.                               |
| `dry-run` needs room for a copy of the DB                         | `inspect` reports the size; the copy is dropped automatically.                                          |
| A coordinator is surprised by the org's details replacing its own | F13 lists them ahead of time; their own values are kept and shown as a fallback where the org has none. |
| A dev DB carries the abandoned `app_user` migrations              | F17 refuses, with the fix named.                                                                        |

## 12. Decisions (all answered 2026-10-05; see target model §1)

| #   | Answer                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| G15 | One train, one window.                                                                                                                            |
| G16 | `apply` as a job before the new pods (boot only for fresh instances).                                                                             |
| G18 | No archive; values kept on surviving rows (§5); the snapshot covers a full rollback.                                                              |
| G19 | A failing gate rolls back the whole train.                                                                                                        |
| G20 | No shared environment on `feature`.                                                                                                               |
| G21 | `revert` rebuilds a 0022 database from current data and keeps post-go-live writes (§13); it is proven by CI round-trip tests (review 2026-10-06). |

## 13. Revert: back to 0022 without losing post-go-live writes

**Why.** A snapshot restore after scale-up throws away every registration, upload and link created since go-live, so in practice the plan was fix-forward-only. Every value the train removed has a surviving home (§5), so the reverse mapping is possible, and with it a revert that **keeps** those writes.

### 13.1 How: rebuild, don't un-migrate

Hand-written reverse DDL for seven migrations would be long and easy to get subtly wrong. Instead, `user-org-migrate.sh revert`, with **pods at zero**:

1. **Creates `<db>_revert`** on the same server and runs migrations **0000–0022 from the previous release tag** into it. The schema is then exactly what the old image expects, including the tables 0023 / 0024 had dropped (empty, which is what the 0022 code expects: those tables were write-only).
2. **Copies the data** from the live database with the reverse mapping (§13.2), in one transaction (`INSERT … SELECT` over `dblink` / `postgres_fdw`, or a `pg_dump --data-only` of mapping views). Generated columns, defaults and triggers of the 0022 schema apply naturally. `updated_at` is copied, not bumped.
3. **Verifies** `<db>_revert`: row counts per mapping, every 0022 constraint valid, and a sample of API responses rendered by the 0022 code compared with the current code's.
4. **Swaps:** `ALTER DATABASE <db> RENAME TO <db>_train`, then `ALTER DATABASE <db>_revert RENAME TO <db>`. The migrated database stays intact as `<db>_train`, so the revert itself can be undone by swapping back.
5. The operator deploys the **previous image tag** with its **previous env**: `ORG_HIERARCHY_ENABLED` must be restored to that instance's old value.

### 13.2 Reverse mapping (final → 0022)

| 0022 object                 | Rebuilt from                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aggregators`               | `users WHERE user_type = 'coordinator'`, joined to `contact` and `organisations`:<br>• `org_slug` ← `signalstack_org_slug`; `name` ← `coalesce(signalstack_org_name, org.name)`<br>• `parent_org_id` ← `org_id`, or NULL when it is the Default org<br>• `url` / `locations` ← the `legacy_org_details` key **when present** (its value, `null` / `[]` included), else the org's value<br>• `contact` jsonb ← `{name, email, phone}` from `contact`, plus `alternatePhone` (`users.alternate_phone`) and `company` / `gstNumber` (the `legacy_org_details` key when present, else `org.legal_name` / `gst_number`); the generated `contact_phone` / `contact_email` follow<br>• `consent` jsonb ← the latest registration ledger row: `{value: true, given_at: accepted_at, valid_till}`<br>• `type` ← `serves[1]` (NULL when empty); `actor_type` ← `'aggregator'`<br>• `invite_email` ← the invite's email, or `legacy_invite_email`<br>• `profile` ← `profile` without the `legacy_*` keys |
| `aggregator_orgs`           | `organisations WHERE org_type = 'aggregator'`, excluding the Default org:<br>• `display_name` / `slug` ← `profile.renamed_from.name` / `.slug` when 0028 renamed the org to free the Default or root names, else `name` / `slug` (and `renamed_from` is dropped from `profile`)<br>• `owner_email` / `owner_phone` ← the `org_owner` user's contact; `owner_kc_sub` ← its `keycloak` identity<br>• `state` and `profile` ← straight copies: 0029 keeps the org's own `state` / `profile.website` / `address` / `coordinates` until Phase 5 (D4-6), so nothing is rebuilt from `url` / `locations`                                                                                                                                                                                                                                                                                                                                                                                             |
| tenant tables               | the same rows; `aggregator_id` ← `user_id`; `org_id` is dropped; `onboarding.org_slug` ← `signalstack_org_slug`; `campaign_pii_audit.actor_org_id` ← `actor_signalstack_org_id`; enum `aggregator_status` ← `registration_status`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `registration_invites`      | `parent_org_id` ← `org_id`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `aggregator_consent_record` | `consent_record`: `subject_type` `'user'` → `'aggregator'`, `'organisation'` → `'org'`; the typed links and `valid_till` are dropped; `registration-backfill` rows are kept (they record consent the old column held, and keep a re-apply from backfilling twice)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

**Not representable in 0022, so dropped by a revert (all harmless):**

- coordinators' `user_identities` rows (re-learned after a later re-apply; owners' come back as `owner_kc_sub`);
- the NF root, the Default org and the network-admin account;
- `known_as`;
- org `url` / `locations` / company / GST values that came from **no** coordinator. None exist until the Phase 5 org editing ships, and `report` counts them.

**Edge cases:**

- **A coordinator registered after go-live under the Default org** becomes a flat coordinator again.
- **An org registered after go-live** is reverted like any other.
- **A person who is both a coordinator and an owner** maps back to one `aggregators` row plus one `aggregator_orgs` owner, as before.

### 13.3 Proving it

- **CI round trip (advisory job, next to "train from 0022"):** fixtures at 0022 → train → `revert` → compare every table with the original fixtures. The only allowed difference is G14's `consent.given_at`, which can move by seconds (`given_at` is rebuilt from the ledger's `accepted_at`, D4-3), plus the added `registration-backfill` rows.
- **CI forward-write-revert:** after the train, create a coordinator under a real org and one under the Default org, an org, an upload and a link. Revert, then boot the **0022 image** against the result and run its smoke tests.
- **Per instance:** `dry-run` also runs the revert on its scratch copy and reports the round-trip differences, before the window.

### 13.4 When to use which rollback

| Situation                           | Use                                                                 |
| ----------------------------------- | ------------------------------------------------------------------- |
| `apply` failed                      | Nothing to do: nothing was applied (E9).                            |
| A problem found **before** scale-up | Snapshot restore, or `revert`; both lose nothing.                   |
| A problem found **after** scale-up  | `revert`: it keeps the new writes. The snapshot is the last resort. |
| A wrong mapping on a few rows       | Fix forward: the values have surviving homes (§5).                  |

## 14. Review changes (2026-10-06): these override the sections above

From `plan-review-2026-10-06.md` §5.

**Principles, corrected:**

- **E6 (A6).** Nothing outside the database changes, **except one Keycloak prerequisite on formerly-flat instances**: the `org_owner` realm role and the `aggregator-api` `manage-realm` grant. They are already present wherever the hierarchy was on.
- **E8 (A4).** The new image has a **boot guard**. With `RUN_MIGRATIONS_ON_BOOT=true` (compose hard-codes it), a pod booting against a non-empty DB at 0022–0026 **refuses to migrate** and exits with a clear message while a train migration is pending, so `apply` (which bypasses the guard) must run first. No marker table is needed (`users-phase-2-implementation.md` §4). Deploying before `apply` is therefore safe: pods wait instead of running the train unprepared.
- **E9 (A25).** One transaction for the train. On failure the DB is exactly at 0022, apart from the `migration_input` helper table, which is overwritten by the next attempt and dropped by a successful 0028.

**New pre-flight checks:**

| #             | Check                                                                                                                                                                                                                      | Category                                | Resolution                                                                                                                              |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| F5 (amended)  | `actor_type` other than `'aggregator'`                                                                                                                                                                                     | info                                    | After the train, profile GET returns `actor_type: 'aggregator'` for these rows; listed per instance as an intended change (expected 0). |
| F10b          | A stored `consent.value <> true`, or a `given_at` more than 1 s from the ledger                                                                                                                                            | **blocker** (expected 0)                | A human decides: re-record consent, or retire the registration.                                                                         |
| F16 (amended) | Any function, trigger, view or rule whose body names a renamed **table or column** (`aggregators`, `aggregator_orgs`, `org_slug`, `display_name`, `parent_org_id`, `aggregator_id`, …), from a `pg_proc` / `pg_views` scan | **blocker** if not handled by 0027–0029 | Known: `aggregators_lock_slug()`, `contact_gc()`, the delete triggers (all recreated by 0027).                                          |
| F18           | 0024 drops `participants`: the reconciled-to-Signals check from `0024_drop_participants.sql`                                                                                                                               | **blocker**                             | Run that check against the instance; proceed only when it passes.                                                                       |
| F19           | Keycloak: the `org_owner` realm role exists, and the `aggregator-api` service account has `manage-realm`                                                                                                                   | **blocker** (formerly-flat instances)   | Apply the realm step (bluedots-automation; `apply-user-profile.sh` §1b locally).                                                        |
| F20           | `updated_at` baseline: a checksum per table of `(id, updated_at)`                                                                                                                                                          | info                                    | Verify compares it after the train (A9).                                                                                                |

**Runbook additions (§9):**

| When                         | Step                                                                                                                                                                                                 |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T−7 days                     | Run F18 and F19, and apply the Keycloak prerequisite where needed. **Edit the instance env:** remove `ORG_HIERARCHY_ENABLED` (it is ignored with a warning for one release, A3).                     |
| T0, before deploy            | `apply` must come first; the boot guard (E8) stops pods from migrating on their own.                                                                                                                 |
| Rollback, snapshot path only | Run `fix cleanup-after-restore` with the post-T0 id list that `report` recorded. It removes the Keycloak users created after T0 and lists their Signals orgs (A18). `revert` (§13) does not need it. |

**Tests (§10) additions:**

- the boot guard refuses a 0022 DB with data and allows an empty one;
- the `lock_slug` function works after the rename;
- org rollback and prune free the owner's email / phone, and keep a Keycloak user shared with another org;
- every tenant insert path sets `org_id`;
- `updated_at` is unchanged after the train.
