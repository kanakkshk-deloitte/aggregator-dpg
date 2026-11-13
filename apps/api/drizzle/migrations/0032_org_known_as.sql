-- Migration 0032: organisation `known_as` and `depth`.
-- * `organisations.known_as`: the key of the org's "known as" name, from the
--   instance's `organisation.known_as` config list. Validated on write by the
--   API, not by the database, because the list differs per instance. Existing
--   rows take the default `aggregator` without a table rewrite.
-- * `organisations.depth`: the org's distance from the network root (root 0,
--   orgs directly under it 1). Backfilled from the parent chain. A CHECK ties
--   depth 0 to the network root.
-- * A BEFORE INSERT trigger fills `depth` from the parent when an insert does
--   not send it (older API pods during a rollout, test fixtures). The store
--   always sends it.
-- Idempotent; boot-safe while older pods keep serving.

SELECT set_config('aggregator_dpg.prev_lock_timeout', current_setting('lock_timeout'), true),
       set_config('aggregator_dpg.prev_statement_timeout', current_setting('statement_timeout'), true);
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtext('aggregator-dpg:0032_org_known_as'));

-- Run as the table owner (same rule as 0025–0031).
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
      RAISE EXCEPTION '0032: run as the owner of "organisations" (%), not as %', v_owner, current_user;
    END IF;
  END IF;
END $$;

ALTER TABLE organisations ADD COLUMN IF NOT EXISTS known_as text NOT NULL DEFAULT 'aggregator';
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS depth smallint;

CREATE OR REPLACE FUNCTION organisations_fill_depth() RETURNS trigger
  LANGUAGE plpgsql AS
$fn$
BEGIN
  IF NEW.depth IS NULL THEN
    NEW.depth := CASE WHEN NEW.parent_id IS NULL THEN 0
      ELSE (SELECT depth + 1 FROM organisations WHERE id = NEW.parent_id) END;
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS organisations_fill_depth ON organisations;
CREATE TRIGGER organisations_fill_depth
  BEFORE INSERT ON organisations
  FOR EACH ROW EXECUTE FUNCTION organisations_fill_depth();

WITH RECURSIVE t(id, d) AS (
  SELECT id, 0 FROM organisations WHERE parent_id IS NULL
  UNION ALL
  SELECT o.id, t.d + 1 FROM organisations o JOIN t ON o.parent_id = t.id
)
UPDATE organisations o SET depth = t.d FROM t WHERE o.id = t.id AND o.depth IS NULL;

ALTER TABLE organisations ALTER COLUMN depth SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.organisations'::regclass
                    AND conname = 'organisations_depth_root_chk') THEN
    ALTER TABLE organisations ADD CONSTRAINT organisations_depth_root_chk
      CHECK ((org_type = 'network_facilitator') = (depth = 0));
  END IF;
END $$;

-- Leave the transaction as the role that started it (drizzle writes its
-- metadata right after this file).
RESET ROLE;
SELECT set_config('lock_timeout', current_setting('aggregator_dpg.prev_lock_timeout'), true),
       set_config('statement_timeout', current_setting('aggregator_dpg.prev_statement_timeout'), true);
