# Plan: simplify the release-train tool and its execution

**Date:** 2026-10-07
**Branch:** `refactor/user-org-migrate-tool-wip`
**Status:** Implemented on this branch (2026-10-07); see §14 for what the implementation settled.
**Supersedes:** the first tool design (bash script + `migrate-tool` image + copy dry-run + rehearsal token), which was never committed.

---

## 1. Why the tool can shrink

The current tool (about 3,650 lines with tests) defends against situations that the operating model below rules out:

| The tool defends against…                                                                                   | …which no longer happens, because                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Instances part-way through the train, dev databases with abandoned migrations                               | One window per environment takes the database from 0022 to the end in one go; dev databases are recreated (S-5).                                                        |
| Rehearsing on live data while the app runs (same-server `pg_dump` copy, `CREATEDB`, copy naming guards)     | The rehearsal runs on a restored snapshot in staging; inside the window the app is down, so the real run can verify **inside its own transaction** and roll back (S-3). |
| An `apply` not preceded by a rehearsal (rehearsal token bound to server, database, release, files, network) | The run that commits is the run that verified: one transaction, gates inside it (S-3).                                                                                  |
| A rollback after users are back (`revert` PR, post-window id report, Keycloak `cleanup-after-restore`)      | Snapshot restore before scale-up; fix forward after (S-2).                                                                                                              |
| In-flight work crossing the window (pending registrations, unprocessed bulk rows, queued campaigns)         | The window starts only once those are drained, and the tool checks it (S-4).                                                                                            |
| Shell + `psql` + `pg_dump` in a separate image                                                              | Nothing left needs them: every step is SQL run through `pg` from node (S-3).                                                                                            |

## 2. Decisions (answered 2026-10-07)

