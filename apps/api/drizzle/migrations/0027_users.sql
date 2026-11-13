-- Migration 0027 — `aggregators` becomes `users` (user & org refactor, Phase 2).
--
-- Every row of `aggregators` is a coordinator ACCOUNT, so the table is renamed
-- `users` with its ids kept: the Keycloak `aggregator_id` attribute, the
-- token claim, the Signals `external_id` and every tenant-table FK keep
-- pointing at the same rows. Org owners become `users` rows too
-- (`user_type = 'admin'`, identity only), and `aggregator_orgs` points at its
-- owner through `owner_user_id`. Login identities move to a provider-neutral
-- `user_identities (user_id, provider, subject)` table on the account.
--
-- Column renames on `users`:
--   org_slug → signalstack_org_slug   (the coordinator's Signals org slug,
--                                      also the [org] segment of public links)
--   name     → signalstack_org_name   (the coordinator's Signals org name)
-- Tenant tables: aggregator_id → user_id (values unchanged).
--
-- DEPLOY: part of the user & org release train, applied with pods at zero by
-- the migration tool (see docs/plans/existing-instance-migration.md). The
-- API's runMigrations() refuses to run the train on a non-empty database on
-- its own (boot guard in src/db/migrate.ts).
--
-- Nothing here bumps `updated_at` on an existing row: `user_type` is added
-- with a constant default (metadata-only), and every other write inserts new
-- rows or updates `aggregator_orgs`, which has no updated_at trigger.
--
-- Idempotent: every step is guarded, and steps that read a column a later
-- step drops run only while that column exists. Counts only in messages —
-- never PII.

SELECT set_config('aggregator_dpg.prev_lock_timeout', current_setting('lock_timeout'), true),
       set_config('aggregator_dpg.prev_statement_timeout', current_setting('statement_timeout'), true);
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '300s';
SELECT pg_advisory_xact_lock(hashtext('aggregator-dpg:0027_users'));

-- Run as the table owner (same rule as 0025/0026). The table is resolved by
-- either name, so a re-run after the rename still works.
DO $$
DECLARE
  v_owner text;
BEGIN
  SELECT pg_get_userbyid(c.relowner) INTO v_owner
    FROM pg_class c
   WHERE c.oid = coalesce(to_regclass('public.users'), to_regclass('public.aggregators'));
  IF v_owner IS DISTINCT FROM current_user THEN
    IF pg_has_role(current_user, v_owner, 'MEMBER') THEN
      EXECUTE format('SET LOCAL ROLE %I', v_owner);
    ELSE
      RAISE EXCEPTION '0027: run as the owner of "aggregators" (%), not as %', v_owner, current_user;
    END IF;
  END IF;
END $$;

-- ─── Guarded-rename helpers (session-local; gone at commit) ────────────────
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

CREATE OR REPLACE FUNCTION pg_temp.ren_trigger(p_table text, p_old text, p_new text)
  RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger
              WHERE tgrelid = to_regclass('public.' || p_table) AND tgname = p_old) THEN
    EXECUTE format('ALTER TRIGGER %I ON %I RENAME TO %I', p_old, p_table, p_new);
  END IF;
END $fn$;

-- ─── U1 lock (pods are at zero; this only guards against a stray one) ──────
DO $$
BEGIN
  EXECUTE format(
    'LOCK TABLE %s, aggregator_orgs, contact, bulk_uploads, registration_links, '
    'link_submissions, onboarding, campaign_job IN ACCESS EXCLUSIVE MODE',
    coalesce(to_regclass('public.users'), to_regclass('public.aggregators')));
END $$;

-- ─── U2 blockers (first run only) ───────────────────────────────────────────
DO $$
DECLARE
  n_null int;
  n_sub_per_contact int;
  n_contact_per_sub int;
BEGIN
  IF to_regclass('public.users') IS NULL THEN
    SELECT count(*) INTO n_null FROM aggregator_orgs WHERE contact_id IS NULL;
    -- F15: one owner contact with two different Keycloak subjects.
    SELECT count(*) INTO n_sub_per_contact FROM (
      SELECT contact_id FROM aggregator_orgs WHERE owner_kc_sub IS NOT NULL
       GROUP BY contact_id HAVING count(DISTINCT owner_kc_sub) > 1) d;
    -- F15b: one Keycloak subject on the orgs of two different contacts.
    SELECT count(*) INTO n_contact_per_sub FROM (
      SELECT owner_kc_sub FROM aggregator_orgs WHERE owner_kc_sub IS NOT NULL
       GROUP BY owner_kc_sub HAVING count(DISTINCT contact_id) > 1) d;
    IF n_null + n_sub_per_contact + n_contact_per_sub > 0 THEN
      RAISE EXCEPTION '0027 pre-flight failed: orgs_without_contact=% owner_contacts_with_several_subjects=% subjects_on_several_contacts=% — see scripts/sql/users-preflight.sql',
        n_null, n_sub_per_contact, n_contact_per_sub;
    END IF;
  END IF;
