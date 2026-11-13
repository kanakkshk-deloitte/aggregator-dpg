# Runbook: deploying the `contact` table (migrations 0025 + 0026)

This release moves each coordinator's and org owner's name / email / phone into one `contact` table, referenced by `aggregators.contact_id` and `aggregator_orgs.contact_id`. The legacy copies are dropped: `aggregators.contact`, `contact_phone`, `contact_email`, and `aggregator_orgs.owner_email`, `owner_phone`.

It ships as **one release**, deployed **stop-the-world**: the API and worker are at zero replicas before the new release starts. The release's first API boot applies 0025 (a no-op when pre-applied) and 0026 in one transaction; 0026 drops the columns the old release reads and writes, so no old pod may be running.

**Requirements:** PostgreSQL 14+ (`CREATE OR REPLACE TRIGGER`). Run every command from a checkout of **the release tag you are deploying**, so the SQL you pre-apply is byte-identical to what the pods run. Connect the script with one of `DATABASE_URL`, `PG_CONTAINER` (+ `PG_USER` / `PG_DB`) or `PSQL_CMD`; it prints the database and role it connected to — check them. Run as the **role that owns the tables**, or a role that may `SET ROLE` to it (e.g. a superuser); 0025 switches to the owner itself and refuses any other role.

## Fresh instance

Nothing extra. The first boot applies every migration.

## Existing instance

| #   | Step                                                        | Command                                                                                                                                                              | Expect                                                                                                                                |
| --- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Pre-flight (read-only, may run while live)                  | `./scripts/contact-migrate.sh preflight`                                                                                                                             | exit `0`. Exit `1` means a blocking count is non-zero: fix those rows (only ids are printed), coordinating with Keycloak, and re-run. |
| 2   | Dry run (may run while live; locks both tables for seconds) | `./scripts/contact-migrate.sh dry-run`                                                                                                                               | exit `0`, `rolled back, nothing changed`                                                                                              |
| 3   | **Scale the API and worker to zero**                        | e.g. `kubectl scale deploy/aggregator-api deploy/aggregator-worker --replicas=0`                                                                                     | no pod connected                                                                                                                      |
| 4   | **Snapshot the database.** 0026 is not reversible.          | your usual backup                                                                                                                                                    | —                                                                                                                                     |
| 5   | Apply 0025                                                  | `./scripts/contact-migrate.sh apply`                                                                                                                                 | `applied`                                                                                                                             |
| 6   | Verify                                                      | `./scripts/contact-migrate.sh verify`                                                                                                                                | **exit `0`** (V1, V2, V4 = 0). Do not deploy otherwise.                                                                               |
| 7   | **Deploy the new API at 1 replica**                         | your usual deploy                                                                                                                                                    | healthy. Its boot records 0025 (no-op) and applies **0026**. The worker does not run migrations, so it waits.                         |
| 8   | Verify again                                                | `./scripts/contact-migrate.sh verify`                                                                                                                                | exit `0` (V4 / V6 no longer print; those columns are gone)                                                                            |
| 9   | Start the worker, scale the API back up                     | your usual deploy                                                                                                                                                    | healthy                                                                                                                               |
| 10  | Owner names (one-off)                                       | `pnpm --filter @aggregator-dpg/api exec tsx scripts/backfill-owner-contact-names.ts --dry-run`, then again without `--dry-run` (needs `DATABASE_URL` + `KEYCLOAK_*`) | V5 drops to `0`, except orgs whose Keycloak user no longer exists                                                                     |

Several API replicas booting at once is safe: `runMigrations()` holds a session advisory lock around the whole drizzle run, so they apply migrations one after another. Scaling to 1 in step 7 just keeps a failure easy to read.

**Non-ASCII emails.** If pre-flight reports `non_ascii_email > 0`, stop and review those rows before applying: the contact id hashes the lowercased email, and Postgres and the application must lowercase it identically.

**Boot fails in step 7.** The migration transaction rolls back; the database is exactly as after step 5. The error names the problem with counts only (e.g. `0026: … org(s) have no contact_id`). Fix what it names, run `verify` until it exits `0`, and redeploy.

**Rollback.** Restore the step-4 snapshot and deploy the previous release. If the old release is started again after `apply` but before the new release is deployed (no restore), 0025's sync triggers keep `contact` in step with its writes, and the next boot's re-run of 0025 relinks what it can; run `verify` (must exit `0`) before deploying again.

## What the checks mean

| Check                    | Meaning                                                                                                                                                                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pre-flight blocking      | Emails with two phones, phones with two emails (across coordinators **and** org owners), non-canonical phones, blank emails. Each breaks one-person-per-email / per-phone. 0025 refuses to create the table while any is non-zero. |
| Pre-flight informational | Non-ASCII emails (review, see above), blank coordinator names (stored as NULL), rows with extra contact keys (move to `contact_extra`), mixed-case emails (returned lowercased), inactive orgs without a Keycloak owner.           |
| V1                       | Rows with no `contact_id`. 0026 refuses to run while non-zero.                                                                                                                                                                     |
| V2                       | Contacts whose id does not match `contact_id_of(email, phone)`.                                                                                                                                                                    |
| V3                       | Orphan contacts, referenced by nothing (should be 0).                                                                                                                                                                              |
| V4 (before 0026 only)    | Legacy columns that disagree with the linked contact.                                                                                                                                                                              |
| V5                       | Org owners without a name. Owner names were only ever stored in Keycloak; step 10 fills them in.                                                                                                                                   |
| V6 (before 0026 only)    | Coordinator rows with a NULL legacy contact (informational).                                                                                                                                                                       |

## Behaviour changes to expect

The API contract is unchanged except for three intended `409`s:

- `PHONE_EXISTS` when an org owner or coordinator uses a phone another person already holds. One person per email and per phone across both roles; the phone is the OTP login key.
- `USER_EXISTS` when a coordinator changes their email, in a profile update, to an email an org owner already holds.
- `CONFLICT` when someone changes the email or phone of a contact shared by a coordinator and an org owner (the same person in both roles, same email **and** phone, shares one row). A later phase models accounts separately.

`contact.id` is derived from the email and phone, so treat it as personal data: never log it or put it in a URL.
