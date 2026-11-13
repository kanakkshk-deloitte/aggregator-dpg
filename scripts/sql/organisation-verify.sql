-- Verify migrations 0028 (`organisations`) and 0032 (`depth`), read-only. Run AFTER the train.
-- Gates (must be 0): V1–V5, V9. Informational: V6–V8. Counts only — never PII.
-- Run by the instance-upgrade tool (`instance-upgrade run` inside its transaction, `instance-upgrade check`).
-- Rows: `check_id | category | n` (`gate` must be 0; `info` is reported).
\set ON_ERROR_STOP on

-- V1  not exactly one network-facilitator root, or an aggregator org without a parent
SELECT 'V1 root_shape' AS check_id, 'gate' AS category,
       abs((SELECT count(*) FROM organisations WHERE org_type = 'network_facilitator') - 1)
     + (SELECT count(*) FROM organisations WHERE org_type = 'aggregator' AND parent_id IS NULL) AS n;

-- V2  coordinators without an aggregator org; admins with an org
SELECT 'V2 coordinator_org_link' AS check_id, 'gate' AS category, count(*) AS n
  FROM users u LEFT JOIN organisations o ON o.id = u.org_id
 WHERE (u.user_type = 'coordinator' AND (o.id IS NULL OR o.org_type <> 'aggregator'))
    OR (u.user_type = 'admin' AND u.org_id IS NOT NULL);

-- V3  orgs whose owner is missing or not an admin account
SELECT 'V3 orgs_without_admin_owner' AS check_id, 'gate' AS category, count(*) AS n
  FROM organisations o LEFT JOIN users u ON u.id = o.org_owner
 WHERE u.id IS NULL OR u.user_type <> 'admin';

-- V4  tenant rows whose org differs from their user's (a backfill guard; valid
--     until Phase 5 lets a coordinator move orgs)
SELECT 'V4 tenant_org_mismatch' AS check_id, 'gate' AS category,
       (SELECT count(*) FROM bulk_uploads t JOIN users u ON u.id = t.user_id WHERE t.org_id <> u.org_id)
     + (SELECT count(*) FROM registration_links t JOIN users u ON u.id = t.user_id WHERE t.org_id <> u.org_id)
     + (SELECT count(*) FROM link_submissions t JOIN users u ON u.id = t.user_id WHERE t.org_id <> u.org_id)
     + (SELECT count(*) FROM onboarding t JOIN users u ON u.id = t.user_id WHERE t.org_id <> u.org_id)
     + (SELECT count(*) FROM campaign_job t JOIN users u ON u.id = t.user_id WHERE t.org_id <> u.org_id) AS n;

-- V5  the fixed Default org is missing
SELECT 'V5 no_default_org' AS check_id, 'gate' AS category,
       CASE WHEN EXISTS (SELECT 1 FROM organisations WHERE slug = 'default' AND org_type = 'aggregator')
            THEN 0 ELSE 1 END AS n;

-- V6  (informational) the root still has its placeholder owner — set ADMIN_EMAILS
--     and boot the API (ensureRootOrganisation)
SELECT 'V6 root_owner_placeholder' AS check_id, 'info' AS category, count(*) AS n
  FROM organisations o JOIN users u ON u.id = o.org_owner JOIN contact c ON c.id = u.contact_id
 WHERE o.org_type = 'network_facilitator' AND c.email = 'network-admin@nf.invalid';

-- V7  (informational) coordinators' own values kept in legacy_org_details, per key
SELECT 'V7 legacy_org_details_' || k AS check_id, 'info' AS category, count(*) AS n
  FROM users, jsonb_object_keys(legacy_org_details) k
 GROUP BY k
 ORDER BY 1;

-- V8  (informational) aggregator orgs with no url / no location
SELECT 'V8 orgs_without_details' AS check_id, 'info' AS category, count(*) AS n
  FROM organisations
 WHERE org_type = 'aggregator' AND url IS NULL AND locations = '[]'::jsonb;

-- V9  orgs whose depth is not their parent's depth + 1 (0 for the root)
SELECT 'V9 depth_chain' AS check_id, 'gate' AS category, count(*) AS n
  FROM organisations o LEFT JOIN organisations p ON p.id = o.parent_id
 WHERE (o.parent_id IS NULL AND o.depth <> 0)
    OR (o.parent_id IS NOT NULL AND o.depth IS DISTINCT FROM p.depth + 1);
