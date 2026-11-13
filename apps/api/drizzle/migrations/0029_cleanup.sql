-- Migration 0029 — one home for each remaining fact (user & org refactor,
-- Phase 4; design: docs/plans/cleanup-phase-4-implementation.md).
-- * Consent lives only in the ledger: `aggregator_consent_record` becomes
--   `consent_record` with typed `user_id` / `org_id` links, `valid_till` and
--   an append-only trigger; `users.consent` is dropped. A coordinator whose
--   consent existed only in the column gets a `registration-backfill` row.
-- * `users.type` → `users.serves text[]` (network domain ids; `'both'` and
--   NULL become `'{}'` = every domain); `actor_type` and its enum are dropped
--   (the API derives `'aggregator'`).
-- * `contact_extra.alternatePhone` → `users.alternate_phone`; `contact_extra`
--   is dropped.
-- * `users.invite_email` → `users.invite_id` (the consumed invite); with no
--   match the address is kept in `profile.legacy_invite_email`.
-- * Names: enum `aggregator_status` → `registration_status`;
--   `onboarding.org_slug` → `signalstack_org_slug`;
--   `campaign_pii_audit.actor_org_id` → `actor_signalstack_org_id`.
-- * The org's copied `state` / `profile` keys stay until Phase 5 (D4-6).
-- DEPLOY: last step of the user & org release train, applied with pods at
-- zero by the migration tool. runMigrations() refuses it at boot on a
-- database that holds data (src/db/migration-guards.ts).
-- The consent backfill needs the network (and brand) of the instance. It is
-- taken from the newest existing ledger row; with no ledger row at all, set
-- it for the migrating session:
--   PGOPTIONS='-c aggregator_dpg.network=<network> -c aggregator_dpg.brand=<brand>'
-- `updated_at` is never bumped: `users_set_updated_at` is disabled around the
-- data steps. Idempotent: "first run" is captured before the ledger rename,
-- and every data step is gated on a column it later drops. Counts only in
-- messages — never PII.

SELECT set_config('aggregator_dpg.prev_lock_timeout', current_setting('lock_timeout'), true),
       set_config('aggregator_dpg.prev_statement_timeout', current_setting('statement_timeout'), true);
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '300s';
SELECT pg_advisory_xact_lock(hashtext('aggregator-dpg:0029_cleanup'));

-- Run as the table owner (same rule as 0025–0028).
DO $$
DECLARE
  v_owner text;
BEGIN
  SELECT pg_get_userbyid(c.relowner) INTO v_owner
    FROM pg_class c
   WHERE c.oid = to_regclass('public.users');
  IF v_owner IS DISTINCT FROM current_user THEN
    IF pg_has_role(current_user, v_owner, 'MEMBER') THEN
      EXECUTE format('SET LOCAL ROLE %I', v_owner);
    ELSE
      RAISE EXCEPTION '0029: run as the owner of "users" (%), not as %', v_owner, current_user;
    END IF;
  END IF;
END $$;

-- First run = the ledger still has its old name. Captured before S3 renames it.
SELECT set_config('aggregator_dpg.p4_first_run',
                  (to_regclass('public.consent_record') IS NULL)::text, true);

-- A renamed ledger next to a surviving `users.consent` is a half-migrated
-- database this migration cannot reason about: refuse rather than drop the
-- column without a backfill.
DO $$
BEGIN
  IF to_regclass('public.consent_record') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'consent') THEN
    RAISE EXCEPTION '0029: consent_record exists but users.consent was not dropped — inconsistent database, restore it before migrating';
  END IF;
END $$;

-- ─── Helpers (session-local: CREATE OR REPLACE, so a later file may redefine them)
CREATE OR REPLACE FUNCTION pg_temp.ren_constraint(p_table text, p_old text, p_new text)
  RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conrelid = to_regclass('public.' || p_table) AND conname = p_old) THEN
    EXECUTE format('ALTER TABLE %I RENAME CONSTRAINT %I TO %I', p_table, p_old, p_new);
  END IF;
END $fn$;

CREATE OR REPLACE FUNCTION pg_temp.ren_index(p_old text, p_new text)
  RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  IF to_regclass('public.' || p_old) IS NOT NULL AND to_regclass('public.' || p_new) IS NULL THEN
    EXECUTE format('ALTER INDEX %I RENAME TO %I', p_old, p_new);
  END IF;
END $fn$;

