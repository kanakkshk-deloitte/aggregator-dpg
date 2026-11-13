-- Checks before the user & org instance upgrade (0023 → the latest migration), read-only, against
-- a database at migration 0022. Run by `instance-upgrade check` (app up: what is still to
-- clear) and again by `instance-upgrade run` inside its transaction (app down: nothing
-- may have changed). Design: docs/plans/user-org-migrate-tool-simplification.md §5.
--
-- Every row is `check_id | category | n`; a `blocker` with n > 0 stops `run`.
-- Counts only — never an email, phone or name. Statements end with `;` at a
-- line end (read through `pg`, not psql); no psql variables.

-- ─── Drain (D1–D6): nothing in flight crosses the window ───────────────────

-- D1 coordinator registrations awaiting a decision (approve / reject first)
SELECT 'D1 coordinators_pending' AS check_id, 'blocker' AS category, count(*) AS n
  FROM aggregators WHERE status = 'pending';

-- D2 org registrations awaiting a decision
SELECT 'D2 orgs_pending' AS check_id, 'blocker' AS category, count(*) AS n
  FROM aggregator_orgs WHERE status = 'pending';

-- D3 bulk uploads the worker has not finished (rows not yet in Signals)
SELECT 'D3 bulk_uploads_in_flight' AS check_id, 'blocker' AS category, count(*) AS n
  FROM bulk_uploads WHERE status IN ('uploaded', 'file_validating', 'row_processing', 'finalising');

-- D4 campaign jobs queued or running
SELECT 'D4 campaign_jobs_in_flight' AS check_id, 'blocker' AS category, count(*) AS n
  FROM campaign_job WHERE status IN ('queued', 'processing');

-- D5 coordinator invites still usable (revoke, or let them be consumed);
-- a `pending` invite past `expires_at` can no longer be used and is ignored
SELECT 'D5 invites_pending' AS check_id, 'blocker' AS category, count(*) AS n
  FROM registration_invites WHERE status = 'pending' AND expires_at > now();

-- D6 bulk uploads presigned but never uploaded (`fix expire-stale-presigns`)
SELECT 'D6 bulk_presigns_never_uploaded' AS check_id, 'info' AS category, count(*) AS n
  FROM bulk_uploads WHERE status = 'pending';

-- ─── Pre-flight: what the migrations refuse or would get wrong ─────────────

-- T0d the server is PostgreSQL 14 or later (0025 uses CREATE OR REPLACE TRIGGER)
SELECT 'T0d server_older_than_14' AS check_id, 'blocker' AS category,
       (current_setting('server_version_num')::int < 140000)::int AS n;

-- T0e the role may create temporary objects (0029 and the verify scripts do)
SELECT 'T0e no_temp_privilege' AS check_id, 'blocker' AS category,
       (NOT has_database_privilege(current_database(), 'TEMP'))::int AS n;

-- T0b the session's role owns `aggregators` or is a member of its owner
-- (0025–0029 refuse otherwise)
SELECT 'T0b role_cannot_act_as_owner' AS check_id, 'blocker' AS category,
       (NOT pg_has_role(current_user, pg_get_userbyid(c.relowner), 'MEMBER'))::int AS n
  FROM pg_class c WHERE c.oid = 'public.aggregators'::regclass;

-- T0c names the train creates must be free (0025–0029 detect their first run
-- by them; a stray object would silently skip their blockers)
SELECT 'T0c names_taken' AS check_id, 'blocker' AS category,
       (SELECT count(*) FROM unnest(ARRAY['public.contact', 'public.users', 'public.user_identities',
                                          'public.organisations', 'public.consent_record']) t
         WHERE to_regclass(t) IS NOT NULL)
     + (SELECT count(*) FROM pg_type ty JOIN pg_namespace ns ON ns.oid = ty.typnamespace
         WHERE ns.nspname = 'public' AND ty.typname IN ('user_type', 'org_type', 'registration_status')) AS n;

-- F1 one email with several phones / one phone with several emails, across
-- coordinators and org owners (0025 refuses)
SELECT 'F1 email_with_many_phones' AS check_id, 'blocker' AS category, count(*) AS n FROM (
  SELECT e FROM (
    SELECT lower(btrim(contact->>'email')) AS e, contact->>'phone' AS p FROM aggregators
    UNION ALL SELECT lower(btrim(owner_email)), owner_phone FROM aggregator_orgs) s
   GROUP BY e HAVING count(DISTINCT coalesce(p, '')) > 1) d;

SELECT 'F1 phone_with_many_emails' AS check_id, 'blocker' AS category, count(*) AS n FROM (
  SELECT p FROM (
    SELECT lower(btrim(contact->>'email')) AS e, contact->>'phone' AS p FROM aggregators
    UNION ALL SELECT lower(btrim(owner_email)), owner_phone FROM aggregator_orgs) s
   WHERE p IS NOT NULL GROUP BY p HAVING count(DISTINCT e) > 1) d;

