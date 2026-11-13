-- Migration 0028 — `aggregator_orgs` becomes `organisations` (user & org
-- refactor, Phase 3; design: docs/plans/organisation-phase-3-implementation.md).
--
-- * `aggregator_orgs` → `organisations` (ids kept); `display_name` → `name`,
--   `owner_user_id` → `org_owner`; new `org_type`, `parent_id`, `url`,
--   `locations`, `legal_name`, `gst_number`, `created_by`, `updated_by`.
-- * Exactly one `network_facilitator` org (the root), owned by a network-admin
--   account on a placeholder contact; `ensureRootOrganisation()` replaces the
--   placeholders from config at boot. A fixed "Default" aggregator org holds
--   every coordinator that had no parent org.
-- * `users.parent_org_id` → `users.org_id` (required for coordinators).
-- * Coordinators' `url` / `locations` / company / GST move to their org by
--   the adoption rule; whatever differs from the org's value is kept in
--   `users.legacy_org_details` (empties included, so a revert is exact).
--   The org's own `profile` keys and `state` column are COPIED, not removed
--   (Phase 4 drops them).
-- * `registration_invites.parent_org_id` → `org_id`; tenant tables gain
--   `org_id`, filled on insert by a trigger.
--
-- DEPLOY: part of the user & org release train, applied with pods at zero by
-- the migration tool. runMigrations() refuses it at boot on a database that
-- holds data (src/db/migration-guards.ts).
--
-- `updated_at` is never bumped: `users_set_updated_at` is disabled around the
-- data steps, and `organisations` / the tenant tables have no such trigger.
--
-- Idempotent: "first run" is captured before the rename, and every data step
-- is gated on a column it later drops or on a per-row condition. Counts only
-- in messages — never PII.

SELECT set_config('aggregator_dpg.prev_lock_timeout', current_setting('lock_timeout'), true),
       set_config('aggregator_dpg.prev_statement_timeout', current_setting('statement_timeout'), true);
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '300s';
SELECT pg_advisory_xact_lock(hashtext('aggregator-dpg:0028_organisations'));

-- Run as the table owner (same rule as 0025–0027).
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
      RAISE EXCEPTION '0028: run as the owner of "users" (%), not as %', v_owner, current_user;
    END IF;
  END IF;
END $$;

-- First run = the org table still has its old name. Captured before O2
-- renames it inside this same transaction.
SELECT set_config('aggregator_dpg.p3_first_run',
                  (to_regclass('public.organisations') IS NULL)::text, true);

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

CREATE OR REPLACE FUNCTION pg_temp.has_column(p_table text, p_column text)
  RETURNS boolean LANGUAGE sql STABLE AS $fn$
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = p_table AND column_name = p_column);
$fn$;

-- A trimmed string, or NULL when blank.
CREATE OR REPLACE FUNCTION pg_temp.nz(p text)
  RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT nullif(btrim(p), '');
$fn$;