CREATE OR REPLACE FUNCTION pg_temp.ren_column(p_table text, p_old text, p_new text)
  RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = p_table AND column_name = p_old) THEN
    EXECUTE format('ALTER TABLE %I RENAME COLUMN %I TO %I', p_table, p_old, p_new);
  END IF;
END $fn$;

CREATE OR REPLACE FUNCTION pg_temp.has_column(p_table text, p_column text)
  RETURNS boolean LANGUAGE sql STABLE AS $fn$
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = p_table AND column_name = p_column);
$fn$;

-- A timestamp, or NULL when the text does not parse (legacy jsonb strings).
CREATE OR REPLACE FUNCTION pg_temp.ts(p text)
  RETURNS timestamptz LANGUAGE plpgsql STABLE AS $fn$
BEGIN
  RETURN p::timestamptz;
EXCEPTION WHEN others THEN
  RETURN NULL;
END $fn$;

-- ─── S1 lock (pods are at zero; this only guards against a stray one) ──────
DO $$
BEGIN
  EXECUTE format(
    'LOCK TABLE users, organisations, %s, registration_invites, onboarding, campaign_pii_audit '
    'IN ACCESS EXCLUSIVE MODE',
    coalesce(to_regclass('public.consent_record'), to_regclass('public.aggregator_consent_record')));
END $$;

-- ─── S2 consent: blockers, then the backfill (first run only) ──────────────
DO $$
DECLARE
  n_not_true int;
  n_bad_ts int;
  n_extra int;
  n_subject int;
  n_missing int;
  v_network text;
  v_brand text;
  v_terms int;
  v_privacy int;
BEGIN
  IF current_setting('aggregator_dpg.p4_first_run') <> 'true' OR NOT pg_temp.has_column('users', 'consent') THEN
    RETURN;
  END IF;

  SELECT count(*) FILTER (WHERE consent->>'value' IS DISTINCT FROM 'true'),
         count(*) FILTER (WHERE pg_temp.ts(consent->>'given_at') IS NULL
                             OR (consent->>'valid_till' IS NOT NULL AND pg_temp.ts(consent->>'valid_till') IS NULL))
    INTO n_not_true, n_bad_ts
    FROM users
   WHERE user_type = 'coordinator' AND consent IS NOT NULL;
  -- `contact_extra` must hold nothing but a string (or null) alternatePhone:
  -- anything else would be dropped with the column.
  SELECT count(*) INTO n_extra
    FROM users
   WHERE contact_extra IS NOT NULL
     AND (contact_extra - 'alternatePhone' <> '{}'::jsonb
          OR coalesce(jsonb_typeof(contact_extra->'alternatePhone'), 'null') NOT IN ('string', 'null'));
  -- Only the two subject types 0029 knows how to map.
  SELECT count(*) INTO n_subject
    FROM aggregator_consent_record WHERE subject_type NOT IN ('aggregator', 'org');
  IF n_not_true + n_bad_ts + n_extra + n_subject > 0 THEN
    RAISE EXCEPTION '0029 pre-flight failed: consent_not_true=% consent_bad_timestamp=% contact_extra_unmovable=% ledger_unknown_subject_type=% — see scripts/sql/cleanup-preflight.sql',
      n_not_true, n_bad_ts, n_extra, n_subject;
  END IF;

  SELECT count(*) INTO n_missing
    FROM users u
   WHERE u.user_type = 'coordinator' AND u.consent IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM aggregator_consent_record c
                      WHERE c.subject_type = 'aggregator' AND c.subject_id = u.id
                        AND c.source IN ('registration', 'registration-backfill'));
  IF n_missing = 0 THEN
    RETURN;
  END IF;

  -- One network per instance: the newest ledger row names it.
  SELECT network, brand INTO v_network, v_brand
    FROM aggregator_consent_record ORDER BY created_at DESC LIMIT 1;
  IF v_network IS NULL THEN
    v_network := nullif(btrim(current_setting('aggregator_dpg.network', true)), '');
  END IF;
  v_brand := coalesce(v_brand, nullif(btrim(current_setting('aggregator_dpg.brand', true)), ''));
  IF v_network IS NULL THEN
    RAISE EXCEPTION '0029: % coordinator(s) need a consent backfill but the network is unknown — run with PGOPTIONS=''-c aggregator_dpg.network=<network> -c aggregator_dpg.brand=<brand>''',
      n_missing;
  END IF;
  -- The earliest coordinator terms on record, else version 1: never claim
  -- consent to terms newer than the person could have seen.
  SELECT terms_version, privacy_version INTO v_terms, v_privacy
    FROM aggregator_consent_record
   WHERE subject_type = 'aggregator' AND source = 'registration'
   ORDER BY accepted_at ASC LIMIT 1;

  INSERT INTO aggregator_consent_record
    (subject_type, subject_id, terms_version, privacy_version, network, brand, source, accepted_at)
  SELECT 'aggregator', u.id, coalesce(v_terms, 1), coalesce(v_privacy, 1), v_network, v_brand,
         'registration-backfill', pg_temp.ts(u.consent->>'given_at')
    FROM users u
   WHERE u.user_type = 'coordinator' AND u.consent IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM aggregator_consent_record c
                      WHERE c.subject_type = 'aggregator' AND c.subject_id = u.id
                        AND c.source IN ('registration', 'registration-backfill'));
  RAISE NOTICE '0029: consent backfilled for % coordinator(s)', n_missing;