-- F2 non-canonical phones and blank emails (0025 refuses; no auto-normalising)
SELECT 'F2 non_canonical_phone' AS check_id, 'blocker' AS category, count(*) AS n FROM (
  SELECT contact->>'phone' AS p FROM aggregators
  UNION ALL SELECT owner_phone FROM aggregator_orgs) s
 WHERE p IS NOT NULL AND p !~ '^\+[0-9]{10,15}$';

SELECT 'F2 blank_email' AS check_id, 'blocker' AS category, count(*) AS n FROM (
  SELECT contact->>'email' AS e FROM aggregators
  UNION ALL SELECT owner_email FROM aggregator_orgs) s
 WHERE coalesce(btrim(e), '') = '';

-- F3 persons who are both a coordinator and an org owner (one contact, two accounts)
SELECT 'F3 owner_and_coordinator' AS check_id, 'info' AS category, count(*) AS n FROM (
  SELECT DISTINCT lower(btrim(o.owner_email)) FROM aggregator_orgs o
    JOIN aggregators a ON lower(btrim(a.contact->>'email')) = lower(btrim(o.owner_email))) d;

-- F4 orgs 0028 renames to free the Default org and the root's placeholder
SELECT 'F4 orgs_renamed_for_default_or_root' AS check_id, 'info' AS category, count(*) AS n
  FROM aggregator_orgs
 WHERE (lower(display_name) IN ('default', 'network') AND status IN ('pending', 'active'))
    OR slug IN ('default', 'network');

-- F4 a rename target already taken (`<name> (<slug>)` live, or `<slug>-r1`)
SELECT 'F4 rename_target_taken' AS check_id, 'blocker' AS category, count(*) AS n
  FROM aggregator_orgs r
 WHERE (lower(r.display_name) IN ('default', 'network') AND r.status IN ('pending', 'active')
        AND EXISTS (SELECT 1 FROM aggregator_orgs x
                     WHERE x.id <> r.id AND x.status IN ('pending', 'active')
                       AND lower(x.display_name) = lower(r.display_name || ' (' || r.slug || ')')))
    OR (r.slug IN ('default', 'network')
        AND EXISTS (SELECT 1 FROM aggregator_orgs x
                     WHERE x.id <> r.id AND x.slug = r.slug || '-r1'));

-- F5 actor_type other than 'aggregator' (the API returns 'aggregator' after)
SELECT 'F5 actor_type_not_aggregator' AS check_id, 'info' AS category, count(*) AS n
  FROM aggregators WHERE actor_type <> 'aggregator';

