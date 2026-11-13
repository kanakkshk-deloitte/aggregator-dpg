# Decisions log — User & Org management refactor

**Branch:** `refactor/user-org-management` (from `feature` @ `1f31f6b`), in the worktree `../aggregator-dpg-user-org`
**Purpose:** Every decision taken while implementing without you. Each one lists the options considered, the choice, and why. Items marked **⚠ REVIEW** are the ones most worth a second look.
**Companion plans:** `docs/plans/user-org-target-model.md` (map), then the per-phase files.

> Delete this file together with the plan once the refactor has shipped (repo convention for `docs/plans/`).

## ▶ Start here — status (updated 2026-10-05, after the plan rework)

Read **`user-org-target-model.md`** first: decisions §1, schema §2, column map §3, org-detail rules §4, phase map §5. Then **`existing-instance-migration.md`**, the path for deployed instances (all at migration 0022: one window, one tool).

| Phase               | What                                                                                                                                                                      | Status                                                                                 | Plan                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------- |
| 1 — `contact`       | name / email / phone once (0025, 0026)                                                                                                                                    | **shipped** to `feature` (#825)                                                        | —                                      |
| fix — consent PATCH | remove `consent` from the profile PATCH body                                                                                                                              | next: own PR                                                                           | `docs/consent-duplication-analysis.md` |
| 2 — `users`         | `aggregators` → `users` (ids kept), admin accounts for owners, `kc_sub` (0027)                                                                                            | planned; replaces the abandoned `app_user` work (kept on `backup/user-org-pre-rebase`) | `users-phase-2.md`                     |
| 3 — `organisations` | `aggregator_orgs` → `organisations`, NF root + Default org, `org_owner`, `users.org_id`, hierarchy always on, `url` / `locations` / company / GST moved to the org (0028) | planned                                                                                | `organisation-phase-3.md`              |
| 4 — cleanup         | consent ledger only, `serves`, `alternate_phone`; drop `actor_type` / `contact_extra` (0029)                                                                              | planned                                                                                | `cleanup-phase-4.md`                   |
| 5 — APIs            | `/v1/org`, `/v1/user`, admin login                                                                                                                                        | planned (banner: rework against the new model)                                         | `apis-phase-5.md`                      |
| 6 — cross-cutting   | PII encryption, agreements, RBAC                                                                                                                                          | planned (banner)                                                                       | `cross-cutting-phase-6.md`             |

**Review 2026-10-06:** `plan-review-2026-10-06.md`:

- 12 corner cases, 7 simplifications and 25 independent-review findings, all resolved into the plan files;
- a lossless `revert`.

**Open (small):** target model §7 R1–R3, Phase 3 §7 P3-1 to P3-3. Each has a recommendation.

### (2026-09-30) What was done at the time

| Phase                                                                            | Releases                                                                                                              | Status                                                                           |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **1 — `contact`** (name/email/phone once, FK `contact_id`)                       | R0 pre-deploy script + 0025 · R1 read via join · R2 app writes contact · R3 legacy columns out of code · R4 0026 drop | **complete**, two independent review rounds fixed                                |
| **2 — `app_user`** (one account per person per role, Keycloak subject in the DB) | R0 0027 · R1 read owner subject from account · R2 write it · R3 0028 drop `owner_kc_sub`                              | **complete**, review round 3 running/folded below                                |
| **3 — organisation**                                                             | plan: `organisation-phase-3.md`                                                                                       | **planned only** — core design choices need you (⚠ O2, O3, O5 `known_as` values) |
| **4 — `/v1/org`, `/v1/user` APIs**                                               | plan: `apis-phase-4.md`                                                                                               | **planned only** — needs SMS gateway choice, admin-login approach                |
| **5 — PII encryption, agreements, RBAC**                                         | plan: `cross-cutting-phase-5.md`                                                                                      | **planned only** — needs key-management choice                                   |

Why I stopped implementing at Phase 2: Phases 3–5 each hinge on decisions only you can make (org model, instance naming data, SMS vendor, KMS). Everything up to there is behaviour-neutral for users except the intentional `PHONE_EXISTS` tightening (U3).

### How it was validated

- `pnpm -w lint typecheck test` (31 tasks), `pnpm dep-check`, OpenAPI drift (unchanged) — green at every commit.
- Real-Postgres integration suites (contact, app_user, campaign store) in **three schema states**: expand-phase (≤0025), pre-0028 (≤0027) and final — all green; CI job `db-integration` runs the same (advisory, D15).
- **Local deploy on a parallel stack** (your `:3000`/`:4000` untouched): API `:4100` + web `:3100` from the worktree, against `aggregator_r1` — a `pg_dump` clone of your local `aggregator` DB — walked through every release in order (R0 script → R1 → R2 → R3 → R4 boot → Phase 2 R0…R3 boot). Snapshots before each destructive step are in the session scratchpad.
- **Browser (chrome-devtools)** on that stack: org registration (owner name persisted), coordinator registration, `PHONE_EXISTS` on cross-role phone clash (both directions), resubmit/reclaim, OTP login, dashboard, profile (byte-identical fields), coordinator + org approval links (org approval assigned the `org_owner` role via the account's Keycloak subject).
- Three review agents (plus test agents) — every finding reproduced and fixed; see "Review round 1/2/3".

### What needs you (in priority order)

1. **Release process (⚠ M1 in review round 2):** squash/rebase this branch before cutting releases so each release ships the _final_ text of its migrations (intermediate commits carry earlier revisions of 0025/0027).
2. Decisions marked **⚠ REVIEW** below: D2, D5, D15 (promote CI job to required), D19, D21, D24, P2-D8, P2-D9.
3. Phase 3–5 plans: 12 + 14 + 10 ⚠ REVIEW items listed in each plan.
4. Local env gaps found (not caused by the refactor): copied `apps/api/.env` points SMTP at `:1025` (mailpit is `:1026`); `SIGNALSTACK_ACTING_ORG_ID` unset → coordinator approval stops at the Signals upsert.
5. Clean-up when done: the `:4100`/`:3100` processes, the `aggregator_r1`/`aggregator_it`/`aggregator_it25` scratch DBs, the worktree's copied `apps/api/.env` / `apps/web/.env.local`, and the stale plan copy in your main checkout.

### Commit map

```
25dcf44 R0  contact table + idempotent pre-deploy migration 0025
26c6c1a R1  reads through contact; org-create pre-checks; owner name
181b91b     review round 1 fixes
37a4b63 R2  app writes contact directly
7dcc9eb R3  legacy columns out of the application
8a5d178 R4  0026 drops legacy columns
8d77c67     one coordinator row per person (self-found)
dbd5046 P2 R0  app_user (0027) + Keycloak subject recording
f1850fa        test typing fix
0c13d24     review round 2 fixes
9b16f7c     Phase 3–5 plans
b0e838c P2 R1  owner subject read from account
51ca47f P2 R2  owner subject written to account
c57bfa1 P2 R3  0028 drops owner_kc_sub
```

---

## Decisions you made (2026-09-30)

| #   | Decision                                                                                                                                                          |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U1  | **Contact.** A `contact` table with `id`, `email`, `phone`, `name`. The id is sha256 of `lower(email):phone`.                                                     |
| U2  | **FK naming.** Every FK to it is named `contact_id`. Only a second FK in the same table takes a role prefix.                                                      |
| U3  | **Phone uniqueness.** One phone per person across coordinators and org owners. The case of a coordinator who is also an org contact is handled separately, later. |
| U4  | **Hash input.** Exactly `lower(email):phone`.                                                                                                                     |
| U5  | **Side bugs.** They became separate issues: #822, #823, #824.                                                                                                     |
| U6  | **CI.** Add a Postgres service to CI.                                                                                                                             |
| U7  | **Existing instances.** A pre-deploy migration script creates and pre-populates `contact`. The drizzle migration is idempotent (`IF NOT EXISTS`).                 |
| U8  | **Branching.** One branch for all phases. The five local-setup edits sit in the worktree uncommitted and are never staged.                                        |

---

## Phase 1 — decisions taken during implementation

### D1. The migration file IS the pre-deploy script

- **Options considered:**
  - (a) A separate script plus a separate migration.
  - (b) One file, run both by `psql` and by drizzle.
- **Chosen:** (b). `apps/api/drizzle/migrations/0025_contact.sql` is run by `scripts/contact-migrate.sh apply` and again, as a no-op, at the next API boot.
- **Why:** There is no second copy that can drift. Drizzle never compares file hashes, only a `when` high-water mark, so a pre-applied file is harmless.

### D2. ⚠ REVIEW — Journal `when` = `1790800000000`, not "just after 0024"

- **What was found:** Your local `aggregator` DB records a migration at `when=1790700000000`. That is an earlier version of 0024 from commit `9ef5904`, and it was **applied twice** (rows 25 and 26).
- **Why that matters:** Drizzle skips any migration whose `when` is at or below that value. A 0025 stamped `1790696…` would therefore **never run** on such a DB.
- **Chosen:** `1790800000000`, which clears it.
- **Also:** the double application is live evidence of the missing migration lock (see D3).

### D3. Advisory lock + lock/statement timeouts inside 0025

- **Why:** Drizzle's pg migrator takes no lock, and HPA and multi-pod boots race.
- **Chosen:** `pg_advisory_xact_lock(hashtext('aggregator-dpg:0025_contact'))` plus `lock_timeout 5s` and `statement_timeout 300s`. Both timeouts are reset at the end of the file, so later migrations in the same run are not affected.

### D4. The sync triggers are best-effort; they never fail a legacy write

- **Rule:** When a legacy write (from release N−1 during a rollout, or from the running release after the script) cannot be linked, the FK is left NULL and a `WARNING` is raised. The write still succeeds.
- **Why:** Anything stricter would change live behaviour the moment the script runs. For example, some 409s would become 503s (review B3).
- **What still guards duplicates:**
  - Coordinator duplicates are still caught by the legacy unique indexes, with the same constraint names and therefore the same error codes. The integration test pins this.
  - The new cross-role rule is enforced by app pre-checks (D7).
- `scripts/sql/contact-verify.sql` V1 counts rows left unlinked.

### D5. ⚠ REVIEW — R1 keeps the app's WRITE path on the legacy columns; R1 switches READS only

- **Plan said:** in R1 the app writes `contact` first, then dual-writes the legacy columns.
- **Chosen instead:**
  - **R1:** the app still writes only the legacy columns (unchanged code paths), and the database triggers maintain `contact`. All reads come from the `contact` join. There are also new pre-checks and the owner name.
  - **R2:** the app writes `contact` directly and stops writing the legacy columns.
- **Why:**
  - Each release changes one direction only (reads, then writes), so R1 is a much smaller behavioural diff.
  - The triggers are already needed for N−1, so relying on them in R1 adds no new mechanism.
  - Rolling back from R1 is trivially safe.

### D6. No `ContactStore` in R1

- **Why:** The only R1 need is the org-create pre-check, and it is served by the existing `aggregatorStore.findByContactEmail`/`findByContactPhone` plus a new `orgStore.findByOwnerPhone`.
- **When it arrives:** `ContactStore` (link/change) comes in R2, when the app starts writing `contact`.

### D7. Org create gets contact pre-checks, run before any write

- **Checks:**
  - **Email held by a coordinator:** returns `409 OWNER_ALREADY_REGISTERED`.
    - This is the **same** code the Keycloak `USER_EXISTS` branch already returned.
    - Before, that branch ran only after the org row and Keycloak group had been created, and it left an inactive org row behind.
    - Now nothing is written. This is a strict improvement.
  - **Phone held by a coordinator, or by a different org's owner:** returns `409 PHONE_EXISTS`.
    - This is your U3 decision. It is the one intended behaviour change in Phase 1.
- **Not changed:** coordinator registration already checked the owner's phone through the Keycloak `phoneNumber` attribute.

### D8. The owner name is persisted at org create (fixes P3)

- **How:** `CreateOrgInput.ownerName`. Inside the same transaction as the insert, `contact.name` is set if it is still NULL; an existing name wins.
- **Existing owners:** filled by the one-off `apps/api/scripts/backfill-owner-contact-names.ts`, which reads Keycloak first/last name by `owner_kc_sub`. It supports `--dry-run`, is idempotent, and retries once.

### D9. `contact_extra jsonb` on `aggregators`

- **What it holds:** `alternatePhone`, `company`, `gstNumber`. These are part of the API's `contact` object but are not identity.
- **How the response is composed:** `{name, email, phone, ...extras}`, in the **same key order** the legacy jsonb produced (Postgres orders jsonb keys by length, then bytes), so responses stay byte-identical. A unit test covers this.

### D10. Legacy columns relaxed to nullable in 0025, not in a later migration

- **Why:**
  - It is invisible to N−1, which always writes these columns.
  - It makes R2 migration-free, so R2 can roll back to R1 freely.
- **Drizzle types:** also made nullable now, so the compiler forces every read to handle NULL.

### D11. Reads fall back to the legacy columns while they exist

- **Rule:** `findByContactEmail`/`Phone` and `findByOwnerEmail`/`Phone` match the linked contact **OR** (when `contact_id IS NULL`) the legacy column.
- **Why:** A duplicate or reclaim check must never miss an unlinked straggler.
- **Removal:** the fallback is removed in R3 together with the columns.

### D12. Every store write re-reads the row

- **Why:** The AFTER UPDATE trigger can re-key the contact after the statement's `RETURNING` has already been produced.
- **Cost:** one extra indexed `SELECT` per write.

### D13. Contact id treated as PII

- **Rule:** It is never logged, never sent to telemetry and never put in a URL.
- **Warnings:** trigger warnings carry no values.
- **Scripts:** pre-flight and verify print ids and counts only.

### D14. Shared-contact re-key (corrected after review)

- **Case:** One person is both a coordinator and an org owner, and one role changes phone.
- **What happens:** The trigger tries to give that role a new contact of its own via `contact_link`. The review showed this **can only succeed when the email changes too**: after a phone-only change, the email is still held by the shared contact. So in practice the changing row is left unlinked with a WARNING, and the other role is never silently changed.
- **When it happens:** It is unreachable today, because `OWNER_ALREADY_REGISTERED` blocks it, and since the review fixes the profile PATCH pre-check rejects a phone held by an org owner. The proper model (one contact, two roles) is Phase 2.

### D15. ⚠ REVIEW — CI `db-integration` job is **advisory** at first

- **What it does:** A separate job with a `postgres:16` service. It migrates a fresh DB (the fresh-instance path), then runs `*.integration.test.ts`.
- **Why advisory:** It is a new moving part. `docs/ci-required-checks.md` says to promote it to required after a few green PRs.
- **What you need to do:** Promoting it is your branch-protection change; I cannot make it.

### D16. Nothing is pushed

- **Commits:** local commits on `refactor/user-org-management` only.
- **Not done:** no push, no PR, no release tag. Those are outward-facing and wait for you.

### D17. R2 contact writes live in a shared Postgres helper, not a `ContactStore` class

- **Where:** `apps/api/src/db/contact-writes.ts` (`linkContact`, `changeContact`, `gcContact`). Both Postgres stores call these **inside their own transaction**.
- **Why:**
  - The contact write and the FK write must be atomic.
  - The interface rules forbid leaking a Drizzle transaction handle through an abstract contract.
  - No caller outside the two stores writes contacts.
  - The in-memory stores keep computing `contactId` as before.

### D18. R2 writes are strict, where the R0 triggers were best-effort

- **Behaviour:** An app write that clashes with another person's email or phone raises the DB unique violation. The stores map it to `DUPLICATE_EMAIL` / `DUPLICATE_PHONE`, and the routes map those to today's codes (coordinator: `USER_EXISTS` / `PHONE_EXISTS`; org create: `OWNER_ALREADY_REGISTERED` / `PHONE_EXISTS`).
- **Why:** The pre-checks catch clashes first. The strict write closes the race between check and insert.

### D19. ⚠ REVIEW — Re-keying a shared contact is refused with `409 CONFLICT`

- **When:** The contact is shared by a coordinator and an org owner, and one role changes phone.
- **What happens:** `changeContact` throws `SharedContactError`. The aggregator store maps it to `DUPLICATE`, and profile PATCH maps that to `409 CONFLICT`.
- **Why:** Changing it would silently change the other role's phone while Keycloak does not follow.
- **When it applies:** It is unreachable today (see D14). Phase 2 (one contact, two roles) gives this a proper flow.

### D20. R2 clears the legacy copy on a contact change

- **Behaviour:** A contact change also sets the legacy `contact` jsonb (or `owner_email` / `owner_phone`) to NULL.
- **Why:** During the rollout, the legacy unique indexes still exist. A stale legacy copy would block someone else from reusing the old email or phone through an R1 pod.

### D21. ⚠ REVIEW — Phase 1 ends in R3 (code) + R4 (drop migration), not a single R3

- **The problem:** R2 still declares the legacy columns in the Drizzle schema, and it needs them to write NULL into them. The migration runs at the first new pod's boot while R2 pods are still serving. If it dropped the columns in the same release, every R2 `SELECT` would fail.
- **The split:**
  - **R3 (code only, safe beside R2 pods):** removes the legacy columns from the Drizzle schema and the read fallbacks. Lookups become a plain `contact_id = (subselect)`.
  - **R4 (the following release):** ships `0026_contact_drop_legacy.sql`. No code change is needed with it.
- **Rollback:** R3 can roll back to R2. R4 is irreversible, so take a DB snapshot first.
- **Gate before R3:** `contact-verify.sql` V1 must be 0, because R3 has no fallback for unlinked rows.

### D22. The plan and decisions docs stay until your review

- **Convention:** a plan dies in the commit that completes it.
- **Chosen:** Phase 1 is complete on the branch, but I **kept** `contact-table-phase-1.md` and this log, because they are your review material.
- **What to do:** delete both in the PR that merges Phase 1, or tell me to.

### D23. Local validation used a parallel stack; your `:3000` / `:4000` stack was not touched

- **Stack:** API on `:4100` and web on `:3100`, run from the worktree, against `aggregator_r1`, a `pg_dump` clone of your local `aggregator` DB taken the way an existing instance would be.
- **Runbook followed:** pre-flight → apply → verify → R1 boot → R2 → R3 → R4 boot.
- **Snapshot:** taken before R4, at `aggregator_r1_pre_r4.sql` in the session scratchpad.
- **Two local-environment gaps found, neither caused by the refactor:**
  - The copied `apps/api/.env` points SMTP at `:1025`, but the aggregator mailpit listens on `:1026`. I overrode it for my stack only.
  - `SIGNALSTACK_ACTING_ORG_ID` is unset, so the final Signals upsert on approval fails with `SIGNALSTACK_CONFIG_MISSING`. I did not set a value.

### D24. ⚠ REVIEW — `aggregators.contact_id` is UNIQUE (one coordinator row per person)

- **Found in self-review after R4.** The legacy `aggregators_contact_{email,phone}_unique` indexes were the DB guarantee against one person getting two coordinator rows. Once R2 stopped writing the legacy jsonb (and R4 dropped the indexes), nothing replaced them. A concurrent double-submit could pass the route's pre-check twice, and `linkContact` would return the same contact to both.
- **Fix:** `aggregators_contact_id_unique` is created in 0025. It is safe on existing data, because the legacy unique email/phone already implied it. A violation maps to `DUPLICATE_EMAIL`, which becomes the same `USER_EXISTS` the legacy index produced. Covered by a concurrent integration test.
- **Residual gap:** during the R0 → R1 window only, a release N−1 pod that hits this index (the same person racing themselves) sees an unrecognised constraint, so its error is `CONFLICT` instead of `USER_EXISTS`. This needs a double-submit race during a rollout to happen, and the row is still rejected correctly.
- `aggregator_orgs.contact_id` is **not** unique. An owner could already hold several org rows (e.g. a rejected one and a new one) before this change, and the reclaim logic handles that.
- **Test harness:** `INTEGRATION_MIGRATIONS_FOLDER` lets the contact integration suite run against the expand-phase schema (0000–0025). By default it runs against the final schema.

---

## Review round 1 (R0/R1) — findings and fixes

An independent review agent reproduced every SQL claim on scratch databases. All findings were fixed in the follow-up commit.

| Finding                                                                                                                                                                                               | Fix                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **B1.** A failed trigger re-key left the old contact orphaned, blocking that person's email/phone forever.                                                                                            | `contact_move` now calls `contact_gc(old)` in its failure branch. Covered by an integration test.                                                                                                                                                                                    |
| **B2.** Running the pre-deploy script as an admin/superuser DSN made the new objects owned by that role. The app then got `permission denied`, legacy writes failed and the boot re-run crash-looped. | 0025 now switches to the owner of `aggregators` via `SET LOCAL ROLE` when the caller may, and refuses any other role. Verified with a non-superuser owner role plus a superuser apply, and with a non-member role being refused.                                                     |
| **M1.** A re-run of 0025 could deadlock live legacy writes (lock-order inversion).                                                                                                                    | 0025 takes `LOCK TABLE aggregators, aggregator_orgs` first, which is the same order live writes use.                                                                                                                                                                                 |
| **M2.** The email/phone lookups (the OTP and duplicate-check paths) became sequential scans.                                                                                                          | Rewritten as `contact_id = (subselect) OR (unlinked AND legacy = v)`. An integration test asserts the index is used.                                                                                                                                                                 |
| **M3.** Trimmed names (and lowercased emails) changed the API output for some existing rows.                                                                                                          | Names are stored **verbatim**; only a blank name becomes NULL. Emails stay lowercased because they are identity. Pre-flight now reports rows whose output would change (`mixed_case_email`, `blank_coordinator_name`). A byte-identical `JSON.stringify` integration test was added. |
| Minor: a GC-vs-link race could fail a legacy insert.                                                                                                                                                  | `contact_link` takes `FOR KEY SHARE` and retries once. The TS `linkContact` does the same.                                                                                                                                                                                           |
| Minor: `EXCEPTION WHEN others` hid systemic errors.                                                                                                                                                   | Narrowed to unique/check/FK violations.                                                                                                                                                                                                                                              |
| Minor: the org-create phone pre-check counted half-created orgs.                                                                                                                                      | `findByOwnerPhone` ignores `inactive` orgs that have no Keycloak owner.                                                                                                                                                                                                              |
| Minor: profile PATCH had no cross-role phone check.                                                                                                                                                   | `PHONE_EXISTS` is now returned before any Keycloak write. For a clash with another coordinator this is the same code as before; for a clash with an org owner it is new (U3).                                                                                                        |
| Minor: `SET LOCAL … = DEFAULT` reset to the server default.                                                                                                                                           | 0025 saves the caller's values and restores them.                                                                                                                                                                                                                                    |
| Minor: pre-flight printed an MD5 prefix of the value.                                                                                                                                                 | Replaced with `dense_rank()`.                                                                                                                                                                                                                                                        |
| Minor: the backfill logged success when nothing was written, and one DB error aborted the run.                                                                                                        | Fixed. A failed row is counted as `failed`, and the run continues.                                                                                                                                                                                                                   |
| Minor: the script's dependencies were undocumented.                                                                                                                                                   | Documented: python3 is needed only for `.env`, and `PSQL_CMD` is word-split.                                                                                                                                                                                                         |

---

## Phase 2 (`app_user`) — decisions taken during implementation

Plan: `docs/plans/user-table-phase-2.md`. Migration: `0027_app_user.sql`.

| #                  | Decision                                                                                                                                                                                                                      | Why                                                                                                                                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P2-D1              | Table name `app_user`.                                                                                                                                                                                                        | `user` is reserved in Postgres.                                                                                                                                                                |
| P2-D2              | uuid PK.                                                                                                                                                                                                                      | The design doc: `primary_contact` is "the uuid of the user".                                                                                                                                   |
| P2-D3              | `UNIQUE (contact_id, user_type)`                                                                                                                                                                                              | One admin account and one coordinator account per person. This is the model for your U3 carve-out: a coordinator who is also an org contact becomes one contact with two accounts.             |
| P2-D4              | FKs named `aggregators.user_id` and `aggregator_orgs.owner_user_id`.                                                                                                                                                          | The Phase 1 naming rule is about FKs to `contact`. For `app_user`, the first FK is `user_id`; orgs take the role prefix `owner_` because a Phase 3 membership model adds more user references. |
| P2-D5              | `agg_for text[]` mirrors `aggregators.type` through a trigger, and nothing reads it yet.                                                                                                                                      | `aggregators.type` plus the KC `aggregator_type` claim stay authoritative for authorisation until the new APIs (Phase 4).                                                                      |
| P2-D7              | No token or Keycloak change in Phase 2.                                                                                                                                                                                       | Mixed fleets authenticate identically.                                                                                                                                                         |
| **P2-D8** ⚠ REVIEW | **No `status` on `app_user`.**                                                                                                                                                                                                | One admin account can own several org rows, so a mirrored status would be ambiguous. Role rows stay authoritative.                                                                             |
| **P2-D9** ⚠ REVIEW | **`app_user` is trigger-maintained permanently** (link / follow / GC), with no app-side write path.                                                                                                                           | It has no user-facing failure mode (uniqueness is already guaranteed by `aggregators_contact_id_unique`), so a second write path would only add risk.                                          |
| P2-D10             | `kc_sub` is recorded by `recordKcSubject()`: once when an approver opens the review link (`loadAggregatorAndUser`), and once per process on an approved request (`requireApproved`, in-memory cache, cleared at 10k entries). | Nothing needs a separate Keycloak crawl. Only rows that never reach approval or login stay NULL, and U5 reports them.                                                                          |
| P2-D11             | `app_user_gc()` also collects the contact.                                                                                                                                                                                    | The 0025 contact GC fires first on a delete and finds the contact still held by the account (this bug was caught by a trigger test).                                                           |
| P2-D12             | No pre-deploy script for 0027 (unlike 0025).                                                                                                                                                                                  | It is one row per coordinator/org and runs in milliseconds at boot. Idempotency and the advisory lock make a manual pre-run possible anyway.                                                   |

### Phase 2 R1 — the owner's Keycloak subject is read from the account

- `aggregator_orgs.owner_kc_sub` duplicates `app_user.kc_sub`: one value per person, copied onto every org row they own. From Phase 2 R1 the org store reads `app_user.kc_sub`, falling back to the row copy only while the account has not learned it yet. The owner-name backfill does the same.
- **Writes are unchanged in R1.** `owner_kc_sub` is still written, and the 0027 trigger copies it onto the account.
- **Next releases:** R2 writes the account directly and stops writing the column (code only). R3 (migration 0028) drops the column, rewires the 0027 triggers that watch it, and makes `user_id` / `owner_user_id` NOT NULL, gated on `app-user-verify.sql` U1 = 0. This is the same two-release contract as Phase 1 (D21).
- The Phase 3–5 plans number their migrations from 0028; they shift by one when Phase 2 R3 lands.

### Phase 2 R2/R3 — `owner_kc_sub` removed

- **R2 (code):** the store writes the owner's subject onto `app_user.kc_sub` (per person, shared by every org they own) and stops writing `owner_kc_sub`. The half-created-org filter of `findByOwnerPhone` now asks the account, not the row.
- **R3 (`0028_app_user_contract.sql`):**
  - It refuses to run while any row has no account (U1).
  - It copies a subject that exists only on a row (dynamically, so a re-run parses).
  - It replaces the 0027 org trigger bodies **before** dropping the column; a plpgsql body that references a dropped column fails only at run time.
  - It drops the column and sets `user_id` / `owner_user_id` NOT NULL, then RESET ROLE.
- `app-user-verify.sql` U6 (the row/account subject drift) is retired with the column.
- **Caveat:** a manual re-run of **0027** after 0028 would re-create the old trigger bodies that reference the dropped column. Drizzle never does this, but don't run it by hand after 0028.
- `aggregators.user_id` / `aggregator_orgs.owner_user_id` stay **optional in the Drizzle schema** although they are NOT NULL in the database. The BEFORE INSERT triggers fill them, and a Drizzle `.notNull()` would force every insert to supply a value the database computes.

---

## Review round 2 (R2–R4) — findings and fixes

A second independent review agent reproduced each finding on scratch databases. Everything below is fixed in the follow-up commit unless marked otherwise.

| Finding                                                                                                                                                                                                                                                | Fix                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B1.** `SET LOCAL ROLE <owner>` lasted for the rest of drizzle's migration transaction. When the login role was only a _member_ of the owner role, drizzle's own insert into `drizzle.__drizzle_migrations` failed, and the pod crash-looped at boot. | `RESET ROLE` at the end of 0025, 0026 and 0027.                                                                                                                                                                                                                                                                                                                  |
| **M1.** Adding `aggregators_contact_id_unique` by editing 0025 never reaches a DB that already ran an earlier 0025.                                                                                                                                    | 0026 also creates the index (idempotently), drops the leftover plain index, and refuses to run if one person already has two coordinator rows. **⚠ REVIEW (release process):** squash or rebase this branch before cutting releases, so each release (R0…R4) ships the _final_ text of its migrations. The intermediate commits carry earlier revisions of 0025. |
| **M2.** Through profile PATCH a coordinator could attach itself to an org owner's contact (the check trusted the _submitted_ email) and overwrite the owner's name.                                                                                    | The pre-check compares **stored contact ids**, never request fields. `changeContact` now **never** moves onto an existing contact (`ContactTakenError` → `DUPLICATE_EMAIL` → `USER_EXISTS`).                                                                                                                                                                     |
| **M3.** A half-created org (a Keycloak step failed) was parked `inactive` while still holding the owner's contact, so every retry with the same phone got `PHONE_EXISTS`.                                                                              | Such an org is now **deleted**, along with its Keycloak group when one was created. The contact GC trigger then frees the email and phone. This also removes the old 12-hour cooling block on such a retry.                                                                                                                                                      |
| **M4.** The shared-contact check could race with a concurrent insert, so a re-key could silently re-key the other role.                                                                                                                                | The contact row is locked `FOR UPDATE` before references are counted.                                                                                                                                                                                                                                                                                            |
| **M5.** A late `CONFLICT` left Keycloak ahead of the DB (the phone is written to Keycloak first). D19's wording was also backwards.                                                                                                                    | The shared-contact and duplicate checks now run **before** the Keycloak write. If the DB update still fails, the Keycloak phone is **restored** (best-effort, logged).                                                                                                                                                                                           |
| **M6.** CI never exercised the expand-phase schema.                                                                                                                                                                                                    | CI runs the contact suite a second time against a DB migrated only to 0025, using a generated migrations folder. That run covers the triggers, the idempotent re-run, 0026 over populated legacy data, and the 0026 gate. The store-level tests run only against the current schema, because they exercise the current store code.                               |
| Minor: `contact_pkey` could surface as `CONFLICT` / 503.                                                                                                                                                                                               | Mapped to `DUPLICATE_EMAIL` in both stores. `linkContact` re-inserts with `ON CONFLICT`.                                                                                                                                                                                                                                                                         |
| Minor: Drizzle declared `contact_id` nullable after 0026.                                                                                                                                                                                              | Now `.notNull()`.                                                                                                                                                                                                                                                                                                                                                |
| Minor: org-create backstop codes had no route test.                                                                                                                                                                                                    | Added.                                                                                                                                                                                                                                                                                                                                                           |
| Minor, **not fixed** (documented): `LOCK TABLE` in a migration can deadlock with a live org write.                                                                                                                                                     | The migration aborts and is retried at the next boot. No data risk.                                                                                                                                                                                                                                                                                              |
| Minor, **not fixed** (documented): a whitespace-only name.                                                                                                                                                                                             | `z.string().min(1)` accepts it. It is stored as NULL and returned as `''`, where previously it was echoed verbatim.                                                                                                                                                                                                                                              |
| Minor, **not fixed** (documented): the R3 gate "V1 = 0" is enforced only by the runbook, but 0026 enforces it before anything is dropped.                                                                                                              | —                                                                                                                                                                                                                                                                                                                                                                |