END $$;

-- ─── U3 type ────────────────────────────────────────────────────────────────
DO $$
BEGIN
  CREATE TYPE user_type AS ENUM ('admin', 'coordinator');
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

-- ─── U4 rename ──────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.users') IS NULL THEN
    ALTER TABLE aggregators RENAME TO users;
  END IF;
END $$;
SELECT pg_temp.ren_column('users', 'org_slug', 'signalstack_org_slug');
SELECT pg_temp.ren_column('users', 'name', 'signalstack_org_name');

-- ─── U5 slug lock: its body named org_slug, so it is recreated BEFORE any
-- UPDATE on users can fire it ──────────────────────────────────────────────
DROP TRIGGER IF EXISTS aggregators_lock_slug ON users;
CREATE OR REPLACE FUNCTION users_lock_signalstack_org_slug() RETURNS trigger
  LANGUAGE plpgsql AS
$fn$
BEGIN
  IF NEW.signalstack_org_slug IS DISTINCT FROM OLD.signalstack_org_slug THEN
    RAISE EXCEPTION 'signalstack_org_slug is immutable (id=%)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$fn$;
CREATE OR REPLACE TRIGGER users_lock_signalstack_org_slug
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION users_lock_signalstack_org_slug();
DROP FUNCTION IF EXISTS aggregators_lock_slug();

-- ─── U6 user_type (constant default: metadata-only, no rewrite, no trigger) ─
ALTER TABLE users ADD COLUMN IF NOT EXISTS user_type user_type NOT NULL DEFAULT 'coordinator';
ALTER TABLE users ALTER COLUMN user_type DROP DEFAULT;

-- ─── U7 coordinator-only columns become nullable ───────────────────────────
ALTER TABLE users ALTER COLUMN signalstack_org_slug DROP NOT NULL;
ALTER TABLE users ALTER COLUMN signalstack_org_name DROP NOT NULL;
ALTER TABLE users ALTER COLUMN actor_type           DROP NOT NULL;
ALTER TABLE users ALTER COLUMN consent              DROP NOT NULL;
ALTER TABLE users ALTER COLUMN locations            DROP NOT NULL;
ALTER TABLE users ALTER COLUMN contact_extra        DROP NOT NULL;
ALTER TABLE users ALTER COLUMN profile              DROP NOT NULL;
ALTER TABLE users ALTER COLUMN status               DROP NOT NULL;

-- ─── U8 one rule for the row shape ─────────────────────────────────────────
-- The column defaults stay (coordinator inserts rely on them), so every admin
-- INSERT must write explicit NULLs for status / locations / profile /
-- contact_extra.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.users'::regclass AND conname = 'users_role_shape_chk') THEN
    ALTER TABLE users ADD CONSTRAINT users_role_shape_chk CHECK (
      CASE user_type
        WHEN 'coordinator' THEN
              signalstack_org_slug IS NOT NULL AND signalstack_org_name IS NOT NULL
          AND status IS NOT NULL AND actor_type IS NOT NULL AND consent IS NOT NULL
          AND locations IS NOT NULL AND contact_extra IS NOT NULL AND profile IS NOT NULL
        ELSE
              signalstack_org_slug IS NULL AND signalstack_org_name IS NULL
          AND status IS NULL AND actor_type IS NULL AND consent IS NULL
          AND locations IS NULL AND contact_extra IS NULL AND profile IS NULL
          AND type IS NULL AND url IS NULL AND signalstack_org_id IS NULL
          AND parent_org_id IS NULL AND invite_email IS NULL AND rejected_at IS NULL
          AND profile_ref IS NULL
      END);
  END IF;
END $$;

-- ─── U9 one account per person per role (before any admin insert) ─────────
DROP INDEX IF EXISTS aggregators_contact_id_unique;
CREATE UNIQUE INDEX IF NOT EXISTS users_contact_type_unique ON users (contact_id, user_type);

