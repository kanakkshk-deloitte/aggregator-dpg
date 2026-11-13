# Consent storage: `aggregators.consent` vs `aggregator_consent_record`

> **Resolved by migration 0029 (user & org refactor, Phase 4).** The ledger, renamed `consent_record`, is now the only home of consent: `users.consent` is dropped, the profile composes `consent` from the newest registration row, registration writes the row in the same transaction as the account, and a trigger keeps the ledger append-only. The analysis below is kept as the record of why. See `docs/plans/cleanup-phase-4-implementation.md`.

Analysis of whether coordinator (aggregator) consent is stored twice, and what to
do about it. Checked against the code on `refactor/contact-phase1` (PR #825) and
the local `aggregator` database on 2026-10-01.

**Verdict:** yes, consent is duplicated. The two stores overlap almost entirely;
the jsonb column is the weaker copy (mutable, unversioned, never used for a
decision). The ledger should be the single source of truth.

## What each store holds

|                 | `aggregators.consent` (jsonb column)                         | `aggregator_consent_record` (ledger)                                                                   |
| --------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Added           | 0000 (initial schema)                                        | 0017                                                                                                   |
| Content         | `{value, given_at, valid_till}`                              | `terms_version`, `privacy_version`, `network`, `brand`, `source`, `accepted_at`                        |
| Written by      | coordinator registration (`stampConsent`), **profile PATCH** | coordinator registration, org registration, bulk-upload attestation (`source = bulk_upload:<id>:v<n>`) |
| Mutable         | **yes** (`PATCH /v1/aggregators/profile/me`)                 | no (append-only)                                                                                       |
| Read by         | profile GET (echoed back only)                               | nothing                                                                                                |
| Orgs            | no column                                                    | yes (`subject_type = 'org'`)                                                                           |
| Link to subject | own row                                                      | polymorphic `subject_id`, no FK (by design)                                                            |

## Overlap

- **`given_at` vs `accepted_at`:** both are the server clock at registration.
  Local DB: identical on all 5 coordinators (max gap 0 s).
- **`value`:** always `true` (registration requires it; local DB: 0 rows false).
  It carries no information.
- **`valid_till`:** the only field unique to the column, and nothing uses it.
  No expiry check, no worker job, and it is not sent to Signals
  (`bulk-row-process.ts` derives its consent from network config, not this
  column).
- **Ledger only:** which terms and privacy versions were accepted. That is what
  an audit actually needs.

Local DB integrity at the time of the check:

| Check                                 | Result |
| ------------------------------------- | ------ |
| Coordinators without a ledger row     | 0      |
| Ledger rows for a missing coordinator | 0      |
| Ledger rows for a missing org         | 0      |

## Problems

1. **The column can be rewritten by the user.** `AggregatorPatchSchema`
   (`apps/api/src/routes/aggregator-profile.ts:50`) accepts any
   `{value, given_at, valid_till}`, and line 262 writes it with no ledger
   entry. A coordinator can backdate or extend consent, or set `value: false`;
   the two stores then disagree silently.
   - The web profile form hides the consent block and **never sends a profile
     PATCH**: `profile.service.ts` only GETs.
   - The Next.js proxy (`apps/web/src/app/api/aggregator/profile/me/route.ts`)
     forwards any PATCH body as-is, so the hole is reachable by any logged-in
     coordinator.
2. **Org consent fields are validated loosely and then discarded.**
   `aggregator-orgs.ts:53` accepts `given_at` / `valid_till` as any string
   (not `datetime`), then ignores them: orgs get only a ledger row with a
   server-stamped `accepted_at`.
3. **Registration and ledger write are not atomic.** If the ledger write fails,
   the route deletes the new coordinator or org (compensating delete). A crash
   between the two leaves a subject with no consent record.
4. **Orphaned ledger rows.** There is no FK, so pruned or deleted registrations
   leave their ledger rows behind. There is no retention or erasure rule yet.
5. **Reclaim does not re-record consent.** A re-submitted registration keeps
   the original ledger row. This is documented as deliberate in v1
   (`aggregator-registrations.ts:177`), but should be revisited if the terms
   version changed in between.

## Recommended improvements (in order)

1. **Remove `consent` from the profile PATCH body.**
   - Closes the tampering hole. Small change.
   - Safe for the web app, which never PATCHes the profile.
   - `openapi.json` changes: an optional request field is removed. With
     `.strict()`, clients still sending it get a 400.
2. **Make the ledger the single source of truth (expand / contract).**
   - **Expand:** profile GET builds `consent` from the latest ledger row
     (`value: true`, `given_at = accepted_at`), so the response shape is
     unchanged. Registration stops writing the column (make it nullable first).
   - **Contract:** a later migration drops `aggregators.consent` and
     `aggregators_consent_shape_chk`, the same pattern as 0025 / 0026 in
     Phase 1.
3. **Decide on `valid_till`.** Either drop it (it is unused), or add a nullable
   `expires_at` to the ledger and actually enforce it (re-consent flow).
4. **Write the ledger row in the same transaction as the coordinator or org
   row.** This replaces the compensating delete, and fits the store-owned
   transactions introduced in Phase 1 (`contact-writes.ts` pattern).
5. **Tighten the org request schema:** validate `consent` with
   `ConsentRecordSchema` (or drop the timestamps the server ignores anyway).
6. **Ledger retention policy:** keep orphaned rows for audit, or delete them on
   an erasure request. Optionally add a unique key on
   `(subject_type, subject_id, source, terms_version, privacy_version)` to make
   re-tries idempotent.

## Suggested placement

A dedicated phase after Phase 2 (user & org management). Item 1 is independent
and can ship on its own as a quick security fix.
