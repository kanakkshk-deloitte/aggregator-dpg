-- contact-verify.sql — READ-ONLY checks for the `contact` table (migration 0025).
--
-- Run via `scripts/contact-migrate.sh verify` after `apply` and again after
-- the release's first boot (which applies 0026). V1–V4 must be 0; the script
-- exits 1 when V1, V2 or (while the legacy columns exist) V4 is not.
-- Output is counts only — never PII.
--
--   V1  rows with no contact_id (a conflict the backfill or the best-effort
--       sync triggers declined to resolve). 0026 refuses to run while > 0.
--   V2  contacts whose id does not match contact_id_of(email, phone).
--   V3  orphan contacts (referenced by neither table).
--   V4  (scripts/sql/contact-verify-legacy.sql, only while the legacy
--       columns exist) drift between them and the linked contact.
--   V5  org-owner contacts with no name (informational; filled from Keycloak
--       by scripts/backfill-owner-contact-names.ts).
--   V6  (contact-verify-legacy.sql) coordinator rows whose legacy jsonb is
--       NULL (informational; the old release always writes it, so 0).

SELECT check_id, description, n FROM (
  SELECT 1 AS ord, 'V1' AS check_id, 'coordinators with no contact_id' AS description,
         (SELECT count(*) FROM aggregators WHERE contact_id IS NULL) AS n
  UNION ALL
  SELECT 2, 'V1', 'orgs with no contact_id',
         (SELECT count(*) FROM aggregator_orgs WHERE contact_id IS NULL)
  UNION ALL
  SELECT 3, 'V2', 'contacts whose id does not match contact_id_of(email, phone)',
         (SELECT count(*) FROM contact WHERE id <> contact_id_of(email, phone))
  UNION ALL
  SELECT 4, 'V3', 'orphan contacts',
         (SELECT count(*) FROM contact c
           WHERE NOT EXISTS (SELECT 1 FROM aggregators a WHERE a.contact_id = c.id)
             AND NOT EXISTS (SELECT 1 FROM aggregator_orgs o WHERE o.contact_id = c.id))
  UNION ALL
  SELECT 7, 'V5', 'org-owner contacts without a name (informational)',
         (SELECT count(*) FROM aggregator_orgs o JOIN contact c ON c.id = o.contact_id WHERE c.name IS NULL)

) v
ORDER BY ord;
