-- Completeness counts BEFORE the train (0022 shape), read-only. `instance-upgrade run`
-- compares them, inside its transaction, with instance-upgrade-counts-after.sql: every
-- key must agree. Counts and fingerprints only. Rows are `key | n`.
SELECT 'coordinators' AS key, count(*) AS n FROM aggregators;
SELECT 'orgs' AS key, count(*) AS n FROM aggregator_orgs;
SELECT 'persons' AS key, count(*) AS n FROM (
  SELECT lower(btrim(contact->>'email')) || ':' || coalesce(contact->>'phone', '') FROM aggregators
  UNION SELECT lower(btrim(owner_email)) || ':' || coalesce(owner_phone, '') FROM aggregator_orgs) p;
SELECT 'single_domain' AS key, count(*) AS n
  FROM aggregators WHERE nullif(btrim(type::text), '') IS NOT NULL AND btrim(type::text) <> 'both';
SELECT 'alternate_phones' AS key, count(*) AS n
  FROM aggregators WHERE jsonb_typeof(contact->'alternatePhone') = 'string';
SELECT 'invited' AS key, count(*) AS n FROM aggregators WHERE invite_email IS NOT NULL;
SELECT 'consent_rows' AS key,
       (SELECT count(*) FROM aggregator_consent_record)
     + (SELECT count(*) FROM aggregators a
         WHERE NOT EXISTS (SELECT 1 FROM aggregator_consent_record c
                            WHERE c.subject_type = 'aggregator' AND c.subject_id = a.id
                              AND c.source IN ('registration', 'registration-backfill'))) AS n;
SELECT 'bulk_uploads' AS key, count(*) AS n FROM bulk_uploads;
SELECT 'registration_links' AS key, count(*) AS n FROM registration_links;
SELECT 'link_submissions' AS key, count(*) AS n FROM link_submissions;
SELECT 'onboarding' AS key, count(*) AS n FROM onboarding;
SELECT 'campaign_job' AS key, count(*) AS n FROM campaign_job;
SELECT 'registration_invites' AS key, count(*) AS n FROM registration_invites;

-- Fingerprints of `updated_at` / `rejected_at` of every pre-existing row: the
-- train must not touch them (the rejection cooling window reads `rejected_at`).
SELECT 'coordinators_timestamps' AS key, ('x' || left(md5(coalesce(string_agg(id::text || ':' || coalesce(extract(epoch FROM updated_at)::text, '-') || ':' || coalesce(extract(epoch FROM rejected_at)::text, '-'), ',' ORDER BY id), '')), 12))::bit(48)::bigint AS n FROM aggregators;
SELECT 'orgs_timestamps' AS key, ('x' || left(md5(coalesce(string_agg(id::text || ':' || coalesce(extract(epoch FROM updated_at)::text, '-') || ':' || coalesce(extract(epoch FROM rejected_at)::text, '-'), ',' ORDER BY id), '')), 12))::bit(48)::bigint AS n FROM aggregator_orgs;
SELECT 'bulk_uploads_timestamps' AS key, ('x' || left(md5(coalesce(string_agg(id::text || ':' || coalesce(extract(epoch FROM updated_at)::text, '-'), ',' ORDER BY id), '')), 12))::bit(48)::bigint AS n FROM bulk_uploads;
SELECT 'registration_links_timestamps' AS key, ('x' || left(md5(coalesce(string_agg(id::text || ':' || coalesce(extract(epoch FROM updated_at)::text, '-'), ',' ORDER BY id), '')), 12))::bit(48)::bigint AS n FROM registration_links;
SELECT 'campaign_job_timestamps' AS key, ('x' || left(md5(coalesce(string_agg(id::text || ':' || coalesce(extract(epoch FROM updated_at)::text, '-'), ',' ORDER BY id), '')), 12))::bit(48)::bigint AS n FROM campaign_job;