-- ─── U10 provider-neutral login identities ─────────────────────────────────
CREATE TABLE IF NOT EXISTS user_identities (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider   text NOT NULL CONSTRAINT user_identities_provider_chk CHECK (provider ~ '^[a-z][a-z0-9_-]*$'),
  subject    text NOT NULL CONSTRAINT user_identities_subject_chk CHECK (btrim(subject) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_identities_pkey PRIMARY KEY (user_id, provider),
  CONSTRAINT user_identities_provider_subject_unique UNIQUE (provider, subject)
);

-- ─── U11–U13 owners (only while aggregator_orgs still has contact_id) ──────
ALTER TABLE aggregator_orgs ADD COLUMN IF NOT EXISTS owner_user_id uuid;

DO $$
DECLARE
  n_admins int;
  n_identities int;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'aggregator_orgs'
                AND column_name = 'contact_id') THEN
    -- U11: one admin account per owner contact (identity only: explicit NULLs).
    INSERT INTO users (id, user_type, contact_id, status, locations, profile, contact_extra,
                       created_by, updated_by, created_at, updated_at)
    SELECT gen_random_uuid(), 'admin', o.contact_id, NULL, NULL, NULL, NULL,
           'self', 'self', min(o.created_at), min(o.created_at)
      FROM aggregator_orgs o
     GROUP BY o.contact_id
    ON CONFLICT (contact_id, user_type) DO NOTHING;
    GET DIAGNOSTICS n_admins = ROW_COUNT;

    -- U12: each org points at its owner's admin account.
    UPDATE aggregator_orgs o
       SET owner_user_id = u.id
      FROM users u
     WHERE u.contact_id = o.contact_id AND u.user_type = 'admin'
       AND o.owner_user_id IS NULL;

    -- U13: the owner's Keycloak subject becomes a login identity.
    INSERT INTO user_identities (user_id, provider, subject)
    SELECT DISTINCT ON (o.owner_user_id) o.owner_user_id, 'keycloak', o.owner_kc_sub
      FROM aggregator_orgs o
     WHERE o.owner_kc_sub IS NOT NULL
     ORDER BY o.owner_user_id, o.created_at DESC
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS n_identities = ROW_COUNT;

    RAISE NOTICE '0027: admin accounts created=%, owner identities created=%', n_admins, n_identities;
  END IF;
END $$;

ALTER TABLE aggregator_orgs ALTER COLUMN owner_user_id SET NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.aggregator_orgs'::regclass
                    AND conname = 'aggregator_orgs_owner_user_id_users_id_fk') THEN
    ALTER TABLE aggregator_orgs ADD CONSTRAINT aggregator_orgs_owner_user_id_users_id_fk
      FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE RESTRICT;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS aggregator_orgs_owner_user_idx ON aggregator_orgs (owner_user_id);

-- ─── U14 contact GC on users only; owner release on any org delete ─────────
DROP TRIGGER IF EXISTS aggregator_orgs_contact_ad ON aggregator_orgs;
DROP FUNCTION IF EXISTS aggregator_orgs_contact_ad();
DROP INDEX IF EXISTS aggregator_orgs_contact_id_idx;
ALTER TABLE aggregator_orgs DROP CONSTRAINT IF EXISTS aggregator_orgs_contact_id_fk;
ALTER TABLE aggregator_orgs DROP COLUMN IF EXISTS contact_id;
ALTER TABLE aggregator_orgs DROP COLUMN IF EXISTS owner_kc_sub;

-- Deletes a contact nothing references any more (only users reference it now).
CREATE OR REPLACE FUNCTION contact_gc(p_id text) RETURNS void
  LANGUAGE plpgsql AS
$fn$
BEGIN
  IF p_id IS NULL THEN
    RETURN;
  END IF;
  BEGIN
    DELETE FROM contact c
     WHERE c.id = p_id
       AND NOT EXISTS (SELECT 1 FROM users u WHERE u.contact_id = p_id);
  EXCEPTION WHEN foreign_key_violation THEN
    NULL; -- a concurrent insert re-referenced it; keep the row
  END;
END;
$fn$;

DROP TRIGGER IF EXISTS aggregators_contact_ad ON users;
DROP FUNCTION IF EXISTS aggregators_contact_ad();
CREATE OR REPLACE FUNCTION users_contact_ad() RETURNS trigger
  LANGUAGE plpgsql AS
$fn$
BEGIN
  PERFORM contact_gc(OLD.contact_id);
  RETURN NULL;
END;
$fn$;
CREATE OR REPLACE TRIGGER users_contact_ad
  AFTER DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION users_contact_ad();

-- Any org delete releases the owner's admin account once it owns nothing
-- else; the account's identities cascade and users_contact_ad collects the
-- contact. Keeps "deleting an org frees the owner's email/phone" a database
-- guarantee, whatever path deletes the org.
CREATE OR REPLACE FUNCTION aggregator_orgs_owner_ad() RETURNS trigger
  LANGUAGE plpgsql AS
