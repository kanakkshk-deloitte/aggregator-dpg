-- RBAC backfill: give every active coordinator the additional roles that keep
-- what coordinators can do before RBAC is enforced — PII Access (decrypted
-- profile export, time-limited) and Data Export (masked lists) — in their own
-- organisation (users.org_id). docs/rbac/rbac-implementation-plan.md, open item 1.
--
-- Run ONCE per instance, after the API has started at least once with
-- RBAC_MODE=log (that syncs the built-in roles) and BEFORE RBAC_MODE=enforce:
--   psql "$DATABASE_URL" -v pii_days=90 -f scripts/sql/rbac-backfill-roles.sql
-- Options: pii_days (default 90, at most the role's max_days), with_pii=0 to
-- skip PII Access, with_export=0 to skip Data Export.
-- Idempotent: a coordinator already holding a live assignment of a role in its
-- organisation is skipped for that role. Each assignment is audited
-- (`role.backfill`, granted_by NULL = system). Counts only in the output — never PII.
\set ON_ERROR_STOP on
\if :{?pii_days}
\else
  \set pii_days 90
\endif
\if :{?with_pii}
\else
  \set with_pii 1
\endif
\if :{?with_export}
\else
  \set with_export 1
\endif

BEGIN;

-- The built-in roles must be synced (the API does it at start with RBAC on).
DO $$
BEGIN
  IF (SELECT count(*) FROM role WHERE key IN ('pii_access', 'data_export')) <> 2 THEN
    RAISE EXCEPTION 'rbac backfill: roles pii_access and data_export are missing — start the API once with RBAC_MODE=log first';
  END IF;
END $$;

-- PII Access may not outlast its role's longest validity.
SELECT set_config('rbac_backfill.pii_days', :'pii_days', true);
DO $$
BEGIN
  IF current_setting('rbac_backfill.pii_days')::int
     > coalesce((SELECT max_days FROM role WHERE key = 'pii_access'), 2147483647) THEN
    RAISE EXCEPTION 'rbac backfill: pii_days exceeds the pii_access role''s max_days';
  END IF;
END $$;

WITH wanted AS (
  SELECT 'pii_access'::text AS role_key, make_interval(days => :pii_days::int) AS validity
   WHERE :with_pii::int = 1
  UNION ALL
  SELECT 'data_export', NULL::interval
   WHERE :with_export::int = 1
),
targets AS (
  SELECT u.id AS user_id, u.org_id, w.role_key, w.validity
    FROM users u
    CROSS JOIN wanted w
   WHERE u.user_type = 'coordinator'
     AND u.status = 'active'
     AND u.org_id IS NOT NULL
     AND NOT EXISTS (
           SELECT 1 FROM user_role r
            WHERE r.user_id = u.id
              AND r.role_key = w.role_key
              AND r.org_id = u.org_id
              AND r.revoked_at IS NULL
              AND (r.expires_at IS NULL OR r.expires_at > now()))
),
assigned AS (
  INSERT INTO user_role (user_id, role_key, org_id, granted_by, expires_at)
  SELECT user_id, role_key, org_id, NULL,
         CASE WHEN validity IS NULL THEN NULL ELSE now() + validity END
    FROM targets
  RETURNING user_id, role_key, org_id
),
audited AS (
  INSERT INTO iam_audit (event, actor_user_id, target_user_id, target_org_id, details)
  SELECT 'role.backfill', NULL, a.user_id, a.org_id,
         jsonb_build_object('role', a.role_key,
                            'days', CASE WHEN a.role_key = 'pii_access' THEN :pii_days::int END)
    FROM assigned a
  RETURNING 1
)
SELECT (SELECT count(*) FROM assigned WHERE role_key = 'pii_access') AS pii_access_assigned,
       (SELECT count(*) FROM assigned WHERE role_key = 'data_export') AS data_export_assigned,
       (SELECT count(*) FROM audited) AS audit_rows;

COMMIT;
