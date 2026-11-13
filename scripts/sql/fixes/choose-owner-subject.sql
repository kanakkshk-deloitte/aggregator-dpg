-- fix choose-owner-subject (F15) — at the 0022 shape, one owner (same email +
-- phone) whose orgs record different Keycloak subjects: keep the subject of
-- the given org (normally the live one) on every org of that owner.
-- Parameter: `upgrade_fix.org_id` (set by `train fix`) — the `aggregator_orgs.id` whose subject wins.
-- Prints counts only.

DO $$
DECLARE
  v_org uuid := current_setting('upgrade_fix.org_id')::uuid;
  v_sub text;
  v_email text;
  v_phone text;
  v_n int;
BEGIN
  SELECT owner_kc_sub, lower(btrim(owner_email)), owner_phone INTO v_sub, v_email, v_phone
    FROM aggregator_orgs WHERE id = v_org;
  IF v_sub IS NULL THEN
    RAISE EXCEPTION 'choose-owner-subject: org % not found or has no Keycloak subject', v_org;
  END IF;
  UPDATE aggregator_orgs
     SET owner_kc_sub = v_sub
   WHERE id <> v_org AND lower(btrim(owner_email)) = v_email
     AND owner_phone IS NOT DISTINCT FROM v_phone
     AND owner_kc_sub IS DISTINCT FROM v_sub;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'choose-owner-subject: % org(s) now share the chosen subject', v_n;
END $$;