-- F6 orgs whose own address cannot become a Beckn location
SELECT 'F6 orgs_without_usable_address' AS check_id, 'info' AS category, count(*) AS n
  FROM aggregator_orgs o
 WHERE nullif(btrim(o.profile #>> '{address,streetAddress}'), '') IS NULL
   AND nullif(btrim(o.profile #>> '{address,addressLocality}'), '') IS NULL
   AND jsonb_typeof(o.profile -> 'coordinates') IS DISTINCT FROM 'array';

-- F7 distinct coordinator domains (compare with the network's domain ids;
-- 'both', blank and NULL become every domain)
SELECT 'F7 distinct_domain_values' AS check_id, 'info' AS category,
       count(DISTINCT btrim(type::text)) AS n
  FROM aggregators WHERE nullif(btrim(type::text), '') IS NOT NULL;

-- F8 coordinators whose parent org is missing (0028 refuses)
SELECT 'F8 coordinators_with_missing_org' AS check_id, 'blocker' AS category, count(*) AS n
  FROM aggregators a LEFT JOIN aggregator_orgs o ON o.id = a.parent_org_id
 WHERE a.parent_org_id IS NOT NULL AND o.id IS NULL;

-- F10 coordinators whose consent exists only in the column (0029 backfills
-- them); a blocker when the ledger is empty AND the session has no network
-- (`aggregator_dpg.network`, set by the tool from the deployed config)
SELECT 'F10 consent_backfilled' AS check_id, 'info' AS category, count(*) AS n
  FROM aggregators a
 WHERE NOT EXISTS (SELECT 1 FROM aggregator_consent_record c
                    WHERE c.subject_type = 'aggregator' AND c.subject_id = a.id
                      AND c.source IN ('registration', 'registration-backfill'));

SELECT 'F10 backfill_network_unknown' AS check_id, 'blocker' AS category,
       (EXISTS (SELECT 1 FROM aggregators a
                 WHERE NOT EXISTS (SELECT 1 FROM aggregator_consent_record c
                                    WHERE c.subject_type = 'aggregator' AND c.subject_id = a.id
                                      AND c.source IN ('registration', 'registration-backfill')))
        AND NOT EXISTS (SELECT 1 FROM aggregator_consent_record)
        AND nullif(btrim(coalesce(current_setting('aggregator_dpg.network', true), '')), '') IS NULL)::int AS n;

-- F10b a stored consent that is not `true`, or unparseable timestamps (0029 refuses)
SELECT 'F10b consent_not_true' AS check_id, 'blocker' AS category, count(*) AS n
  FROM aggregators WHERE consent->>'value' IS DISTINCT FROM 'true';

-- (a real cast, exactly what 0029 does; the tool pins TimeZone to UTC)
CREATE OR REPLACE FUNCTION pg_temp.train_ts_ok(v text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  PERFORM v::timestamptz;
  RETURN v IS NOT NULL;
EXCEPTION WHEN others THEN
  RETURN false;
END $$;

SELECT 'F10b consent_bad_timestamp' AS check_id, 'blocker' AS category, count(*) AS n
  FROM aggregators
 WHERE NOT pg_temp.train_ts_ok(consent->>'given_at')
    OR NOT pg_temp.train_ts_ok(consent->>'valid_till');

-- F10c contact keys 0029 cannot move (company / gstNumber move to the org in
-- 0028; alternatePhone must be a string)
SELECT 'F10c contact_extra_unmovable' AS check_id, 'blocker' AS category, count(*) AS n
  FROM aggregators
 WHERE contact - 'name' - 'phone' - 'email' - 'company' - 'gstNumber' - 'alternatePhone' <> '{}'::jsonb
    OR coalesce(jsonb_typeof(contact->'alternatePhone'), 'null') NOT IN ('string', 'null');

-- F10d ledger rows with a subject type 0029 cannot map
SELECT 'F10d ledger_unknown_subject_type' AS check_id, 'blocker' AS category, count(*) AS n
  FROM aggregator_consent_record WHERE subject_type NOT IN ('aggregator', 'org');

-- F11 owners of several orgs (one admin account owns them all)
SELECT 'F11 owners_of_several_orgs' AS check_id, 'info' AS category, count(*) AS n FROM (
  SELECT lower(btrim(owner_email)) FROM aggregator_orgs
   GROUP BY lower(btrim(owner_email)), owner_phone HAVING count(*) > 1) d;

-- F12 size (rows; F12b the database in MB — the whole train is one
-- transaction, so keep at least this much free disk / WAL headroom)
SELECT 'F12 rows_to_migrate' AS check_id, 'info' AS category,
       (SELECT count(*) FROM aggregators) + (SELECT count(*) FROM aggregator_orgs)
     + (SELECT count(*) FROM aggregator_consent_record) + (SELECT count(*) FROM registration_invites) AS n;

SELECT 'F12b database_mb' AS check_id, 'info' AS category,
       pg_database_size(current_database()) / (1024 * 1024) AS n;

-- F13 coordinators of a real org whose url / locations / company / GST differ
-- from another active member's (the org adopts nothing; they keep their own
-- values as a fallback) — and every flat coordinator (F14: into Default)
SELECT 'F13 coordinators_seeing_org_values' AS check_id, 'info' AS category, count(*) AS n FROM (
  SELECT a.parent_org_id
    FROM aggregators a
   WHERE a.status = 'active' AND a.parent_org_id IS NOT NULL
   GROUP BY a.parent_org_id
  HAVING count(DISTINCT coalesce(nullif(btrim(a.url), ''), '')) > 1
      OR count(DISTINCT coalesce(a.locations, '[]'::jsonb)) > 1
      OR count(DISTINCT coalesce(nullif(btrim(a.contact->>'company'), ''), '')) > 1
      OR count(DISTINCT coalesce(nullif(btrim(a.contact->>'gstNumber'), ''), '')) > 1) d;

SELECT 'F14 coordinators_into_default' AS check_id, 'info' AS category, count(*) AS n
  FROM aggregators WHERE parent_org_id IS NULL;

-- F15 one owner with two Keycloak subjects / F15b one subject on two owners (0027 refuses)
SELECT 'F15 owner_with_several_subjects' AS check_id, 'blocker' AS category, count(*) AS n FROM (
  SELECT lower(btrim(owner_email)) FROM aggregator_orgs WHERE owner_kc_sub IS NOT NULL
   GROUP BY lower(btrim(owner_email)), owner_phone HAVING count(DISTINCT owner_kc_sub) > 1) d;

SELECT 'F15b subject_on_several_owners' AS check_id, 'blocker' AS category, count(*) AS n FROM (
  SELECT owner_kc_sub FROM aggregator_orgs WHERE owner_kc_sub IS NOT NULL
   GROUP BY owner_kc_sub
  HAVING count(DISTINCT lower(btrim(owner_email)) || ':' || coalesce(owner_phone, '')) > 1) d;

-- F16 functions, triggers, views, rules and policies outside the migrations
-- that name a renamed or dropped table / column / type
SELECT 'F16 unknown_dependent_objects' AS check_id, 'blocker' AS category, count(*) AS n FROM (
  SELECT p.proname AS name FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public'
     AND p.proname NOT IN ('set_updated_at', 'aggregators_lock_slug')
     AND p.prosrc ~* '\m(aggregators|aggregator_orgs|aggregator_profile|participants|aggregator_consent_record|display_name|parent_org_id|owner_email|owner_phone|owner_kc_sub|contact_phone|contact_email|org_slug|actor_org_id|aggregator_id|aggregator_status|aggregator_actor_type|actor_type|invite_email)\M'
  UNION ALL
  SELECT v.viewname FROM pg_views v
   WHERE v.schemaname = 'public'
     AND v.definition ~* '\m(aggregators|aggregator_orgs|aggregator_profile|participants|aggregator_consent_record)\M'
  UNION ALL
  SELECT m.matviewname FROM pg_matviews m WHERE m.schemaname = 'public'
  UNION ALL
  SELECT r.rulename FROM pg_rules r WHERE r.schemaname = 'public'
  UNION ALL
  SELECT pol.policyname FROM pg_policies pol WHERE pol.schemaname = 'public'
  UNION ALL
  SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'public' AND NOT t.tgisinternal
     AND t.tgname NOT IN ('aggregators_lock_slug', 'aggregators_set_updated_at',
                          'aggregator_orgs_set_updated_at', 'aggregator_profile_set_updated_at',
                          'bulk_uploads_set_updated_at', 'registration_links_set_updated_at',
                          'campaign_job_set_updated_at')) d;

-- F16b objects OUTSIDE `public` that depend on a table the train renames or
-- drops: views / rules, foreign keys, and functions naming them
SELECT 'F16b dependents_outside_public' AS check_id, 'blocker' AS category, count(*) AS n FROM (
  SELECT DISTINCT d.objid
    FROM pg_depend d
    JOIN pg_rewrite rw ON d.classid = 'pg_rewrite'::regclass AND rw.oid = d.objid
    JOIN pg_class v ON v.oid = rw.ev_class
    JOIN pg_namespace ns ON ns.oid = v.relnamespace
   WHERE d.refobjid IN (SELECT oid FROM pg_class
                         WHERE relnamespace = 'public'::regnamespace
                           AND relname IN ('aggregators', 'aggregator_orgs', 'aggregator_profile',
                                           'participants', 'aggregator_consent_record'))
     AND ns.nspname <> 'public'
  UNION ALL
  SELECT c.oid FROM pg_constraint c JOIN pg_namespace ns ON ns.oid = c.connamespace
   WHERE c.contype = 'f' AND ns.nspname NOT IN ('public', 'pg_catalog', 'information_schema')
     AND c.confrelid IN (SELECT oid FROM pg_class
                          WHERE relnamespace = 'public'::regnamespace
                            AND relname IN ('aggregators', 'aggregator_orgs', 'aggregator_profile',
                                            'participants', 'aggregator_consent_record'))
  UNION ALL
  SELECT p.oid FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname NOT IN ('public', 'pg_catalog', 'information_schema', 'drizzle')
     AND ns.nspname NOT LIKE 'pg\_%'
     AND p.prosrc ~* '\m(aggregators|aggregator_orgs|aggregator_profile|aggregator_consent_record)\M') d;

-- F23 replication / scheduling that may name these tables (publications,
-- replication slots, subscriptions, pg_cron jobs): review before the window
SELECT 'F23 replication_or_cron_objects' AS check_id, 'info' AS category,
       (SELECT count(*) FROM pg_publication) + (SELECT count(*) FROM pg_replication_slots)
     -- pg_stat_subscription, not pg_subscription: readable without superuser
     + (SELECT count(DISTINCT subid) FROM pg_stat_subscription)
     + CASE WHEN to_regclass('cron.job') IS NULL THEN 0
            ELSE (xpath('/row/n/text()', query_to_xml('SELECT count(*) AS n FROM cron.job', false, true, '')))[1]::text::int
       END AS n;

-- F18 rows of the local participants mirror 0024 drops (informational, T-6;
-- expected 0 since #819)
SELECT 'F18 participants_rows' AS check_id, 'info' AS category, count(*) AS n FROM participants;

-- F22 aggregator_profile rows holding data 0023 drops (beyond the empty stub)
SELECT 'F22 aggregator_profile_with_data' AS check_id, 'blocker' AS category, count(*) AS n
  FROM aggregator_profile
 WHERE contact_name IS NOT NULL OR personas <> '[]'::jsonb OR services <> '[]'::jsonb
    OR verified_certificate <> '[]'::jsonb OR profile_completed_at IS NOT NULL;
