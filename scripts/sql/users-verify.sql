-- Verify migration 0027 (`users`), read-only. Run AFTER the train.
-- Gates (must be 0): V1–V5. Informational: V6. Counts only — never PII.
-- Run by the instance-upgrade tool (`instance-upgrade run` inside its transaction, `instance-upgrade check`).
-- Rows: `check_id | category | n` (`gate` must be 0; `info` is reported).
\set ON_ERROR_STOP on

-- The account role, read once. A session-local TEMP VIEW (the one object this
-- script creates), so every check below shares the same definition.
CREATE TEMP VIEW verify_users AS
SELECT u.id, u.contact_id, u.signalstack_org_slug, u.status,
       u.user_type = 'admin' AS is_admin
  FROM users u;

-- The org table under either name (0028 renames it `organisations`), so this
-- script stays valid at 0027 and after the rest of the train.
DO $$
BEGIN
  IF to_regclass('public.organisations') IS NOT NULL THEN
    EXECUTE 'CREATE TEMP VIEW verify_orgs AS SELECT id, org_owner AS owner FROM organisations';
  ELSE
    EXECUTE 'CREATE TEMP VIEW verify_orgs AS SELECT id, owner_user_id AS owner FROM aggregator_orgs';
  END IF;
END $$;

-- V1  orgs whose owner is missing or not an admin account
SELECT 'V1 orgs_without_admin_owner' AS check_id, 'gate' AS category, count(*) AS n
  FROM verify_orgs o LEFT JOIN verify_users u ON u.id = o.owner
 WHERE u.id IS NULL OR NOT u.is_admin;

-- V2  accounts violating the role shape (the CHECK enforces it; a guard)
SELECT 'V2 role_shape_violations' AS check_id, 'gate' AS category, count(*) AS n FROM verify_users
 WHERE (NOT is_admin AND (signalstack_org_slug IS NULL OR status IS NULL))
    OR (is_admin AND (signalstack_org_slug IS NOT NULL OR status IS NOT NULL));

-- V3  contacts referenced by no account (a GC miss)
SELECT 'V3 orphan_contacts' AS check_id, 'gate' AS category, count(*) AS n
  FROM contact c LEFT JOIN verify_users u ON u.contact_id = c.id
 WHERE u.id IS NULL;

-- V4  two accounts for one person in one role (the index enforces it; a guard)
SELECT 'V4 duplicate_accounts' AS check_id, 'gate' AS category, count(*) AS n FROM (
  SELECT contact_id, is_admin FROM verify_users GROUP BY 1, 2 HAVING count(*) > 1) d;

-- V5  admin accounts that own no org (a release missed by aggregator_orgs_owner_ad)
SELECT 'V5 admins_without_org' AS check_id, 'gate' AS category, count(DISTINCT u.id) AS n
  FROM verify_users u LEFT JOIN verify_orgs o ON o.owner = u.id
 WHERE u.is_admin AND o.id IS NULL;

-- V6  (informational) coordinators without a recorded IdP login — `enrich` fills them
SELECT 'V6 coordinators_without_identity' AS check_id, 'info' AS category, count(DISTINCT u.id) AS n
  FROM verify_users u LEFT JOIN user_identities i ON i.user_id = u.id
 WHERE NOT u.is_admin AND i.user_id IS NULL;
