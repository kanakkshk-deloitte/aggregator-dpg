-- contact-verify-legacy.sql — READ-ONLY checks that need the legacy contact
-- columns; `scripts/contact-migrate.sh verify` runs it only while they exist
-- (until migration 0026 drops them). Counts only — never PII.
--
--   V4  drift between the legacy columns and the linked contact. Between
--       `apply` and the deploy only the old release can write them (if it is
--       started again), and 0025's sync triggers keep `contact` in step, so
--       this must be 0.
--   V6  coordinator rows whose legacy jsonb is NULL (informational).

SELECT check_id, description, n FROM (
  SELECT 1 AS ord, 'V4' AS check_id, 'coordinators whose legacy contact differs from the linked contact' AS description,
         (SELECT count(*) FROM aggregators a JOIN contact c ON c.id = a.contact_id
           WHERE a.contact IS NOT NULL
             AND (lower(btrim(a.contact->>'email')) IS DISTINCT FROM c.email
               OR (a.contact->>'phone') IS DISTINCT FROM c.phone
               OR (CASE WHEN btrim(a.contact->>'name') <> '' THEN a.contact->>'name' END) IS DISTINCT FROM c.name
               OR (a.contact - 'name' - 'phone' - 'email') IS DISTINCT FROM a.contact_extra)) AS n
  UNION ALL
  SELECT 2, 'V4', 'orgs whose legacy owner email/phone differs from the linked contact',
         (SELECT count(*) FROM aggregator_orgs o JOIN contact c ON c.id = o.contact_id
           WHERE o.owner_email IS NOT NULL
             AND (lower(btrim(o.owner_email)) IS DISTINCT FROM c.email
               OR o.owner_phone IS DISTINCT FROM c.phone))
  UNION ALL
  SELECT 3, 'V6', 'coordinators with NULL legacy contact jsonb (informational)',
         (SELECT count(*) FROM aggregators WHERE contact IS NULL)
) v
ORDER BY ord;
