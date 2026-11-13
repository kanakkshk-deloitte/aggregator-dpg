# Implementation plan: User & Org management refactor, Phase 2 (`users`)

**Date:** 2026-10-05 (replaces the `app_user` plan of 2026-09-30)
**Branch:** `refactor/user-org-management`
**Status:** Plan. Read `user-org-target-model.md` first (decisions §1, target schema §2, column map §3).
**Depends on:** Phase 1 (`contact`, 0025/0026).
**Ships in:** the release train (G15); applied on existing instances by `scripts/user-org-migrate.sh` (`existing-instance-migration.md`).

> Delete this file in the commit that completes the train.

---

## 1. Goal

- `aggregators` is **renamed `users`**, with ids kept. Every row is a `coordinator` account.
- **Every org owner becomes a `users` row** with `user_type = 'admin'`: their contact, plus their login identity (the Keycloak subject that used to sit on `aggregator_orgs.owner_kc_sub`) in `user_identities`.
- `aggregator_orgs` points at its owner through `owner_user_id` → `users.id`. Its own `contact_id` / `owner_kc_sub` copies are dropped (C7).
- `user_identities (user_id, provider, subject)` holds each account's login, provider-neutral: owners from the backfill; coordinators when known (§4) and through the `enrich` backfill.
- The tenant tables' `aggregator_id` becomes `user_id` (values unchanged).

**Unchanged:** the API contract, tokens, Keycloak, Signals. One person may hold both roles (a coordinator and an org owner): one `contact`, two `users` rows (`UNIQUE (contact_id, user_type)`), as Phase 1 allowed.

**Not in this phase:** `organisations`, `org_id`, moving org details (Phase 3); consent, `serves`, `actor_type`, `contact_extra` (Phase 4).

## 2. Schema after Phase 2

```sql
CREATE TYPE user_type AS ENUM ('admin', 'coordinator');

ALTER TABLE aggregators RENAME TO users;
ALTER TABLE users RENAME COLUMN org_slug TO signalstack_org_slug;
ALTER TABLE users RENAME COLUMN name     TO signalstack_org_name;
ALTER TABLE users ADD COLUMN user_type user_type;            -- backfilled 'coordinator', then NOT NULL
CREATE TABLE user_identities (user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL, subject text NOT NULL CHECK (btrim(subject) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider), UNIQUE (provider, subject));

-- Every coordinator-only column becomes nullable, guarded by ONE CHECK on user_type (review M5):
--   status, rejected_at, invite_email, signalstack_org_slug, signalstack_org_name, signalstack_org_id, type, actor_type,
--   url, locations, consent, contact_extra, profile, profile_ref, parent_org_id
CHECK (CASE user_type WHEN 'coordinator' THEN status IS NOT NULL AND signalstack_org_slug IS NOT NULL AND signalstack_org_name IS NOT NULL
                                              AND actor_type IS NOT NULL AND consent IS NOT NULL
                      ELSE <every coordinator-only column> IS NULL END)   -- an admin row is identity only
DROP INDEX aggregators_contact_id_unique;                    -- one coordinator row per person (D24) …
CREATE UNIQUE INDEX users_contact_type_unique ON users (contact_id, user_type);   -- … becomes per role
-- aggregators_org_slug_unique → users_signalstack_org_slug_unique (renamed; NULLs for admins do not collide)
-- other aggregators_* index / constraint / trigger names → users_*

aggregator_orgs.owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT   -- new
-- dropped: aggregator_orgs.contact_id, aggregator_orgs.owner_kc_sub, aggregator_orgs_contact_ad trigger

-- tenant tables: ALTER … RENAME COLUMN aggregator_id TO user_id (the FK already follows the table rename)
```

**`contact_gc()` must be rewritten.** Its body names `aggregators` and `aggregator_orgs`, and PL/pgSQL resolves table names when it runs, so the rename would break every delete. After Phase 2 a contact is referenced only by `users`. The function checks `users`, and one `AFTER DELETE` trigger on `users` calls it. The same applies to the reference count in `db/contact-writes.ts` `changeContact`.

## 3. Migration `0027_users.sql`

The same guards as 0025/0026:

- saved and restored timeouts, an advisory lock, and running as the table owner, ending with `RESET ROLE`;
- every step guarded, so a re-run is a no-op;
- counts-only messages.

