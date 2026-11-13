-- Migration 0035: built-in role `org_admin` gains `orgs.onboard`.
-- * Every aggregator organisation's owner can invite and approve or reject the
--   organisations directly under it. Which organisations it reaches is decided
--   in the API (the owned organisations and their direct children).
-- * Changes a built-in role through a new migration, as 0031 requires; the
--   source of truth is BUILTIN_ROLES in packages/rbac.
-- Idempotent; boot-safe while older pods keep serving (they read the same
-- catalogue and only gain the permission on their next refresh).

SELECT set_config('aggregator_dpg.prev_lock_timeout', current_setting('lock_timeout'), true),
       set_config('aggregator_dpg.prev_statement_timeout', current_setting('statement_timeout'), true);
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtext('aggregator-dpg:0035_org_admin_onboard'));

-- Run as the table owner (same rule as 0025–0034).
DO $$
DECLARE
  v_owner text;
BEGIN
  SELECT pg_get_userbyid(c.relowner) INTO v_owner
    FROM pg_class c
   WHERE c.oid = to_regclass('public.role_permission');
  IF v_owner IS DISTINCT FROM current_user THEN
    IF pg_has_role(current_user, v_owner, 'MEMBER') THEN
      EXECUTE format('SET LOCAL ROLE %I', v_owner);
    ELSE
      RAISE EXCEPTION '0035: run as the owner of "role_permission" (%), not as %', v_owner, current_user;
    END IF;
  END IF;
END $$;

INSERT INTO role_permission (role_key, permission_key) VALUES
  ('org_admin', 'orgs.onboard')
ON CONFLICT (role_key, permission_key) DO NOTHING;

-- Leave the transaction as the role that started it (drizzle writes its
-- metadata right after this file).
RESET ROLE;
SELECT set_config('lock_timeout', current_setting('aggregator_dpg.prev_lock_timeout'), true),
       set_config('statement_timeout', current_setting('aggregator_dpg.prev_statement_timeout'), true);