-- Whether a Beckn locations array holds anything real: an entry with a street
-- or locality, or coordinates other than the web's [0,0] placeholder.
CREATE OR REPLACE FUNCTION pg_temp.loc_nonempty(p jsonb)
  RETURNS boolean LANGUAGE sql IMMUTABLE AS $fn$
  SELECT coalesce(jsonb_typeof(p) = 'array' AND EXISTS (
           SELECT 1 FROM jsonb_array_elements(p) e
            WHERE pg_temp.nz(e #>> '{address,streetAddress}') IS NOT NULL
               OR pg_temp.nz(e #>> '{address,addressLocality}') IS NOT NULL
               OR (jsonb_typeof(e #> '{geo,coordinates}') = 'array'
                   AND e #> '{geo,coordinates}' <> '[0,0]'::jsonb
                   AND e #> '{geo,coordinates}' <> '[0.0,0.0]'::jsonb)), false);
$fn$;

-- ─── O1 lock (pods are at zero; this only guards against a stray one) ──────
DO $$
BEGIN
  EXECUTE format(
    'LOCK TABLE users, %s, registration_invites, contact, user_identities, bulk_uploads, '
    'registration_links, link_submissions, onboarding, campaign_job IN ACCESS EXCLUSIVE MODE',
    coalesce(to_regclass('public.organisations'), to_regclass('public.aggregator_orgs')));
END $$;

-- ─── O1b blockers (first run only) ─────────────────────────────────────────
DO $$
DECLARE
  n_owner int;
  n_parent int;
BEGIN
  IF current_setting('aggregator_dpg.p3_first_run') = 'true' THEN
    SELECT count(*) INTO n_owner
      FROM aggregator_orgs o LEFT JOIN users u ON u.id = o.owner_user_id
     WHERE u.id IS NULL OR u.user_type <> 'admin';
    SELECT count(*) INTO n_parent
      FROM users u LEFT JOIN aggregator_orgs o ON o.id = u.parent_org_id
     WHERE u.parent_org_id IS NOT NULL AND o.id IS NULL;
    IF n_owner + n_parent > 0 THEN
      RAISE EXCEPTION '0028 pre-flight failed: orgs_with_non_admin_owner=% coordinators_with_missing_org=% — see scripts/sql/organisation-preflight.sql',
        n_owner, n_parent;
    END IF;
  END IF;
END $$;

-- ─── O2 type and renames ───────────────────────────────────────────────────
DO $$
BEGIN
  CREATE TYPE org_type AS ENUM ('network_facilitator', 'aggregator');
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

DO $$
BEGIN
  IF to_regclass('public.organisations') IS NULL THEN
    ALTER TABLE aggregator_orgs RENAME TO organisations;
  END IF;
END $$;
SELECT pg_temp.ren_column('organisations', 'display_name', 'name');
SELECT pg_temp.ren_column('organisations', 'owner_user_id', 'org_owner');
SELECT pg_temp.ren_constraint('organisations', 'aggregator_orgs_pkey', 'organisations_pkey');
SELECT pg_temp.ren_constraint('organisations', 'aggregator_orgs_profile_object_chk', 'organisations_profile_object_chk');
SELECT pg_temp.ren_constraint('organisations', 'aggregator_orgs_owner_user_id_users_id_fk', 'organisations_org_owner_users_id_fk');
SELECT pg_temp.ren_index('aggregator_orgs_status_idx', 'organisations_status_idx');
SELECT pg_temp.ren_index('aggregator_orgs_owner_user_idx', 'organisations_org_owner_idx');
SELECT pg_temp.ren_index('aggregator_orgs_slug_active_unique', 'organisations_slug_live_unique');

-- The owner-release trigger named the old table and column: recreate it.
DROP TRIGGER IF EXISTS aggregator_orgs_owner_ad ON organisations;
DROP FUNCTION IF EXISTS aggregator_orgs_owner_ad();
CREATE OR REPLACE FUNCTION organisations_owner_ad() RETURNS trigger
  LANGUAGE plpgsql AS
$fn$
BEGIN
  BEGIN
    DELETE FROM users u
     WHERE u.id = OLD.org_owner
       AND u.user_type = 'admin'
       AND NOT EXISTS (SELECT 1 FROM organisations o WHERE o.org_owner = OLD.org_owner);
  EXCEPTION WHEN foreign_key_violation THEN
    NULL; -- a concurrent org create re-referenced the account; keep it (as contact_gc does)
  END;
  RETURN NULL;
END;
$fn$;
CREATE OR REPLACE TRIGGER organisations_owner_ad
  AFTER DELETE ON organisations
  FOR EACH ROW EXECUTE FUNCTION organisations_owner_ad();

-- ─── O3 new columns ────────────────────────────────────────────────────────
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS org_type   org_type;
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS parent_id  uuid;
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS url        text;
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS locations  jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS legal_name text;
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS gst_number text;
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS created_by text;
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS updated_by text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS legacy_org_details jsonb;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.organisations'::regclass
                    AND conname = 'organisations_parent_id_organisations_id_fk') THEN
    ALTER TABLE organisations ADD CONSTRAINT organisations_parent_id_organisations_id_fk
      FOREIGN KEY (parent_id) REFERENCES organisations(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.organisations'::regclass
                    AND conname = 'organisations_locations_array_chk') THEN
    ALTER TABLE organisations ADD CONSTRAINT organisations_locations_array_chk
      CHECK (jsonb_typeof(locations) = 'array');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.users'::regclass
                    AND conname = 'users_legacy_org_details_object_chk') THEN
    ALTER TABLE users ADD CONSTRAINT users_legacy_org_details_object_chk
      CHECK (legacy_org_details IS NULL OR jsonb_typeof(legacy_org_details) = 'object');
  END IF;
END $$;

-- ─── O4 make room for the Default org and the root (first run only) ────────
DO $$
DECLARE
  n_name int;
  n_slug int;
BEGIN
  IF current_setting('aggregator_dpg.p3_first_run') = 'true' THEN
    -- The original name / slug is kept in `profile.renamed_from`, so a revert
    -- (existing-instance-migration §13) restores it exactly.
    UPDATE organisations
       SET profile = profile || jsonb_build_object('renamed_from', jsonb_build_object('name', name)),
           name = name || ' (' || slug || ')'
     WHERE lower(name) IN ('default', 'network') AND status IN ('pending', 'active');
    GET DIAGNOSTICS n_name = ROW_COUNT;
    UPDATE organisations
       SET profile = profile || jsonb_build_object('renamed_from',
                       coalesce(profile -> 'renamed_from', '{}'::jsonb) || jsonb_build_object('slug', slug)),
           slug = slug || '-r1'
     WHERE slug IN ('default', 'network');
    GET DIAGNOSTICS n_slug = ROW_COUNT;
    IF n_name + n_slug > 0 THEN
      RAISE NOTICE '0028: orgs renamed to free the Default / network names: name=%, slug=%', n_name, n_slug;
    END IF;
  END IF;
END $$;

-- ─── O4b live-name uniqueness for aggregator orgs only ─────────────────────
-- Swapped BEFORE the root and Default are inserted: the old index covered every
-- live row, so a live org named like the root ("Network") would have collided
-- with it. Existing orgs get org_type in O7; until then they are unique under
-- the old index's own guarantee.
DROP INDEX IF EXISTS aggregator_orgs_display_name_active_unique;
CREATE UNIQUE INDEX IF NOT EXISTS organisations_name_live_unique
  ON organisations (lower(name))
  WHERE org_type = 'aggregator' AND status IN ('pending', 'active');

-- ─── O5 NF root and the network admin (placeholders; reconciled at boot) ───
-- Runs only while no NF exists, so the explicit-NULL column list (which names
-- `users.locations`, dropped in O11b) is never parsed on a re-run.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM organisations WHERE org_type = 'network_facilitator') THEN
    INSERT INTO contact (id, email, name)
    VALUES (contact_id_of('network-admin@nf.invalid', NULL), 'network-admin@nf.invalid', 'Network admin')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO users (id, user_type, contact_id, status, locations, profile, contact_extra,
                       created_by, updated_by)
    VALUES (gen_random_uuid(), 'admin', contact_id_of('network-admin@nf.invalid', NULL),
            NULL, NULL, NULL, NULL, 'system', 'system')
    ON CONFLICT (contact_id, user_type) DO NOTHING;

    INSERT INTO organisations (slug, name, org_type, parent_id, status, org_owner, profile,
                               created_by, updated_by)
    SELECT 'network', 'Network', 'network_facilitator', NULL, 'active', u.id, '{}'::jsonb,
           'system', 'system'
      FROM users u
     WHERE u.contact_id = contact_id_of('network-admin@nf.invalid', NULL) AND u.user_type = 'admin';
  END IF;
END $$;

-- ─── O6 the Default org ────────────────────────────────────────────────────
INSERT INTO organisations (slug, name, org_type, parent_id, status, org_owner, profile,
                           created_by, updated_by)
SELECT 'default', 'Default', 'aggregator', nf.id, 'active', nf.org_owner, '{}'::jsonb,
       'system', 'system'
  FROM organisations nf
 WHERE nf.org_type = 'network_facilitator'
   AND NOT EXISTS (SELECT 1 FROM organisations WHERE slug = 'default');

-- ─── O7 every other org is an aggregator under the root ────────────────────
UPDATE organisations o
   SET org_type = 'aggregator',
       parent_id = (SELECT id FROM organisations WHERE org_type = 'network_facilitator')
 WHERE o.org_type IS NULL;
ALTER TABLE organisations ALTER COLUMN org_type SET NOT NULL;

-- ─── O8 coordinators' org ──────────────────────────────────────────────────
-- users_role_shape_chk names parent_org_id / url / locations: dropping those
-- columns would drop it silently, so it is dropped here and re-added in O12.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_shape_chk;
ALTER TABLE users ADD COLUMN IF NOT EXISTS org_id uuid;

DO $$
DECLARE
  n_default int;
BEGIN
  IF pg_temp.has_column('users', 'parent_org_id') THEN
    ALTER TABLE users DISABLE TRIGGER users_set_updated_at;
    UPDATE users u
       SET org_id = coalesce(u.parent_org_id, (SELECT id FROM organisations WHERE slug = 'default'))
     WHERE u.user_type = 'coordinator' AND u.org_id IS NULL;
    SELECT count(*) INTO n_default FROM users
     WHERE user_type = 'coordinator' AND parent_org_id IS NULL;
    ALTER TABLE users ENABLE TRIGGER users_set_updated_at;
    ALTER TABLE users DROP COLUMN parent_org_id;
    RAISE NOTICE '0028: coordinators moved into the Default org=%', n_default;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.users'::regclass
                    AND conname = 'users_org_id_organisations_id_fk') THEN
    ALTER TABLE users ADD CONSTRAINT users_org_id_organisations_id_fk
      FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE RESTRICT;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS users_org_idx ON users (org_id);

-- ─── O9–O11 org details (only while users still has `locations`) ───────────
DO $$
DECLARE
  v_default uuid;
  n_own_url int; n_own_loc int;
  n_adopt_url int; n_adopt_loc int; n_adopt_company int; n_adopt_gst int;
  n_legacy int;
BEGIN
  IF NOT pg_temp.has_column('users', 'locations') THEN
    RETURN;
  END IF;
  SELECT id INTO v_default FROM organisations WHERE slug = 'default';

  -- O9 the org's own values (copied; the profile keys and `state` stay).
  UPDATE organisations
     SET url = pg_temp.nz(profile ->> 'website')
   WHERE org_type = 'aggregator' AND url IS NULL AND pg_temp.nz(profile ->> 'website') IS NOT NULL;
  GET DIAGNOSTICS n_own_url = ROW_COUNT;

  UPDATE organisations o
     SET locations = jsonb_build_array(jsonb_build_object(
           'geo', jsonb_build_object(
             'type', 'Point',
             'coordinates', CASE
               WHEN jsonb_typeof(o.profile -> 'coordinates') = 'array'
                AND jsonb_array_length(o.profile -> 'coordinates') = 2
                AND jsonb_typeof(o.profile #> '{coordinates,0}') = 'number'
                AND jsonb_typeof(o.profile #> '{coordinates,1}') = 'number'
               THEN o.profile -> 'coordinates'
               ELSE '[0,0]'::jsonb END),
           'address', jsonb_strip_nulls(jsonb_build_object(
             'streetAddress',   pg_temp.nz(o.profile #>> '{address,streetAddress}'),
             'addressLocality', pg_temp.nz(o.profile #>> '{address,addressLocality}'),
             'addressRegion',   coalesce(pg_temp.nz(o.profile #>> '{address,addressRegion}'), pg_temp.nz(o.state)),
             'postalCode',      pg_temp.nz(o.profile #>> '{address,postalCode}'),
             'addressCountry',  pg_temp.nz(o.profile #>> '{address,addressCountry}')))))
   WHERE o.org_type = 'aggregator'
     AND o.locations = '[]'::jsonb
     AND (pg_temp.nz(o.profile #>> '{address,streetAddress}') IS NOT NULL
          OR pg_temp.nz(o.profile #>> '{address,addressLocality}') IS NOT NULL
          OR (jsonb_typeof(o.profile -> 'coordinates') = 'array'
              AND jsonb_array_length(o.profile -> 'coordinates') = 2
              AND jsonb_typeof(o.profile #> '{coordinates,0}') = 'number'
              AND jsonb_typeof(o.profile #> '{coordinates,1}') = 'number'
              AND o.profile -> 'coordinates' NOT IN ('[0,0]'::jsonb, '[0.0,0.0]'::jsonb)));
  GET DIAGNOSTICS n_own_loc = ROW_COUNT;

  -- O10 adoption: one agreed value among the org's ACTIVE coordinators.
  -- Never for the Default org.
  WITH agreed AS (
    SELECT u.org_id, min(pg_temp.nz(u.url)) AS v
      FROM users u
     WHERE u.user_type = 'coordinator' AND u.status = 'active' AND pg_temp.nz(u.url) IS NOT NULL
     GROUP BY u.org_id HAVING count(DISTINCT pg_temp.nz(u.url)) = 1)
  UPDATE organisations o SET url = a.v
    FROM agreed a
   WHERE o.id = a.org_id AND o.id <> v_default AND o.url IS NULL;
  GET DIAGNOSTICS n_adopt_url = ROW_COUNT;

  WITH agreed AS (
    SELECT u.org_id, (array_agg(u.locations))[1] AS v
      FROM users u
     WHERE u.user_type = 'coordinator' AND u.status = 'active' AND pg_temp.loc_nonempty(u.locations)
     GROUP BY u.org_id HAVING count(DISTINCT u.locations) = 1)
  UPDATE organisations o SET locations = a.v
    FROM agreed a
   WHERE o.id = a.org_id AND o.id <> v_default AND NOT pg_temp.loc_nonempty(o.locations);
  GET DIAGNOSTICS n_adopt_loc = ROW_COUNT;

  WITH agreed AS (
    SELECT u.org_id, min(pg_temp.nz(u.contact_extra ->> 'company')) AS v
      FROM users u
     WHERE u.user_type = 'coordinator' AND u.status = 'active'
       AND pg_temp.nz(u.contact_extra ->> 'company') IS NOT NULL
     GROUP BY u.org_id HAVING count(DISTINCT pg_temp.nz(u.contact_extra ->> 'company')) = 1)
  UPDATE organisations o SET legal_name = a.v
    FROM agreed a
   WHERE o.id = a.org_id AND o.id <> v_default AND o.legal_name IS NULL;
  GET DIAGNOSTICS n_adopt_company = ROW_COUNT;

  WITH agreed AS (
    SELECT u.org_id, min(pg_temp.nz(u.contact_extra ->> 'gstNumber')) AS v
      FROM users u
     WHERE u.user_type = 'coordinator' AND u.status = 'active'
       AND pg_temp.nz(u.contact_extra ->> 'gstNumber') IS NOT NULL
     GROUP BY u.org_id HAVING count(DISTINCT pg_temp.nz(u.contact_extra ->> 'gstNumber')) = 1)
  UPDATE organisations o SET gst_number = a.v
    FROM agreed a
   WHERE o.id = a.org_id AND o.id <> v_default AND o.gst_number IS NULL;
  GET DIAGNOSTICS n_adopt_gst = ROW_COUNT;

  -- O11 keep each coordinator's own value wherever it differs from what will
  -- now be rendered from the org (an empty own value is recorded as null / [],
  -- so a revert restores it exactly).
  ALTER TABLE users DISABLE TRIGGER users_set_updated_at;
  UPDATE users u
     SET legacy_org_details = nullif(
           coalesce(CASE WHEN pg_temp.nz(u.url) IS DISTINCT FROM o.url
                         THEN jsonb_build_object('url', pg_temp.nz(u.url)) END, '{}'::jsonb)
        || coalesce(CASE WHEN coalesce(u.locations, '[]'::jsonb) IS DISTINCT FROM o.locations
                         THEN jsonb_build_object('locations', coalesce(u.locations, '[]'::jsonb)) END,
                    '{}'::jsonb)
        || coalesce(CASE WHEN pg_temp.nz(u.contact_extra ->> 'company') IS DISTINCT FROM o.legal_name
                         THEN jsonb_build_object('company', pg_temp.nz(u.contact_extra ->> 'company')) END, '{}'::jsonb)
        || coalesce(CASE WHEN pg_temp.nz(u.contact_extra ->> 'gstNumber') IS DISTINCT FROM o.gst_number
                         THEN jsonb_build_object('gstNumber', pg_temp.nz(u.contact_extra ->> 'gstNumber')) END, '{}'::jsonb),
         '{}'::jsonb)
    FROM organisations o
   WHERE o.id = u.org_id AND u.user_type = 'coordinator';
  ALTER TABLE users ENABLE TRIGGER users_set_updated_at;
  SELECT count(*) INTO n_legacy FROM users WHERE legacy_org_details IS NOT NULL;

  RAISE NOTICE '0028: org own url=% locations=%; adopted url=% locations=% company=% gst=%; coordinators with legacy_org_details=%',
    n_own_url, n_own_loc, n_adopt_url, n_adopt_loc, n_adopt_company, n_adopt_gst, n_legacy;
END $$;

-- O11b the moved values leave the coordinator row.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM users WHERE contact_extra ?| ARRAY['company', 'gstNumber']) THEN
    ALTER TABLE users DISABLE TRIGGER users_set_updated_at;
    UPDATE users SET contact_extra = contact_extra - 'company' - 'gstNumber'
     WHERE contact_extra ?| ARRAY['company', 'gstNumber'];
    ALTER TABLE users ENABLE TRIGGER users_set_updated_at;
  END IF;
END $$;
ALTER TABLE users DROP COLUMN IF EXISTS url;
ALTER TABLE users DROP COLUMN IF EXISTS locations;

-- ─── O12 one rule for the row shape (re-added; see O8) ─────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.users'::regclass AND conname = 'users_role_shape_chk') THEN
    ALTER TABLE users ADD CONSTRAINT users_role_shape_chk CHECK (
      CASE user_type
        WHEN 'coordinator' THEN
              org_id IS NOT NULL
          AND signalstack_org_slug IS NOT NULL AND signalstack_org_name IS NOT NULL
          AND status IS NOT NULL AND actor_type IS NOT NULL AND consent IS NOT NULL
          AND contact_extra IS NOT NULL AND profile IS NOT NULL
        ELSE
              org_id IS NULL AND legacy_org_details IS NULL
          AND signalstack_org_slug IS NULL AND signalstack_org_name IS NULL
          AND status IS NULL AND actor_type IS NULL AND consent IS NULL
          AND contact_extra IS NULL AND profile IS NULL
          AND type IS NULL AND signalstack_org_id IS NULL
          AND invite_email IS NULL AND rejected_at IS NULL AND profile_ref IS NULL
      END);
  END IF;
END $$;

-- ─── O13 invites point at organisations.org_id ─────────────────────────────
SELECT pg_temp.ren_column('registration_invites', 'parent_org_id', 'org_id');
SELECT pg_temp.ren_constraint('registration_invites',
  'registration_invites_parent_org_id_aggregator_orgs_id_fk',
  'registration_invites_org_id_organisations_id_fk');
SELECT pg_temp.ren_index('registration_invites_parent_org_idx', 'registration_invites_org_idx');

-- ─── O14 tenant tables: org_id (the user's org at insert time) ─────────────
CREATE OR REPLACE FUNCTION tenant_set_org_id() RETURNS trigger
  LANGUAGE plpgsql AS
$fn$
BEGIN
  IF NEW.org_id IS NULL THEN
    SELECT u.org_id INTO NEW.org_id FROM users u WHERE u.id = NEW.user_id;
  END IF;
  RETURN NEW;
END;
$fn$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['bulk_uploads', 'registration_links', 'link_submissions',
                           'onboarding', 'campaign_job'] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS org_id uuid', t);
    EXECUTE format(
      'UPDATE %I t SET org_id = u.org_id FROM users u WHERE u.id = t.user_id AND t.org_id IS NULL', t);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN org_id SET NOT NULL', t);
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = to_regclass('public.' || t)
                      AND conname = t || '_org_id_organisations_id_fk') THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE RESTRICT',
        t, t || '_org_id_organisations_id_fk');
    END IF;
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (org_id)', t || '_org_idx', t);
    EXECUTE format(
      'CREATE OR REPLACE TRIGGER %I BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION tenant_set_org_id()',
      t || '_set_org_id', t);
  END LOOP;
END $$;

-- ─── O15 organisation constraints, indexes and the lock trigger ────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.organisations'::regclass
                    AND conname = 'organisations_root_shape_chk') THEN
    ALTER TABLE organisations ADD CONSTRAINT organisations_root_shape_chk
      CHECK ((org_type = 'network_facilitator') = (parent_id IS NULL));
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS organisations_single_nf
  ON organisations (org_type) WHERE org_type = 'network_facilitator';
CREATE INDEX IF NOT EXISTS organisations_parent_status_idx ON organisations (parent_id, status);

-- `org_type` never changes; an aggregator org's slug never changes (it names
-- its Keycloak group). The NF slug follows config (ensureRootOrganisation()).
CREATE OR REPLACE FUNCTION organisations_lock() RETURNS trigger
  LANGUAGE plpgsql AS
$fn$
BEGIN
  IF NEW.org_type IS DISTINCT FROM OLD.org_type THEN
    RAISE EXCEPTION 'organisations.org_type is immutable (id=%)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.org_type = 'aggregator' AND NEW.slug IS DISTINCT FROM OLD.slug THEN
    RAISE EXCEPTION 'organisations.slug is immutable for aggregator orgs (id=%)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$fn$;
CREATE OR REPLACE TRIGGER organisations_lock
  BEFORE UPDATE ON organisations
  FOR EACH ROW EXECUTE FUNCTION organisations_lock();

-- Leave the transaction as the role that started it (drizzle writes its
-- metadata right after this file).
RESET ROLE;
SELECT set_config('lock_timeout', current_setting('aggregator_dpg.prev_lock_timeout'), true),
       set_config('statement_timeout', current_setting('aggregator_dpg.prev_statement_timeout'), true);