END $$;

-- ─── S3 the ledger: rename, typed links, valid_till ────────────────────────
DO $$
BEGIN
  IF to_regclass('public.aggregator_consent_record') IS NOT NULL
     AND to_regclass('public.consent_record') IS NULL THEN
    ALTER TABLE aggregator_consent_record RENAME TO consent_record;
  END IF;
END $$;
SELECT pg_temp.ren_constraint('consent_record', 'aggregator_consent_record_pkey', 'consent_record_pkey');
SELECT pg_temp.ren_index('aggregator_consent_record_subject_idx', 'consent_record_subject_idx');

ALTER TABLE consent_record
  ADD COLUMN IF NOT EXISTS user_id uuid,
  ADD COLUMN IF NOT EXISTS org_id uuid,
  ADD COLUMN IF NOT EXISTS valid_till timestamptz;

DO $$
DECLARE
  n_user int;
  n_org int;
  n_unlinked int;
BEGIN
  IF current_setting('aggregator_dpg.p4_first_run') <> 'true' THEN
    RETURN;
  END IF;
  UPDATE consent_record SET subject_type = 'user' WHERE subject_type = 'aggregator';
  UPDATE consent_record SET subject_type = 'organisation' WHERE subject_type = 'org';
  UPDATE consent_record c SET user_id = c.subject_id
   WHERE c.subject_type = 'user' AND c.user_id IS NULL
     AND EXISTS (SELECT 1 FROM users u WHERE u.id = c.subject_id);
  GET DIAGNOSTICS n_user = ROW_COUNT;
  UPDATE consent_record c SET org_id = c.subject_id
   WHERE c.subject_type = 'organisation' AND c.org_id IS NULL
     AND EXISTS (SELECT 1 FROM organisations o WHERE o.id = c.subject_id);
  GET DIAGNOSTICS n_org = ROW_COUNT;
  -- valid_till: the user's stored consent, on its newest registration row
  -- (one sort of the ledger, not a subquery per row).
  IF pg_temp.has_column('users', 'consent') THEN
    UPDATE consent_record c SET valid_till = pg_temp.ts(u.consent->>'valid_till')
      FROM (SELECT DISTINCT ON (user_id) id, user_id
              FROM consent_record
             WHERE user_id IS NOT NULL AND source IN ('registration', 'registration-backfill')
             ORDER BY user_id, accepted_at DESC, created_at DESC) newest
      JOIN users u ON u.id = newest.user_id
     WHERE c.id = newest.id AND u.consent IS NOT NULL AND c.valid_till IS NULL;
  END IF;
  SELECT count(*) INTO n_unlinked FROM consent_record WHERE user_id IS NULL AND org_id IS NULL;
  RAISE NOTICE '0029: ledger rows linked user=% org=%; unlinked (subject gone)=%', n_user, n_org, n_unlinked;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.consent_record'::regclass
                    AND conname = 'consent_record_user_id_users_id_fk') THEN
    ALTER TABLE consent_record ADD CONSTRAINT consent_record_user_id_users_id_fk
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.consent_record'::regclass
                    AND conname = 'consent_record_org_id_organisations_id_fk') THEN
    ALTER TABLE consent_record ADD CONSTRAINT consent_record_org_id_organisations_id_fk
      FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.consent_record'::regclass
                    AND conname = 'consent_record_subject_chk') THEN
    ALTER TABLE consent_record ADD CONSTRAINT consent_record_subject_chk CHECK (
          subject_type IN ('user', 'organisation')
      AND num_nonnulls(user_id, org_id) <= 1
      AND (user_id IS NULL OR (subject_type = 'user' AND subject_id = user_id))
      AND (org_id IS NULL OR (subject_type = 'organisation' AND subject_id = org_id)));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS consent_record_user_idx
  ON consent_record (user_id, accepted_at DESC) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS consent_record_org_idx
  ON consent_record (org_id) WHERE org_id IS NOT NULL;

