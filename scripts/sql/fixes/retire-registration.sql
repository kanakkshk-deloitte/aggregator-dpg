-- fix retire-registration (F1) — removes one never-approved coordinator
-- registration at the 0022 shape, so an email / phone conflict can clear.
-- Only a `pending` or `inactive` row with no tenant data is removed; anything
-- else is refused (nothing changes). The Keycloak user of that registration,
-- if any, is disabled already (never approved) and can be deleted by hand.
-- Parameter: `upgrade_fix.id` (set by `train fix`) — the `aggregators.id` to remove. Prints counts only.

DO $$
DECLARE
  v_id uuid := current_setting('upgrade_fix.id')::uuid;
  v_status text;
  v_tenant int;
BEGIN
  SELECT status::text INTO v_status FROM aggregators WHERE id = v_id;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'retire-registration: no aggregator %', v_id;
  END IF;
  IF v_status NOT IN ('pending', 'inactive') THEN
    RAISE EXCEPTION 'retire-registration: % is %, only pending / inactive registrations are removed', v_id, v_status;
  END IF;
  SELECT (SELECT count(*) FROM bulk_uploads WHERE aggregator_id = v_id)
       + (SELECT count(*) FROM registration_links WHERE aggregator_id = v_id)
       + (SELECT count(*) FROM onboarding WHERE aggregator_id = v_id)
       + (SELECT count(*) FROM campaign_job WHERE aggregator_id = v_id)
       -- these cascade on delete: count them so nothing goes silently
       + (SELECT count(*) FROM link_submissions WHERE aggregator_id = v_id)
       + (SELECT count(*) FROM participants WHERE aggregator_id = v_id)
       + (SELECT count(*) FROM aggregator_profile WHERE aggregator_id = v_id)
    INTO v_tenant;
  IF v_tenant > 0 THEN
    RAISE EXCEPTION 'retire-registration: % has % tenant row(s); resolve the conflict by correcting the contact instead', v_id, v_tenant;
  END IF;
  DELETE FROM aggregators WHERE id = v_id;
  RAISE NOTICE 'retire-registration: removed 1 % registration', v_status;
END $$;
