-- contact-preflight.sql — READ-ONLY pre-flight for migration 0025 (`contact`).
--
-- Run BEFORE `scripts/contact-migrate.sh apply` on an existing instance.
-- Every "blocking" count must be 0; otherwise 0025 refuses to create the table
-- (its first-creation guard re-runs the same checks) and
-- `scripts/contact-migrate.sh preflight` exits 1. Fix the listed rows by
-- hand, coordinating with Keycloak (it holds the same identity), then re-run.
-- Safe to run against the live database: it only reads the application
-- tables (the one object it creates is a session-local TEMP VIEW).
--
-- Output is row ids and counts only — never an email, phone or name — so it
-- is safe to paste into a ticket.

-- One row per person-bearing row (coordinator or org owner), with the email and
-- phone extracted once. A session-local TEMP VIEW, so both reports below read
-- the same definition; it touches no application table and is dropped at the
-- end (and with the session regardless).
CREATE TEMP VIEW preflight_src AS
  SELECT 'aggregators'::text AS tbl, true AS is_coordinator, a.id, a.status::text AS status,
         lower(btrim(j.raw_e)) AS e, j.raw_e, j.p, j.raw_name, j.extras
    FROM aggregators a
    CROSS JOIN LATERAL (
      SELECT a.contact->>'email' AS raw_e,
             a.contact->>'phone' AS p,
             a.contact->>'name' AS raw_name,
             a.contact - 'name' - 'phone' - 'email' AS extras
    ) j
  UNION ALL
  SELECT 'aggregator_orgs', false, o.id, o.status::text,
         lower(btrim(o.owner_email)), o.owner_email, o.owner_phone, NULL, NULL
    FROM aggregator_orgs o;

\echo '== contact pre-flight (blocking checks must all be 0) =='

SELECT check_name, blocking, n FROM (
  SELECT 1 AS ord, 'email_with_many_phones' AS check_name, true AS blocking,
         (SELECT count(*) FROM (SELECT e FROM preflight_src GROUP BY e HAVING count(DISTINCT coalesce(p, '')) > 1) x) AS n
  UNION ALL
  SELECT 2, 'phone_with_many_emails', true,
         (SELECT count(*) FROM (SELECT p FROM preflight_src WHERE p IS NOT NULL GROUP BY p HAVING count(DISTINCT e) > 1) x)
  UNION ALL
  SELECT 3, 'non_canonical_phone', true,
         (SELECT count(*) FROM preflight_src WHERE p IS NOT NULL AND p !~ '^\+[0-9]{10,15}$')
  UNION ALL
  SELECT 4, 'blank_email', true,
         (SELECT count(*) FROM preflight_src WHERE coalesce(e, '') = '')
  UNION ALL
  SELECT 5, 'non_ascii_email (informational)', false,
         (SELECT count(*) FROM preflight_src WHERE e ~ '[^\x01-\x7F]')
  UNION ALL
  SELECT 6, 'blank_coordinator_name (informational, becomes NULL)', false,
         (SELECT count(*) FROM preflight_src WHERE is_coordinator AND btrim(coalesce(raw_name, '')) = '')
  UNION ALL
  SELECT 7, 'rows_with_contact_extras (informational, move to contact_extra)', false,
         (SELECT count(*) FROM preflight_src WHERE extras <> '{}'::jsonb)
  UNION ALL
  SELECT 8, 'inactive_orgs_without_kc_owner (informational, usually safe to delete)', false,
         (SELECT count(*) FROM aggregator_orgs WHERE status = 'inactive' AND owner_kc_sub IS NULL)
  UNION ALL
  SELECT 9, 'mixed_case_email (informational, API will return it lowercased)', false,
         (SELECT count(*) FROM preflight_src WHERE is_coordinator AND raw_e <> e)
) c
ORDER BY ord ASC;

\echo '== rows involved in blocking email/phone conflicts (ids only) =='

WITH bad_e AS (SELECT e FROM preflight_src GROUP BY e HAVING count(DISTINCT coalesce(p, '')) > 1),
bad_p AS (SELECT p FROM preflight_src WHERE p IS NOT NULL GROUP BY p HAVING count(DISTINCT e) > 1),
flagged AS (
  SELECT tbl, id, status, e, p,
         e IN (SELECT e FROM bad_e) AS email_conflict,
         p IN (SELECT p FROM bad_p) AS phone_conflict
    FROM preflight_src
)
SELECT tbl, id, status, email_conflict, phone_conflict,
       -- groups rows of the same conflict without printing the value, or any
       -- hash of it (an unsalted hash of an email/phone can be brute-forced)
       dense_rank() OVER (ORDER BY CASE WHEN email_conflict THEN e ELSE p END) AS conflict_group
  FROM flagged
 WHERE email_conflict OR phone_conflict
 ORDER BY conflict_group ASC, tbl ASC, id ASC;

\echo '== inactive orgs without a Keycloak owner (ids only) =='

SELECT id, slug, created_at
  FROM aggregator_orgs
 WHERE status = 'inactive' AND owner_kc_sub IS NULL
 ORDER BY created_at ASC;

DROP VIEW preflight_src;
