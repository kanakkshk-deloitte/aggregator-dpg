# Implementation plan: User & Org management refactor, Phase 4 (duplicate-data cleanup)

**Date:** 2026-10-05
**Branch:** `refactor/user-org-management`
**Status:** Implemented — `cleanup-phase-4-implementation.md` is the authoritative design (decisions D4-1 … D4-11, the review, the implementation notes); where the two differ, it wins. Read `user-org-target-model.md` first.
**Depends on:** Phase 2 (`users`, 0027) and Phase 3 (`organisations`, 0028).
**Ships in:** the release train (G15).

> Delete this file in the commit that completes the train.

---

## 1. Goal

Each remaining fact gets one home:

| #   | Duplicate today                                                                        | One home after Phase 4                                                                       |
| --- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| C1  | `users.consent` jsonb **and** `aggregator_consent_record`                              | the ledger, renamed `consent_record`                                                         |
| C3  | `users.type` (single domain) vs the design doc's `agg_for` (named `serves` here, D4-1) | `users.serves text[]`                                                                        |
| C5  | `contact_extra.alternatePhone` (the person's) inside a mixed jsonb                     | `users.alternate_phone`; `contact_extra` is dropped (company / GST already moved in Phase 3) |
| C8  | `actor_type` restates `type`                                                           | dropped                                                                                      |
| M3  | `users.invite_email` copies `registration_invites.email`                               | `users.invite_id` (FK, `ON DELETE SET NULL`)                                                 |
| M6  | `aggregator_status` and `aggregator_*` object names                                    | `registration_status`; `users_*` / `organisations_*` names                                   |

Profile GET still returns `consent: {value, given_at, valid_till}` and the same Beckn `contact`; only `given_at` shifts by under a second for old rows (G14). The consent PATCH hole is already closed by the separate fix PR.

## 2. Schema after Phase 4

```sql
ALTER TABLE aggregator_consent_record RENAME TO consent_record;
ALTER TABLE consent_record
  ADD COLUMN user_id    uuid REFERENCES users(id)         ON DELETE SET NULL,
  ADD COLUMN org_id     uuid REFERENCES organisations(id) ON DELETE SET NULL,
  ADD COLUMN valid_till timestamptz;
-- subject_type values: 'aggregator' → 'user', 'org' → 'organisation'; subject_id kept (permanent audit key)
CHECK (num_nonnulls(user_id, org_id) <= 1)
CHECK (user_id IS NULL OR (subject_type = 'user'         AND subject_id = user_id))
CHECK (org_id  IS NULL OR (subject_type = 'organisation' AND subject_id = org_id))

ALTER TABLE users ADD COLUMN serves text[] NOT NULL DEFAULT '{}';    -- ← ARRAY[type]
ALTER TABLE users ADD COLUMN alternate_phone text;                    -- ← contact_extra->>'alternatePhone'
ALTER TABLE users DROP COLUMN consent, DROP COLUMN type, DROP COLUMN actor_type, DROP COLUMN contact_extra;
DROP TYPE aggregator_actor_type;
```

**Consent mapping is direct, thanks to G1:** a ledger `subject_id` for `'aggregator'` was `aggregators.id`, which **is** `users.id` now.

- Registration rows and bulk-upload attestations → `user_id`.
- `'org'` rows → `org_id`.
- Rows whose subject is gone keep their audit key, with both links NULL (P4-3).
- `valid_till` ← the user's `consent->>'valid_till'` for its `source = 'registration'` row.

## 3. Migration `0029_cleanup.sql`

Same guards; inside the train transaction.

| Step | What                                                                                                                                                                                                                                                                                                                     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S1   | `LOCK TABLE users, organisations, aggregator_consent_record`.                                                                                                                                                                                                                                                            |
| S2   | **Blockers** (first run only, counts only): a coordinator with no `source = 'registration'` ledger row **and** a `consent` value. The consent would be lost, so it is reported, and the migration writes a ledger row for it from the column (`source = 'registration-backfill'`). Not fatal.                            |
| S3   | Rename the table; new columns; map the subjects; `valid_till`.                                                                                                                                                                                                                                                           |
| S4   | `serves`, `alternate_phone` backfill.                                                                                                                                                                                                                                                                                    |
| S5   | Drop `consent`, `type`, `actor_type` (+ the CHECK and index), `contact_extra`, and the enum.                                                                                                                                                                                                                             |
| S6   | **Invite reference (M3):** `users.invite_id` = the consumed `registration_invites.jti` with the same email and the user's `org_id`. When none matches (the invite was deleted), `invite_email` goes to `profile.legacy_invite_email`. Then drop `invite_email`. Approval emails read the invited email through the join. |
| S7   | **One vocabulary (M6):** `ALTER TYPE aggregator_status RENAME TO registration_status`; rename every remaining `aggregator_*` index, constraint, trigger and sequence to `users_*` / `organisations_*` / `consent_record_*`. Metadata only.                                                                               |

## 4. Code changes

| Package / file                                                    | Change                                                                                                                                                                                 |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/consent-ledger`                                         | `recordRegistrationConsent({ userId } \| { orgId }, …, validTill)` takes the caller's transaction executor; the subject strings become `'user'` / `'organisation'`.                    |
| `routes/aggregator-registrations.ts`, `routes/aggregator-orgs.ts` | Write the ledger row **in the same transaction** as the user / org. This replaces the compensating delete; the fail-closed contract is unchanged.                                      |
| `services/aggregator-store/`                                      | `consent` is composed from the latest registration ledger row; `type` reads `serves[0]` (the domain object keeps `type`); `contact.alternatePhone` comes from `users.alternate_phone`. |
| Signals upsert, Keycloak `aggregator_type`                        | Derived from `serves` (unchanged values).                                                                                                                                              |
| `bulk-uploads.ts` attestation                                     | Writes `user_id`.                                                                                                                                                                      |
| `scripts/sql/cleanup-{preflight,verify}.sql`                      | New; run by `user-org-migrate.sh`.                                                                                                                                                     |

## 5. Verification

**Verify:**

| #   | Check                                                 | Gate                        |
| --- | ----------------------------------------------------- | --------------------------- |
| V1  | a coordinator with no linked registration consent row | 0                           |
| V2  | a ledger row whose links disagree with its audit key  | 0 (the CHECKs guarantee it) |
| V3  | `serves` empty while the old `type` was set           | 0                           |
| V4  | ledger rows with both links NULL                      | informational               |

**Tests:**

- profile GET consent composition (G14 asserted);
- the one-transaction registration (a consent failure leaves no user, org or contact);
- the train from 0022, including a coordinator with consent but no ledger row (backfilled);
- `serves` → Signals domains unchanged.

## 6. Risks

| Risk                                                  | Mitigation                                                                                                    |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| A consent value exists only in the column             | S2 backfills a ledger row from it, so nothing is lost.                                                        |
| A brand someday needs several domains per coordinator | `serves` is already an array; the API keeps returning `type` = the first one until Phase 5 exposes the array. |

## 7. Review changes (2026-10-06): these override the text above

| #   | Change                                                                                                                                                                                                                                                                                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A10 | `serves = CASE WHEN type IS NULL THEN '{}' ELSE ARRAY[type] END`; a verify check that no element is NULL. **`actor_type` is derived** in the domain object as `'aggregator'` (profile GET and the approval page keep the field). Rows with another value are listed by F5 as an intended response change (expected 0). |
| A8  | **F10b (blocker, expected 0):** a stored `consent.value <> true`, or a `given_at` more than 1 s from the ledger's `accepted_at`, is resolved by a human before the window, because the rebuild from the ledger cannot represent it.                                                                                    |
| A19 | Profile GET `consent` = the latest ledger row of the user with `source IN ('registration','registration-backfill')`; V1 guarantees one exists.                                                                                                                                                                         |
| A9  | S3–S6 run with `users_set_updated_at` disabled.                                                                                                                                                                                                                                                                        |
| A23 | `campaign_pii_audit.actor_org_id` (a Signals org id) → `actor_signalstack_org_id` (S7).                                                                                                                                                                                                                                |