$fn$
BEGIN
  BEGIN
    DELETE FROM users u
     WHERE u.id = OLD.owner_user_id
       AND u.user_type = 'admin'
       AND NOT EXISTS (SELECT 1 FROM aggregator_orgs o WHERE o.owner_user_id = OLD.owner_user_id);
  EXCEPTION WHEN foreign_key_violation THEN
    NULL; -- a concurrent org create re-referenced the account; keep it (as contact_gc does)
  END;
  RETURN NULL;
END;
$fn$;
CREATE OR REPLACE TRIGGER aggregator_orgs_owner_ad
  AFTER DELETE ON aggregator_orgs
  FOR EACH ROW EXECUTE FUNCTION aggregator_orgs_owner_ad();

-- ─── U15 tenant tables: aggregator_id → user_id ────────────────────────────
SELECT pg_temp.ren_column('bulk_uploads',       'aggregator_id', 'user_id');
SELECT pg_temp.ren_column('registration_links', 'aggregator_id', 'user_id');
SELECT pg_temp.ren_column('link_submissions',   'aggregator_id', 'user_id');
SELECT pg_temp.ren_column('onboarding',         'aggregator_id', 'user_id');
SELECT pg_temp.ren_column('campaign_job',       'aggregator_id', 'user_id');
SELECT pg_temp.ren_constraint('bulk_uploads',       'bulk_uploads_aggregator_id_aggregators_id_fk',       'bulk_uploads_user_id_users_id_fk');
SELECT pg_temp.ren_constraint('registration_links', 'registration_links_aggregator_id_aggregators_id_fk', 'registration_links_user_id_users_id_fk');
SELECT pg_temp.ren_constraint('link_submissions',   'link_submissions_aggregator_id_aggregators_id_fk',   'link_submissions_user_id_users_id_fk');
SELECT pg_temp.ren_constraint('onboarding',         'onboarding_aggregator_id_aggregators_id_fk',         'onboarding_user_id_users_id_fk');
SELECT pg_temp.ren_constraint('campaign_job',       'campaign_job_aggregator_id_aggregators_id_fk',       'campaign_job_user_id_users_id_fk');
SELECT pg_temp.ren_index('bulk_uploads_aggregator_status_idx',        'bulk_uploads_user_status_idx');
SELECT pg_temp.ren_index('registration_links_aggregator_slug_unique', 'registration_links_user_slug_unique');
SELECT pg_temp.ren_index('registration_links_aggregator_status_idx',  'registration_links_user_status_idx');
SELECT pg_temp.ren_index('link_submissions_aggregator_created_idx',   'link_submissions_user_created_idx');
SELECT pg_temp.ren_index('onboarding_aggregator_source_idx',          'onboarding_user_source_idx');

-- ─── U16 remaining aggregators_* names → users_* ───────────────────────────
SELECT pg_temp.ren_constraint('users', 'aggregators_pkey',                                'users_pkey');
SELECT pg_temp.ren_constraint('users', 'aggregators_org_slug_unique',                     'users_signalstack_org_slug_unique');
SELECT pg_temp.ren_constraint('users', 'aggregators_consent_shape_chk',                   'users_consent_shape_chk');
SELECT pg_temp.ren_constraint('users', 'aggregators_contact_extra_object_chk',            'users_contact_extra_object_chk');
SELECT pg_temp.ren_constraint('users', 'aggregators_locations_array_chk',                 'users_locations_array_chk');
SELECT pg_temp.ren_constraint('users', 'aggregators_profile_object_chk',                  'users_profile_object_chk');
SELECT pg_temp.ren_constraint('users', 'aggregators_type_actor_chk',                      'users_type_actor_chk');
SELECT pg_temp.ren_constraint('users', 'aggregators_contact_id_fk',                       'users_contact_id_fk');
SELECT pg_temp.ren_constraint('users', 'aggregators_parent_org_id_aggregator_orgs_id_fk', 'users_parent_org_id_aggregator_orgs_id_fk');
SELECT pg_temp.ren_index('aggregators_status_idx',     'users_status_idx');
SELECT pg_temp.ren_index('aggregators_actor_type_idx', 'users_actor_type_idx');
SELECT pg_temp.ren_trigger('users', 'aggregators_set_updated_at', 'users_set_updated_at');

-- Leave the transaction as the role that started it: drizzle records the
-- migration in drizzle.__drizzle_migrations right after this file, and the
-- table owner may have no rights there.
RESET ROLE;
SELECT set_config('lock_timeout', current_setting('aggregator_dpg.prev_lock_timeout'), true),
       set_config('statement_timeout', current_setting('aggregator_dpg.prev_statement_timeout'), true);