-- Append-only: rows are never changed or removed, except that a link drops
-- to NULL when its subject is deleted (the FKs' ON DELETE SET NULL).
CREATE OR REPLACE FUNCTION consent_record_append_only() RETURNS trigger
  LANGUAGE plpgsql AS
$fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'consent_record is append-only (id=%)', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.id, NEW.subject_type, NEW.subject_id, NEW.terms_version, NEW.privacy_version,
      NEW.network, NEW.brand, NEW.source, NEW.accepted_at, NEW.created_at, NEW.valid_till)
       IS DISTINCT FROM
     (OLD.id, OLD.subject_type, OLD.subject_id, OLD.terms_version, OLD.privacy_version,
      OLD.network, OLD.brand, OLD.source, OLD.accepted_at, OLD.created_at, OLD.valid_till)
     OR (NEW.user_id IS DISTINCT FROM OLD.user_id AND NEW.user_id IS NOT NULL)
     OR (NEW.org_id IS DISTINCT FROM OLD.org_id AND NEW.org_id IS NOT NULL) THEN
    RAISE EXCEPTION 'consent_record is append-only (id=%)', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$fn$;
CREATE OR REPLACE TRIGGER consent_record_append_only
  BEFORE UPDATE OR DELETE ON consent_record
  FOR EACH ROW EXECUTE FUNCTION consent_record_append_only();

-- TRUNCATE bypasses row triggers: refuse it too.
CREATE OR REPLACE FUNCTION consent_record_no_truncate() RETURNS trigger
  LANGUAGE plpgsql AS
$fn$
BEGIN
  RAISE EXCEPTION 'consent_record is append-only (TRUNCATE refused)'
    USING ERRCODE = 'restrict_violation';
END;
$fn$;
CREATE OR REPLACE TRIGGER consent_record_no_truncate
  BEFORE TRUNCATE ON consent_record
  FOR EACH STATEMENT EXECUTE FUNCTION consent_record_no_truncate();

-- ─── S4 new user columns ───────────────────────────────────────────────────
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS serves text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS alternate_phone text,
  ADD COLUMN IF NOT EXISTS invite_id uuid;

DO $$
DECLARE
  n_serves int := 0;
  n_phone int := 0;
BEGIN
  ALTER TABLE users DISABLE TRIGGER users_set_updated_at;
  IF pg_temp.has_column('users', 'type') THEN
    -- NULL, blank and the legacy 'both' all mean every domain ('{}').
    UPDATE users SET serves = ARRAY[btrim(type)]
     WHERE nullif(btrim(type), '') IS NOT NULL AND btrim(type) <> 'both' AND serves = '{}';
    GET DIAGNOSTICS n_serves = ROW_COUNT;
  END IF;
  IF pg_temp.has_column('users', 'contact_extra') THEN
    -- Verbatim, as the store returned it.
    UPDATE users SET alternate_phone = contact_extra->>'alternatePhone'
     WHERE jsonb_typeof(contact_extra->'alternatePhone') = 'string' AND alternate_phone IS NULL;
    GET DIAGNOSTICS n_phone = ROW_COUNT;
  END IF;
  ALTER TABLE users ENABLE TRIGGER users_set_updated_at;
  RAISE NOTICE '0029: serves set=%; alternate_phone moved=%', n_serves, n_phone;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.users'::regclass
                    AND conname = 'users_invite_id_registration_invites_jti_fk') THEN
    ALTER TABLE users ADD CONSTRAINT users_invite_id_registration_invites_jti_fk
      FOREIGN KEY (invite_id) REFERENCES registration_invites(jti) ON DELETE SET NULL;
  END IF;
END $$;

-- Index first: the pass below looks invites up by it, and so do the FK's
-- ON DELETE SET NULL and the invite-email read.
CREATE INDEX IF NOT EXISTS users_invite_idx ON users (invite_id) WHERE invite_id IS NOT NULL;

-- ─── S5 the invite each coordinator registered with ────────────────────────
-- Coordinators in order of registration each take the unclaimed consumed
-- invite for their invited address and org whose consumed_at is nearest
-- their created_at. The address the row held is kept on it
-- (`profile.legacy_invite_email`) when no invite is left for it, or when the
-- invite's spelling differs, so a revert restores it exactly.
DO $$
DECLARE
  r record;
  v_jti uuid;
  v_email text;
  n_linked int := 0;
  n_legacy int := 0;
