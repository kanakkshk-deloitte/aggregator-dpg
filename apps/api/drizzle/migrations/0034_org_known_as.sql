-- Migration 0034: table `org_known_as`; every `known_as` reset to `aggregator`.
-- * `org_known_as`: the "known as" values an org defines for its direct
--   children, one row per org. `known_as_values` is the list as the API
--   serves it, in display order: `[{"key", "name", "default"?}, ...]`. The API
--   checks the entries (key format, name length, unique keys and names, at
--   most one default) on every write; the table checks the shape and the cap
--   of 20 entries. An org with an empty list has no row. The row goes with its
--   org.
-- * `organisations.known_as` holds a key of the parent's list, or
--   `aggregator`. Keys from the instance config are in no org's list, so every
--   org is reset to `aggregator`. Only a display label changes.
--   `updated_at` is not bumped.
-- Idempotent; boot-safe while older pods keep serving.

SELECT set_config('aggregator_dpg.prev_lock_timeout', current_setting('lock_timeout'), true),
       set_config('aggregator_dpg.prev_statement_timeout', current_setting('statement_timeout'), true);
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtext('aggregator-dpg:0034_org_known_as'));

-- Run as the table owner (same rule as 0025–0033).
DO $$
DECLARE
  v_owner text;
BEGIN
  SELECT pg_get_userbyid(c.relowner) INTO v_owner
    FROM pg_class c
   WHERE c.oid = to_regclass('public.organisations');
  IF v_owner IS DISTINCT FROM current_user THEN
    IF pg_has_role(current_user, v_owner, 'MEMBER') THEN
      EXECUTE format('SET LOCAL ROLE %I', v_owner);
    ELSE
      RAISE EXCEPTION '0034: run as the owner of "organisations" (%), not as %', v_owner, current_user;
    END IF;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS org_known_as (
  org_id           uuid PRIMARY KEY REFERENCES organisations(id) ON DELETE CASCADE,
  known_as_values  jsonb NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- The acting admin's user id, as in `organisations.updated_by`.
  updated_by       text NOT NULL,
  CONSTRAINT org_known_as_values_array_chk CHECK (jsonb_typeof(known_as_values) = 'array'),
  -- KNOWN_AS_MAX_VALUES in the API.
  CONSTRAINT org_known_as_values_max_chk CHECK (jsonb_array_length(known_as_values) <= 20)
);

UPDATE organisations SET known_as = 'aggregator' WHERE known_as <> 'aggregator';

-- Leave the transaction as the role that started it (drizzle writes its
-- metadata right after this file).
RESET ROLE;
SELECT set_config('lock_timeout', current_setting('aggregator_dpg.prev_lock_timeout'), true),
       set_config('statement_timeout', current_setting('aggregator_dpg.prev_statement_timeout'), true);