| #   | Question                    | Answer                                                                                                                                                                                                                                                                                                                                                                    |
| --- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S-1 | Scope of the window         | **Phases 1–5** (0023–0029 + Phase 5's 0030) in one window per environment. Phase 6 gets its own later window, reusing the same `run` mechanism.                                                                                                                                                                                                                           |
| S-2 | Rollback                    | **Snapshot only.** Before scale-up: restore the snapshot, redeploy the previous tag. After scale-up: fix forward. The `revert` PR (old T-3), `report --since` ids and `cleanup-after-restore` are dropped.                                                                                                                                                                |
| S-3 | Execution                   | **One atomic run.** One transaction applies every pending migration and runs every verify gate; it commits only when all gates are 0. `--dry-run` is the same run, always rolled back. Pre-window rehearsal = the same command on a restored copy of the environment's snapshot. A node CLI shipped in the API image; no bash, `psql`, `pg_dump`, copy database or token. |
| S-4 | Drain checks                | **Strict; stale presigns informational.** Blockers: coordinators / orgs `pending`; bulk uploads `uploaded`, `file_validating`, `row_processing`, `finalising`; campaign jobs `queued`, `processing`; invites `pending`. Informational: bulk uploads still `pending` (presigned, never uploaded), with a fix that marks them `failed`.                                     |
| S-5 | Dev databases               | **0022 only.** The tool accepts exactly 0022 → latest (or latest → no-op). Dev databases are recreated or boot with `ALLOW_TRAIN_ON_BOOT=true`. Mid-train handling, per-phase pre-flight selection and `fix drop-app-user` go.                                                                                                                                            |
| S-6 | Keycloak identities         | **Required step in the window.** `enrich` runs after the commit and before scale-up; the window's last gate is `coordinators_without_identity = 0`, apart from coordinators that have no Keycloak user (listed, by id).                                                                                                                                                   |
| S-7 | Keycloak prerequisite check | **Kept**, in `check` (read-only).                                                                                                                                                                                                                                                                                                                                         |

## 3. The simplified tool: three commands

One entry, `apps/api/src/tools/train.ts`, compiled into the API image (`node dist/tools/train.js <command>`). It runs as a one-off Kubernetes Job / `kubectl run` from the **release's own API image** with the API's ConfigMap and Secret — so the release tag, the migration files and the network config are the deployed ones by construction (no tag check, no token). The operator SQL it reads (`train-check.sql`, the verify scripts) is copied into the API image next to `drizzle/`.

| Command                                 | When                                                                | What it does                                                                                                                                                                                                                                                                                                                                                                                                                             | Exit                                                |
| --------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `check`                                 | any time; read-only                                                 | Prints the facts (database, server, level, pending migrations, role can act as owner, other sessions, row counts, config: network / brand / admin email count). At **0022**: the drain checks (§5.1), the pre-flight (§5.2) and the Keycloak prerequisite (§5.4). At **the latest level**: the verify gates (§5.3) and the identity gate (§6). Any other level: refuses ("not 0022, not latest — this tool takes 0022 to the end only"). | 0 / 1                                               |
| `run [--dry-run] --snapshot-taken <id>` | in the window (pods at zero); `--dry-run` also on a staging restore | The atomic run (§4). `--snapshot-taken` is required unless `--dry-run`. Refuses while other sessions are connected.                                                                                                                                                                                                                                                                                                                      | 0 committed (or dry run passed) / 1 nothing applied |
| `enrich [--dry-run] [--rate n]`         | in the window, after `run`, before scale-up                         | Keycloak logins → `user_identities`, then owner names (§6). Idempotent, resumable.                                                                                                                                                                                                                                                                                                                                                       | 0 / 1                                               |

Kept fixes, as `check --fix <name>` (one transaction, `--dry-run` rolls back): `retire-registration --id` (F1, for an `inactive` duplicate), `choose-owner-subject --org-id` (F15), and new `expire-stale-presigns` (marks bulk uploads still `pending` as `failed`, §5.1). They become small SQL files run through `pg`, so they need no `psql` variables either.

## 4. The atomic run

One connection, one transaction, in this order — the first failing step rolls everything back and prints `nothing was applied: the database is unchanged`:

1. `pg_advisory_xact_lock(MIGRATION_LOCK_SQL_KEY)` — the same key as boot, so a pod that slipped through cannot migrate concurrently.
2. Session settings: `SET LOCAL lock_timeout = '10s'`, the 0029 backfill network / brand via `set_config(…, true)`.
3. **Level**: the applied high-water mark must be exactly 0022 (`PRE_TRAIN_WHEN`) with no foreign rows; at the latest level print `nothing pending` and stop (exit 0).
4. **Drain + pre-flight blockers** (§5.1, §5.2) — re-run inside the transaction, so nothing can have changed since `check`.
5. **Counts before** (`train-counts-before.sql`).
6. **Apply** each pending file with drizzle's own reader (`readMigrationFiles` from `drizzle-orm/migrator`: statements split on `--> statement-breakpoint`, `hash = sha256(file)`, `when`), then insert the same `drizzle.__drizzle_migrations (hash, created_at)` rows drizzle would — so the new API's boot finds nothing pending. (Checked against drizzle-orm's `pg-core/dialect.js` migrate: it does exactly this inside one transaction.)
7. **Verify gates** (§5.3) and **counts after** = counts before.
8. `--dry-run`, or any gate ≠ 0 → `ROLLBACK`, print the failing gate ids. Otherwise `COMMIT`.
9. If the `COMMIT` call itself errors, re-read the level on a new connection: `done` → "the train IS applied"; 0022 → "nothing was applied"; unreadable → "run `check` before scaling anything". (The one case a single transaction cannot rule out; about ten lines.)

Output: step names, timings, check ids and counts, SQLSTATE / constraint / table on error — never row data (unchanged rule).

What disappears with this: the copy database and its naming guard, `CREATEDB`, restoring as the table owner, the rehearsal token and its seven bound facts, `record --verified-copy`, the separate `verify` command after apply, the `updated_at` baseline (the gates + equal counts inside the same transaction cover it), exit code 3, and the "level moved but not complete" branch (one transaction cannot half-apply).

## 5. Checks

One SQL file, `scripts/sql/train-check.sql` (rows `check_id | category | n`, counts only), replaces `train-preflight.sql`; the per-phase `*-preflight.sql` files stop being part of the operator path (they stay for the phase integration tests, or go — §8).

### 5.1 Drain (new; S-4)

| Id                                | Blocks when                                                                               | Clear it by                                                                                |
| --------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| D1 `coordinators_pending`         | `aggregators.status = 'pending'` > 0                                                      | Approve or reject in the app before the window (the review links still work until T0).     |
| D2 `orgs_pending`                 | `aggregator_orgs.status = 'pending'` > 0                                                  | Same, from the admin console.                                                              |
| D3 `bulk_uploads_in_flight`       | `bulk_uploads.status IN ('uploaded','file_validating','row_processing','finalising')` > 0 | Let the worker finish (rows reach Signals), or let the watchdog fail stuck ones; re-check. |
| D4 `campaign_jobs_in_flight`      | `campaign_job.status IN ('queued','processing')` > 0                                      | Let them finish, or let the watchdog's stall sweep fail them.                              |
| D5 `invites_pending`              | `registration_invites.status = 'pending'` > 0                                             | Revoke them (owners re-invite after the window), or let them be consumed.                  |
| D6 `bulk_presigns_never_uploaded` | info                                                                                      | `check --fix expire-stale-presigns` marks them `failed` (the uploader never sent a file).  |

Why the order matters: D1–D5 are checked by `check` at T−1 and the start of the window **with the app still up** (so they can still be cleared), and again inside `run` after scale-down (§4 step 4), so a last-minute registration cannot slip in.

Also covered by the drain: the queue payloads in Redis. With D3 / D4 at 0 and the worker scaled down, no BullMQ job refers to a row the train renames; the queues are not inspected.

### 5.2 Pre-flight (trimmed)

Kept as **blockers** (each is something the migrations refuse or would get wrong): F1 (email / phone pairs), F2 (non-canonical phone, blank email), F4 `rename_target_taken`, F8 (missing parent org), F10 `backfill_network_unknown`, F10b (consent not `true` / bad timestamps), F10c (unmovable contact keys), F10d (unknown ledger subject type), F15 / F15b (owner Keycloak subjects), F16 (unknown dependent objects), F22 (`aggregator_profile` with data), and T0b (role can act as owner) / T0c (train names free).

Kept as **info**: F3, F4 renames, F5, F6, F7, F11, F12, F13, F14, F18, F21 → now D5.

Dropped: T0a (the level check in §4 step 3 is the same thing), F9 (pending registrations are now blocker D1 / D2).

### 5.3 Verify gates (unchanged content)

`users-verify.sql`, `organisation-verify.sql`, `cleanup-verify.sql` and Phase 5's verify, run **inside** the `run` transaction (§4 step 7) and again by `check` at the latest level. Informational rows (`V6`, `V7`, `V8`, `V4`, …) keep their regex-free marking: each verify file gets a `category` column like `train-check.sql`, so no caller needs to know which ids are informational.

### 5.4 Keycloak prerequisite (kept; S-7)

`F19`: a client-credentials token for `aggregator-api` carries `realm-management` `manage-realm` + `manage-users`, and `GET /admin/realms/{realm}/roles/org_owner` is 200. In `check` at 0022; skipped with a warning when `KEYCLOAK_*` is unset.

## 6. Identities in the window (S-6)

`enrich` (unchanged logic, already unit-tested with the IdP fake) runs after the commit and before scale-up. **Its exit code is the gate**: 0 only when every coordinator without an identity was either linked or confirmed absent from Keycloak; any lookup failure or conflict → 1 (re-run; it resumes). It prints the ids of coordinators absent from Keycloak (they cannot log in today either). `check` at the latest level reports `I1 coordinators_without_identity` as info, for the change record.

`enrich` uses the full API environment (Keycloak), which the Job already has (§3).

## 7. Execution, per environment

| When                          | Who                   | Step                                                                                                                                                                                                                                                        | Done when                                      |
| ----------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| T−7                           | ops                   | Restore the environment's latest snapshot into a **staging** database; point a Job with the new API image at it.                                                                                                                                            | restored                                       |
|                               | operator              | `check` → fix blockers **on the real environment** with the documented fixes / in the app; `run --dry-run` on staging, then `run --snapshot-taken staging` and `enrich --dry-run`; start the new images on staging and smoke-test. Note the `run` duration. | `run` passes on staging; smoke green           |
| T−1                           | operator              | `check` against the real environment (app up): drain D1–D5 still clearing, pre-flight 0. Announce the window.                                                                                                                                               | blockers only D1–D5, with a plan to clear them |
| T0 − 2h                       | coordinators / admins | Stop new registrations and uploads (announcement); approve / reject pending; let uploads and campaigns finish.                                                                                                                                              | `check`: D1–D5 = 0                             |
| **T0**                        | ops                   | Scale **API and worker to 0**; web shows maintenance.                                                                                                                                                                                                       | `check`: `other_sessions=0`                    |
|                               | ops                   | Snapshot; note its id.                                                                                                                                                                                                                                      | available                                      |
|                               | operator              | `run --snapshot-taken <id>`                                                                                                                                                                                                                                 | `COMMITTED`                                    |
|                               | operator              | `enrich`                                                                                                                                                                                                                                                    | exit 0                                         |
|                               | ops                   | Deploy the new API, worker and web images (boot: nothing pending).                                                                                                                                                                                          | ready                                          |
|                               | operator              | `check` (latest level: verify gates, I1); smoke checks (OTP login, dashboard, profile, approval, link submit, bulk upload, org selector).                                                                                                                   | all green                                      |
|                               | ops                   | Scale up; end the window.                                                                                                                                                                                                                                   |                                                |
| Rollback, **before scale-up** | ops                   | Restore the snapshot, redeploy the previous tag.                                                                                                                                                                                                            |                                                |
| After scale-up                | team                  | Fix forward.                                                                                                                                                                                                                                                |                                                |

If `run` fails it prints `nothing was applied`: scale the old images back up; the window ends without change.

**Downtime** ≈ snapshot + the staging `run` duration + `enrich` (paced, ~5 coordinators / s by default; minutes at our volumes) + pod start.

## 8. What changes in the code

| Today                                                                                                | After                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scripts/user-org-migrate.sh` (298 lines, bash)                                                      | **deleted**                                                                                                                                                        |
| `infra/migrate-tool/Dockerfile` + the `migrate-tool` matrix entries in `build-images.yml` / `ci.yml` | **deleted**; the API `Dockerfile` copies `scripts/sql/{train-check,train-counts-*,*-verify}.sql` + `fixes/` into the image                                         |
| `train-cli.ts` (501)                                                                                 | `train.ts`: `check`, `run`, `enrich`, `--fix` — target ~250 lines                                                                                                  |
| `train-logic.ts` (176): levels, rehearsal token, post-T0 parser                                      | level check only (0022 / latest / other) — ~40 lines; token + parser deleted                                                                                       |
| `train-db.ts` (237): facts, owner, sessions, splitter, preflight runner, `updated_at` baseline       | facts, owner, sessions, splitter, check runner — baseline deleted (~150)                                                                                           |
| `train-online.ts` (292): `enrich`, `cleanup-after-restore`                                           | `enrich` only (~150)                                                                                                                                               |
| `migrate-core.ts` (184)                                                                              | kept; gains `applyPending(client, folder)` (drizzle's reader + bookkeeping in the caller's transaction), shared with nothing else — boot keeps drizzle's `migrate` |
| `train-preflight.sql`, `train-report.sql`, `fixes/drop-app-user.sql`                                 | `train-check.sql` (drain + trimmed pre-flight); report and drop-app-user deleted                                                                                   |
| `train-counts-before/after.sql`, `fixes/retire-registration.sql`, `fixes/choose-owner-subject.sql`   | kept (fixes rewritten without psql variables); + `fixes/expire-stale-presigns.sql`                                                                                 |
| Verify SQL (`users`, `organisation`, `cleanup`)                                                      | + a `category` column; otherwise unchanged                                                                                                                         |
| Per-phase `*-preflight.sql`                                                                          | no longer on the operator path; delete with the phase docs (memory: plans die in the PR that completes them) unless a phase integration test still reads them      |
| Runbook (161 lines)                                                                                  | rewritten around §7 (~80 lines)                                                                                                                                    |
| `migration-guards.ts` message                                                                        | points at `node dist/tools/train.js` and the new runbook                                                                                                           |

Estimated result: about **1,000–1,200 lines including tests**, down from ~3,650; one artefact (the API image) instead of two; no shell.

## 9. Tests

| Suite                                                                              | Cases                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `train-check.integration.test.ts` (replaces `train-preflight.integration.test.ts`) | every blocker and info row seeded in a rolled-back transaction, D1–D6 included; categories asserted; clean 0022 has no blocker.                                                                                                                                                                                                                                                                                                           |
| `train.integration.test.ts` (rewritten, smaller)                                   | seeded 0022 → `run --dry-run` leaves 0022 and reports gates; `run` commits, journal rows equal what drizzle writes (a fresh boot `migrate` is a no-op afterwards), counts equal, ids / orgs / serves / consent / invites kept; re-`run` no-op; refusals: other level, foreign row, drain blocker, pre-flight blocker, other sessions, no snapshot id; a failure injected in the last migration and a failing verify gate both leave 0022. |
| unit                                                                               | level check, splitter, `enrich` / fixes with fakes, `applyPending` against a fake client (statement order, bookkeeping rows).                                                                                                                                                                                                                                                                                                             |

## 10. App simplifications this enables (follow-ups, not in the tool PR)

Because nothing is pending and web / API / worker ship together:

- `routes/aggregator-approvals.ts:688` — accepting an org-less approval link "minted before 0028" for a Default coordinator: no such link survives D1. Remove the branch and its tests.
- `routes/aggregator-registrations.ts:363,412` — "accepted for one release" handling of a registration body without `org_id` (old web): the old web is gone in the same window. Make `org_id` (or an invite) required.
- Other "for one release" / N−1 compatibility code across Phases 2–5: list them in the Phase 5 PR and delete what the single window makes dead. (`routes/registration-links.ts:714` is a client-API compatibility note for external callers — keep.)

## 11. Phase 5 and Phase 6

- **Phase 5** appends `0030_user_org_api.sql` and its verify file; `run` picks them up unchanged (it applies everything pending after 0022). Its verify gets a `category` column; `run` and `check` list verify files from one array in `train.ts`.
- **Phase 6** (later window): `run` already supports "from the release before → latest"; the level check becomes "the release's documented start level". The PII backfill needs app keys, so Phase 6 adds a step hook (`run` → after migrations, before gates, call a TS backfill in the same transaction). Designed then, not now.

## 12. Risks

| Risk                                                      | Mitigation                                                                                                                                                                          |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One long transaction holds locks on every table           | The app is down; `lock_timeout` 10 s fails fast if something unexpected holds a lock. At our volumes the train ran in < 1 s locally.                                                |
| Staging restore not available in some environment         | Fall back to a `pg_dump` into a scratch database on the same server, then `run --dry-run` against it (documented, manual; the tool does not automate it).                           |
| Our runner diverges from drizzle's bookkeeping            | Integration test: after `run`, drizzle's own `migrate` on the same folder must do nothing; the runner reuses `readMigrationFiles`, so hashes and statement splitting are drizzle's. |
| A registration arrives between T−1 `check` and scale-down | `run` re-checks D1–D5 inside its transaction.                                                                                                                                       |
| `enrich` fails mid-window (Keycloak down)                 | Exit 1, resumable; the window waits for it (the gate is before scale-up).                                                                                                           |

## 13. Plan of work

1. Approve this plan (open questions: none left from S-1…S-7).
2. Rewrite on the existing branch `refactor/user-org-migrate-tool-wip` (the current implementation is uncommitted): delete per §8, add `train.ts` + `applyPending` + `train-check.sql` + fixes, update the API Dockerfile.
3. Tests per §9; gates; one review agent pass.
4. Local end to end: a seeded 0022 database and a 0022-shaped copy → `check` → `run --dry-run` → `run` → `enrich` against the local Keycloak (needs the API env — run by you via `!`, or I start the API's env-loading path) → boot the Phase 4 API on it → browser smoke.
5. Rewrite the runbook (§7) and this branch's design doc; then ask before committing.

## 14. Implementation notes

- **Entry:** `apps/api/src/tools/train.ts` (`check`, `check --fix`, `run`, `enrich`), with `train-logic.ts` (level), `train-db.ts` (facts, sessions, statement splitter, check runner) and `train-online.ts` (`enrich`). `db/migrate-core.ts` gained `applyPending` (drizzle's `readMigrationFiles` + the same bookkeeping rows); boot still uses drizzle's `migrate`.
- **SQL:** `train-check.sql` (drain D1–D6 + trimmed pre-flight), the verify files now carry a `category` column, fixes run through `pg` (parameters via `set_config('train_fix.*', $1, true)`, no psql variables), new `fixes/expire-stale-presigns.sql`. The per-phase `users` / `organisation` / `cleanup` pre-flight files and `train-report.sql`, `fixes/drop-app-user.sql` were deleted.
- **Image:** the API `Dockerfile` copies `scripts/sql` to `/app/sql`. Proven on the hardened image (no shell): `check` → `run --dry-run` → `run` → `check` → re-`run` no-op against a 0022 database.
- **Run output** lists each migration applied with its duration, the gates, `every count equal`, then `COMMITTED` / `DRY RUN PASSED` / `RUN FAILED … nothing was applied`.
- **Sessions:** the guard ignores sessions named `train%` (the tool's own pool).
- **Tests:** `train.integration.test.ts` (12: check, dry-run, commit with drizzle-identical rows, data kept, done-level check, no-op re-run, refusals, fixes, sessions, migration failure, gate failure), `train-check.integration.test.ts` (37: every check seeded, categories), unit tests for the level, the splitter, `isFailing` and `enrich`.
- **Not run locally:** `enrich` and F19 against Keycloak (they need the API's secrets).

## 15. Corner-case review (2026-10-07), folded in

- **Sessions:** a session of another role whose `backend_type` reads NULL (no `pg_read_all_stats`) now counts; background processes do not. The run re-checks sessions just before `COMMIT` and rolls back if anything connected meanwhile; other `train` sessions are reported.
- **Interrupted runs:** the pool uses TCP keepalive and a 10 s connect timeout; `check` prints `MIGRATION IN PROGRESS` while the lock is held; the runbook runs each step as a Job and keeps its log.
- **Poolers / settings:** network, brand and `TimeZone = UTC` are set inside the run's transaction and asserted; the runbook requires a direct Postgres URL.
- **Prerequisites:** T0d (PostgreSQL ≥ 14), T0e (TEMP privilege), F12b (database size → disk / WAL headroom), F16b (dependents in other schemas), F23 (publications, slots, subscriptions, pg_cron), F10b now a real `::timestamptz` cast (`'yesterday'` is valid; `2025-13-40` is not), D5 counts only invites still usable.
- **Preservation:** `train-counts-*.sql` carry fingerprints of every pre-existing row's `updated_at` / `rejected_at` (coordinators, orgs, uploads, links, campaign jobs); a migration touching one fails the run.
- **Levels:** `partial` — a shipped level after 0022 (a rehearsal copy migrated by an earlier release) — runs the pending migrations with the verify gates only (the 0022 drain / pre-flight / counts do not apply). `enrich` refuses before the train is applied.
- **Fixes** take the lock with a 10 s timeout and re-read the level inside it. `enrich` lists login conflicts by id; the runbook has a decision rule.
- **Runbook:** read-only smoke before go / no-go (writes reach Keycloak, Signals, S3, queues); new ConfigMap / Secret before T0; pause GitOps and CronJobs; `ANALYZE` after commit.
- **Phase 5 (0030) checklist:** add its verify file to `VERIFY_FILES` (a test compares the list with `scripts/sql/*-verify.sql`); move `TRAIN_LAST_WHEN` in `migration-guards.ts` if 0030 belongs to the train; make `organisation-verify.sql` V4 (`tenant_org_mismatch`) informational once coordinators can move orgs; keep `train-counts-after.sql` valid on the 0030 schema.
- **New tests:** COMMIT failure (deferred constraint trigger → `COMMIT failed — nothing was applied`), lock held elsewhere (`MIGRATION IN PROGRESS`, `55P03`), a migration touching `updated_at`, a count mismatch, a part-way level, `enrich` before the train, `enrichExitCode`, the `VERIFY_FILES` list, and the new checks.
- **Not covered:** the session guard under a role without `pg_read_all_stats` (needs a second role), the in-image `/app/sql` path in CI (proven by hand), `enrich` / F19 against Keycloak.