On an existing instance it runs inside the train transaction (0023–0029), applied by `user-org-migrate.sh` with pods at zero.

| Step | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1   | `LOCK TABLE aggregators, aggregator_orgs, contact` and the five tenant tables.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| S2   | **Blocker check** (first run only): an `aggregator_orgs` row with a NULL `contact_id` (expected 0 after 0026). Counts only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| S3   | Type, table rename, column renames, `user_type` added; `user_identities` created; existing rows get `user_type = 'coordinator'`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| S4   | **Admin accounts (identity only, review M2/M5).** One `users` row per distinct `aggregator_orgs.contact_id`: `user_type = 'admin'`, `contact_id`, a `user_identities` row (`provider = 'keycloak'`, `subject` = the owner's `owner_kc_sub`) (the newest non-NULL one when an owner has several orgs; disagreeing values are blocker F15), `created_by = updated_by = 'self'`, and `created_at` = their first org's. **No `status`, `org_id` or other coordinator columns**: an admin's orgs are found through `owner_user_id` / `org_owner`, and whether it can log in is its Keycloak user's enabled flag. `ON CONFLICT (contact_id, user_type) DO NOTHING`. |
| S5   | `aggregator_orgs.owner_user_id` = that admin row; then `NOT NULL` and the FK.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| S6   | Relax the coordinator-only columns; add the CHECKs; swap the unique index (D24 → per role); rename indexes, constraints and triggers to `users_*`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| S7   | Recreate `contact_gc()` against `users`. Drop `aggregator_orgs_contact_ad`; keep the delete trigger on `users` (renamed).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| S8   | Drop `aggregator_orgs.contact_id`, `aggregator_orgs.owner_kc_sub` and their index (`aggregator_orgs_contact_id_idx`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| S9   | Tenant tables: `aggregator_id` → `user_id`; rename the index and FK names to match.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

**A person who owns several orgs** (a rejected one and a new one, D24) gets **one** admin row that owns all of them. The pre-flight reports how many (F11).

## 4. Code changes

| Package / file                                                    | Change                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/db-schema/src/schema.ts`                                | `users` table (`userType`, `kcSub`, `signalstackOrgSlug`, `signalstackOrgName`, the relaxed columns); `aggregatorOrgs.ownerUserId`, with `contactId` / `ownerKcSub` removed; tenant `userId`.                                                                                                                                                                                                                                         |
| `services/aggregator-store/`                                      | **Keeps its name and the `Aggregator` domain object** (routes and responses are unchanged). Backed by `users WHERE user_type = 'coordinator'`; `orgSlug` / `name` map from `signalstack_org_slug` / `signalstack_org_name`. New `recordIdentity(id, sub)`, ported from the `app_user` work: it inserts the `user_identities` row once (`provider = 'keycloak'`), and a subject already linked to another account maps to `DUPLICATE`. |
| `services/aggregator-org-store/`                                  | The owner's email / phone / name come through `owner_user_id → users → contact`; `ownerKcSub` through the owner's `keycloak` identity in `user_identities`. `create` links the owner's contact, then their admin `users` row (`linkAccount`), then the org, in one transaction.                                                                                                                                                       |
| `apps/api/src/db/account-writes.ts` (new)                         | `linkAccount(tx, contactId, userType, kcSub?)`: returns the account for that person and role, creating it if absent. It is the only writer of admin rows.                                                                                                                                                                                                                                                                             |
| `db/contact-writes.ts`                                            | The `changeContact` reference count reads `users` only. A contact shared by a person's admin and coordinator rows is still refused with `SharedContactError` (D19).                                                                                                                                                                                                                                                                   |
| `routes/aggregator-approvals.ts`, `services/auth/access-token.ts` | Call `recordIdentity` when an approver opens the review link, and on the first approved request per process (as the `app_user` design did).                                                                                                                                                                                                                                                                                           |
| `routes/aggregator-org-approvals.ts`, `routes/aggregator-orgs.ts` | Read and write the owner's subject on the admin `users` row.                                                                                                                                                                                                                                                                                                                                                                          |
| `services/owner-name-backfill.ts`                                 | Candidates = admin users with a `keycloak` identity and a nameless contact.                                                                                                                                                                                                                                                                                                                                                           |
| `apps/worker`                                                     | Drizzle property rename `aggregatorId → userId` for the tenant tables and `aggregators → users`. Queue payload field names are **unchanged**.                                                                                                                                                                                                                                                                                         |
| `scripts/sql/users-{preflight,verify}.sql`                        | New; run by `user-org-migrate.sh`.                                                                                                                                                                                                                                                                                                                                                                                                    |
| Branch                                                            | Remove the `app_user` commits (0027/0028 and their code); port the parts named above.                                                                                                                                                                                                                                                                                                                                                 |

## 5. Verification

**Verify (`users-verify.sql`); every check must be 0:**

| #   | Check                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------ |
| V1  | `aggregator_orgs` rows with no `owner_user_id`, or with an owner whose `user_type` is not `admin`      |
| V2  | two `users` rows for the same `(contact_id, user_type)` (the index guarantees 0; the check is a guard) |
| V3  | coordinators that break the CHECKs                                                                     |
| V4  | contacts referenced by nothing (`contact_gc` missed one)                                               |

**Informational:** U5, coordinators without a `keycloak` identity (filled by `enrich`).

**Tests:**

- **Unit:** the stores on the memory fakes, the byte-identical response snapshots, and `linkAccount`.
- **Integration:**
  - the train from 0022 with fixtures (`existing-instance-migration.md` §10): flat, hierarchy, multi-org owner, a person who is both owner and coordinator;
  - a re-run is a no-op;
  - deletes still collect contacts;
  - a subject claimed twice gives `DUPLICATE`.

## 6. Risks

| Risk                                                                                       | Mitigation                                                                                                                            |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Something else names `aggregators` in SQL (a function, view or trigger)                    | The pre-flight lists every dependent object of both tables (`pg_depend`); integration tests run deletes and updates after the rename. |
| An owner with several orgs whose `owner_kc_sub` values disagree (different Keycloak users) | The pre-flight reports it as a **blocker** (F15): a human picks the right account. Expected 0.                                        |
| `signalstack_org_*` renames ripple through code                                            | Drizzle property names keep `orgSlug` / `name` on the `Aggregator` domain type; only the column mapping changes.                      |

## 7. Review changes (2026-10-06): these override the text above

From `plan-review-2026-10-06.md`:

| #        | Change                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A15      | **Logins live in `user_identities (user_id, provider, subject)`**: provider-neutral, on the account, never on `contact` (amended 2026-10-06: a user may later belong to several orgs, and the IAM may change). `recordIdentity(userId, 'keycloak', sub)` inserts once; a subject already linked to another account maps to `DUPLICATE`; `enrich` fills coordinators. Disagreeing subjects for one owner are blocker F15. |
| M2 / M5  | Admin rows are **identity only** (S4 as amended): no `status` and no coordinator columns.                                                                                                                                                                                                                                                                                                                                |
| A2       | **S7 also recreates `aggregators_lock_slug()` as `users_lock_signalstack_org_slug()`** (it reads `org_slug` by name) **before** any UPDATE in this migration, and re-points the trigger. F16 scans every function body for renamed **columns** as well as tables.                                                                                                                                                        |
| A9       | S3's `user_type` backfill and every other row-rewriting step run with `users_set_updated_at` disabled. Verify: `updated_at` is unchanged for every pre-existing row.                                                                                                                                                                                                                                                     |
| A5       | A new **org-delete helper** (`db/org-delete.ts`) is used by the org consent rollback, `discardHalfCreatedOrg` and prune. It deletes the org, then the owner's admin row **and** Keycloak user only when the owner has no other org (and is not the NF / Default owner). Contact GC follows from the `users` delete trigger.                                                                                              |
| A4 / A24 | **Boot guard** in `runMigrations()`: refuses while a train migration is pending on a non-empty DB (dev override `ALLOW_TRAIN_ON_BOOT`). **Foreign-migration guard:** refuses journal rows with an unknown `when`; a hash mismatch only warns. New 0027 `when` = 1791200000000. Details: `users-phase-2-implementation.md` §4.                                                                                            |
| A22      | Retire or port `scripts/backfill-kc-aggregator-type.sh`, `scripts/contact-migrate.sh` with `scripts/sql/contact-*`, `scripts/sql/app-user-verify.sql`, and the e2e skill helpers.                                                                                                                                                                                                                                        |