BEGIN
  IF NOT pg_temp.has_column('users', 'invite_email') THEN
    RETURN;
  END IF;
  ALTER TABLE users DISABLE TRIGGER users_set_updated_at;
  FOR r IN SELECT id, invite_email, org_id, created_at
             FROM users
            WHERE invite_email IS NOT NULL AND invite_id IS NULL
            ORDER BY created_at, id LOOP
    SELECT i.jti, i.email INTO v_jti, v_email
      FROM registration_invites i
     WHERE lower(btrim(i.email)) = lower(btrim(r.invite_email))
       AND i.org_id = r.org_id AND i.status = 'consumed'
       AND NOT EXISTS (SELECT 1 FROM users u WHERE u.invite_id = i.jti)
     ORDER BY abs(extract(epoch FROM coalesce(i.consumed_at, i.created_at) - r.created_at)), i.jti
     LIMIT 1;
    IF v_jti IS NOT NULL THEN
      UPDATE users SET invite_id = v_jti WHERE id = r.id;
      n_linked := n_linked + 1;
    END IF;
    IF v_jti IS NULL OR v_email IS DISTINCT FROM r.invite_email THEN
      UPDATE users SET profile = profile || jsonb_build_object('legacy_invite_email', r.invite_email)
       WHERE id = r.id AND profile IS NOT NULL;
      n_legacy := n_legacy + 1;
    END IF;
  END LOOP;
  ALTER TABLE users ENABLE TRIGGER users_set_updated_at;
  RAISE NOTICE '0029: invites linked=%; address kept as legacy_invite_email=%', n_linked, n_legacy;
END $$;

-- ─── S6 drop the old columns; one rule for the row shape (re-added) ────────
-- Dropping a column drops every CHECK naming it, so users_role_shape_chk is
-- dropped explicitly and re-created for the new columns.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_shape_chk;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_type_actor_chk;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_consent_shape_chk;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_contact_extra_object_chk;
DROP INDEX IF EXISTS users_actor_type_idx;
ALTER TABLE users
  DROP COLUMN IF EXISTS consent,
  DROP COLUMN IF EXISTS type,
  DROP COLUMN IF EXISTS actor_type,
  DROP COLUMN IF EXISTS contact_extra,
  DROP COLUMN IF EXISTS invite_email;
DROP TYPE IF EXISTS aggregator_actor_type;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.users'::regclass AND conname = 'users_role_shape_chk') THEN
    ALTER TABLE users ADD CONSTRAINT users_role_shape_chk CHECK (
      CASE user_type
        WHEN 'coordinator' THEN
              org_id IS NOT NULL
          AND signalstack_org_slug IS NOT NULL AND signalstack_org_name IS NOT NULL
          AND status IS NOT NULL AND profile IS NOT NULL
        ELSE
              org_id IS NULL AND legacy_org_details IS NULL
          AND signalstack_org_slug IS NULL AND signalstack_org_name IS NULL
          AND status IS NULL AND profile IS NULL
          AND serves = '{}' AND alternate_phone IS NULL AND invite_id IS NULL
          AND signalstack_org_id IS NULL AND rejected_at IS NULL AND profile_ref IS NULL
      END);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.users'::regclass AND conname = 'users_serves_no_null_chk') THEN
    ALTER TABLE users ADD CONSTRAINT users_serves_no_null_chk
      CHECK (array_position(serves, NULL) IS NULL);
  END IF;
END $$;

-- ─── S7 one vocabulary (metadata only) ─────────────────────────────────────
DO $$
BEGIN
  IF to_regtype('public.aggregator_status') IS NOT NULL
     AND to_regtype('public.registration_status') IS NULL THEN
    ALTER TYPE aggregator_status RENAME TO registration_status;
  END IF;
END $$;
SELECT pg_temp.ren_column('onboarding', 'org_slug', 'signalstack_org_slug');
SELECT pg_temp.ren_column('campaign_pii_audit', 'actor_org_id', 'actor_signalstack_org_id');

-- Leave the transaction as the role that started it (drizzle writes its
-- metadata right after this file).
RESET ROLE;
SELECT set_config('lock_timeout', current_setting('aggregator_dpg.prev_lock_timeout'), true),
       set_config('statement_timeout', current_setting('aggregator_dpg.prev_statement_timeout'), true);
