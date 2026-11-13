-- Completeness counts AFTER the train (0029 shape), read-only; the keys match
-- instance-upgrade-counts-before.sql. Counts only. Rows are `key | n`.
SELECT 'coordinators' AS key, count(*) AS n FROM users WHERE user_type = 'coordinator';
SELECT 'orgs' AS key, count(*) AS n
  FROM organisations WHERE org_type = 'aggregator' AND slug <> 'default';
SELECT 'persons' AS key, count(*) AS n FROM contact WHERE email <> 'network-admin@nf.invalid';
SELECT 'single_domain' AS key, count(*) AS n
  FROM users WHERE user_type = 'coordinator' AND cardinality(serves) > 0;
SELECT 'alternate_phones' AS key, count(*) AS n FROM users WHERE alternate_phone IS NOT NULL;
SELECT 'invited' AS key, count(*) AS n
  FROM users WHERE invite_id IS NOT NULL OR profile ? 'legacy_invite_email';
SELECT 'consent_rows' AS key, count(*) AS n FROM consent_record;
SELECT 'bulk_uploads' AS key, count(*) AS n FROM bulk_uploads WHERE org_id IS NOT NULL;
SELECT 'registration_links' AS key, count(*) AS n FROM registration_links WHERE org_id IS NOT NULL;
SELECT 'link_submissions' AS key, count(*) AS n FROM link_submissions WHERE org_id IS NOT NULL;
SELECT 'onboarding' AS key, count(*) AS n FROM onboarding WHERE org_id IS NOT NULL;
SELECT 'campaign_job' AS key, count(*) AS n FROM campaign_job WHERE org_id IS NOT NULL;
SELECT 'registration_invites' AS key, count(*) AS n FROM registration_invites;

-- Fingerprints of `updated_at` / `rejected_at` (keys of instance-upgrade-counts-before.sql).
SELECT 'coordinators_timestamps' AS key, ('x' || left(md5(coalesce(string_agg(id::text || ':' || coalesce(extract(epoch FROM updated_at)::text, '-') || ':' || coalesce(extract(epoch FROM rejected_at)::text, '-'), ',' ORDER BY id), '')), 12))::bit(48)::bigint AS n
  FROM users WHERE user_type = 'coordinator';
SELECT 'orgs_timestamps' AS key, ('x' || left(md5(coalesce(string_agg(id::text || ':' || coalesce(extract(epoch FROM updated_at)::text, '-') || ':' || coalesce(extract(epoch FROM rejected_at)::text, '-'), ',' ORDER BY id), '')), 12))::bit(48)::bigint AS n
  FROM organisations WHERE org_type = 'aggregator' AND slug <> 'default';
SELECT 'bulk_uploads_timestamps' AS key, ('x' || left(md5(coalesce(string_agg(id::text || ':' || coalesce(extract(epoch FROM updated_at)::text, '-'), ',' ORDER BY id), '')), 12))::bit(48)::bigint AS n FROM bulk_uploads;
SELECT 'registration_links_timestamps' AS key, ('x' || left(md5(coalesce(string_agg(id::text || ':' || coalesce(extract(epoch FROM updated_at)::text, '-'), ',' ORDER BY id), '')), 12))::bit(48)::bigint AS n FROM registration_links;
SELECT 'campaign_job_timestamps' AS key, ('x' || left(md5(coalesce(string_agg(id::text || ':' || coalesce(extract(epoch FROM updated_at)::text, '-'), ',' ORDER BY id), '')), 12))::bit(48)::bigint AS n FROM campaign_job;
