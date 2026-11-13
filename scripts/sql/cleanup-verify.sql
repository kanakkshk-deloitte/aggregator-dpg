-- Verify after migration 0029 (`cleanup`), read-only. Counts only — never
-- PII. Run by the instance-upgrade tool (`instance-upgrade run` inside its transaction, `instance-upgrade check`).
--
-- Gates (must be 0): V1, V2, V3, V5, V6, V7. Informational: V4.
-- Rows: `check_id | category | n` (`gate` must be 0; `info` is reported).
\set ON_ERROR_STOP on

-- V1  coordinators with no linked registration consent row
SELECT 'V1 coordinator_without_consent' AS check_id, 'gate' AS category, count(*) AS n
  FROM users u
 WHERE u.user_type = 'coordinator'
   AND NOT EXISTS (SELECT 1 FROM consent_record c
                    WHERE c.user_id = u.id
                      AND c.source IN ('registration', 'registration-backfill')
                      AND c.valid_till IS NOT NULL);

-- V2  ledger links disagreeing with the audit key (the CHECK guarantees 0)
SELECT 'V2 ledger_link_mismatch' AS check_id, 'gate' AS category, count(*) AS n
  FROM consent_record
 WHERE (user_id IS NOT NULL AND (subject_type <> 'user' OR subject_id <> user_id))
    OR (org_id IS NOT NULL AND (subject_type <> 'organisation' OR subject_id <> org_id))
    OR subject_type NOT IN ('user', 'organisation');

-- V3  serves holding a NULL or an empty string (the CHECK guarantees no NULL)
SELECT 'V3 serves_bad_element' AS check_id, 'gate' AS category, count(*) AS n
  FROM users WHERE array_position(serves, NULL) IS NOT NULL OR '' = ANY (serves);

-- V4  ledger rows with both links NULL (subject deleted; informational)
SELECT 'V4 ledger_unlinked' AS check_id, 'info' AS category, count(*) AS n
  FROM consent_record WHERE user_id IS NULL AND org_id IS NULL;

-- V5  admin accounts carrying coordinator-only values (the CHECK guarantees 0)
SELECT 'V5 admin_with_coordinator_values' AS check_id, 'gate' AS category, count(*) AS n
  FROM users
 WHERE user_type = 'admin'
   AND (serves <> '{}' OR alternate_phone IS NOT NULL OR invite_id IS NOT NULL);

-- V6  invite links pointing at an invite of another org
SELECT 'V6 invite_org_mismatch' AS check_id, 'gate' AS category, count(*) AS n
  FROM users u JOIN registration_invites i ON i.jti = u.invite_id
 WHERE i.org_id IS DISTINCT FROM u.org_id;

-- V7  ledger rows whose subject still exists but whose link is NULL
SELECT 'V7 ledger_link_missing' AS check_id, 'gate' AS category, count(*) AS n
  FROM consent_record c
 WHERE (c.subject_type = 'user' AND c.user_id IS NULL
        AND EXISTS (SELECT 1 FROM users u WHERE u.id = c.subject_id))
    OR (c.subject_type = 'organisation' AND c.org_id IS NULL
        AND EXISTS (SELECT 1 FROM organisations o WHERE o.id = c.subject_id));
