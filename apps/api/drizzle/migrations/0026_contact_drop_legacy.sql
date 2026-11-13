-- Migration 0026 — drop the legacy contact columns.
--
-- Contract step of the user & org management refactor, Phase 1. The release
-- that ships this never reads or writes `aggregators.contact` /
-- `contact_phone` / `contact_email` or `aggregator_orgs.owner_email` /
-- `owner_phone`; every person lives in `contact`, referenced by `contact_id`
-- (migration 0025).
--
-- DEPLOY CONSTRAINTS — read before rolling this out.
--   * Ships in the SAME release as 0025 and runs in the same drizzle
--     transaction at that release's first boot, right after 0025 (a no-op
--     re-run when ops pre-applied it with `scripts/contact-migrate.sh apply`).
--   * STOP-THE-WORLD: the old release reads and writes the dropped columns, so
--     no old API or worker pod may be running when the new release boots. See
--     docs/contact-migration-runbook.md.
--   * Drops 0025's sync triggers, which only existed to keep `contact` in step
--     if the old release was started again after `apply` (rollback window).
--   * Every row must be linked (scripts/sql/contact-verify.sql V1 = 0). This
--     migration refuses to run otherwise, rather than failing on SET NOT NULL
--     with a cryptic error; the whole boot transaction then rolls back.
--   * NOT REVERSIBLE. Take a database snapshot first.
--
-- Idempotent (DROP … IF EXISTS, SET NOT NULL), so a re-run is a no-op. No
-- CASCADE anywhere: an unexpected dependent fails loudly instead of being
-- dropped silently.
--
-- Kept on purpose: `contact_id_of()` (used by the contact CHECK), `contact_gc()`
-- and the AFTER DELETE triggers (the permanent orphan-GC path), and the
-- `ON UPDATE CASCADE` FKs (they let a later phase re-key every contact id —
-- e.g. to a keyed HMAC — in one statement).

SELECT set_config('aggregator_dpg.prev_lock_timeout', current_setting('lock_timeout'), true),
       set_config('aggregator_dpg.prev_statement_timeout', current_setting('statement_timeout'), true);
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '300s';
SELECT pg_advisory_xact_lock(hashtext('aggregator-dpg:0026_contact_drop_legacy'));

-- Run as the table owner (same rule as 0025).
DO $$
DECLARE
  v_owner text;
BEGIN
  SELECT pg_get_userbyid(c.relowner) INTO v_owner
    FROM pg_class c WHERE c.oid = 'public.aggregators'::regclass;
  IF v_owner IS DISTINCT FROM current_user THEN
    IF pg_has_role(current_user, v_owner, 'MEMBER') THEN
      EXECUTE format('SET LOCAL ROLE %I', v_owner);
    ELSE
      RAISE EXCEPTION '0026: run as the owner of "aggregators" (%), not as %', v_owner, current_user;
    END IF;
  END IF;
END $$;

LOCK TABLE aggregators, aggregator_orgs IN ACCESS EXCLUSIVE MODE;

-- ─── Gate: every row must be linked ─────────────────────────────────────────
DO $$
DECLARE
  n_agg int;
  n_org int;
BEGIN
  SELECT count(*) INTO n_agg FROM aggregators WHERE contact_id IS NULL;
  SELECT count(*) INTO n_org FROM aggregator_orgs WHERE contact_id IS NULL;
  IF n_agg + n_org > 0 THEN
    RAISE EXCEPTION '0026: % coordinator(s) and % org(s) have no contact_id — resolve scripts/sql/contact-verify.sql V1 before this release',
      n_agg, n_org;
  END IF;
  SELECT count(*) INTO n_agg
    FROM (SELECT contact_id FROM aggregators GROUP BY contact_id HAVING count(*) > 1) d;
  IF n_agg > 0 THEN
    RAISE EXCEPTION '0026: % person(s) have more than one coordinator row — merge them before this release', n_agg;
  END IF;
END $$;

-- ─── Legacy sync triggers + their functions ─────────────────────────────────
DROP TRIGGER IF EXISTS aggregators_contact_bi ON aggregators;
DROP TRIGGER IF EXISTS aggregators_contact_bu ON aggregators;
DROP TRIGGER IF EXISTS aggregators_contact_au ON aggregators;
DROP TRIGGER IF EXISTS aggregator_orgs_contact_bi ON aggregator_orgs;
DROP TRIGGER IF EXISTS aggregator_orgs_contact_au ON aggregator_orgs;
DROP FUNCTION IF EXISTS aggregators_contact_bi();
DROP FUNCTION IF EXISTS aggregators_contact_bu();
DROP FUNCTION IF EXISTS aggregators_contact_au();
DROP FUNCTION IF EXISTS aggregator_orgs_contact_bi();
DROP FUNCTION IF EXISTS aggregator_orgs_contact_au();
DROP FUNCTION IF EXISTS contact_move(text, uuid, text, text, text, text);
DROP FUNCTION IF EXISTS contact_link(text, text, text);

-- ─── Legacy constraints, indexes, columns ───────────────────────────────────
ALTER TABLE aggregators DROP CONSTRAINT IF EXISTS aggregators_contact_shape_chk;
DROP INDEX IF EXISTS aggregators_contact_phone_unique;
DROP INDEX IF EXISTS aggregators_contact_email_unique;
DROP INDEX IF EXISTS aggregator_orgs_owner_email_idx;
-- Generated columns first: they depend on `contact`.
ALTER TABLE aggregators DROP COLUMN IF EXISTS contact_phone;
ALTER TABLE aggregators DROP COLUMN IF EXISTS contact_email;
ALTER TABLE aggregators DROP COLUMN IF EXISTS contact;
ALTER TABLE aggregator_orgs DROP COLUMN IF EXISTS owner_email;
ALTER TABLE aggregator_orgs DROP COLUMN IF EXISTS owner_phone;

-- ─── One coordinator row per person ─────────────────────────────────────────
-- 0025 already creates this, so both statements are no-ops on every database
-- that ran it; they are kept as a guard because, with the legacy per-column
-- unique indexes gone, this index is the only thing left stopping one person
-- from getting two coordinator rows.
DROP INDEX IF EXISTS aggregators_contact_id_idx;
CREATE UNIQUE INDEX IF NOT EXISTS aggregators_contact_id_unique ON aggregators (contact_id);

-- ─── Every row belongs to a person ──────────────────────────────────────────
ALTER TABLE aggregators     ALTER COLUMN contact_id SET NOT NULL;
ALTER TABLE aggregator_orgs ALTER COLUMN contact_id SET NOT NULL;

-- Leave the transaction as the role that started it: drizzle records the
-- migration in drizzle.__drizzle_migrations right after this file, and the
-- table owner may have no rights there.
RESET ROLE;
SELECT set_config('lock_timeout', current_setting('aggregator_dpg.prev_lock_timeout'), true),
       set_config('statement_timeout', current_setting('aggregator_dpg.prev_statement_timeout'), true);
