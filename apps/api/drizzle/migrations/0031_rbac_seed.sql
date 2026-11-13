-- Migration 0031 — RBAC built-in seed (catalogue:
-- docs/rbac/rbac-permissions-and-roles.md §2–§3). Idempotent seed of the
-- permission catalogue (from packages/rbac CAPABILITIES; a drift test asserts
-- it) and the six built-in roles (BUILTIN_ROLES) plus their permissions. A
-- later release changes a built-in role with a NEW migration, never by editing
-- this one. Order: permission -> role -> role_permission (foreign keys).
-- Generated; do not hand-edit — regenerate from packages/rbac.

SELECT set_config('aggregator_dpg.prev_lock_timeout', current_setting('lock_timeout'), true),
       set_config('aggregator_dpg.prev_statement_timeout', current_setting('statement_timeout'), true);
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtext('aggregator-dpg:0031_rbac_seed'));

-- Run as the table owner (same rule as 0025–0030).
DO $$
DECLARE
  v_owner text;
BEGIN
  SELECT pg_get_userbyid(c.relowner) INTO v_owner
    FROM pg_class c
   WHERE c.oid = to_regclass('public.permission');
  IF v_owner IS DISTINCT FROM current_user THEN
    IF pg_has_role(current_user, v_owner, 'MEMBER') THEN
      EXECUTE format('SET LOCAL ROLE %I', v_owner);
    ELSE
      RAISE EXCEPTION '0031: run as the owner of "permission" (%), not as %', v_owner, current_user;
    END IF;
  END IF;
END $$;

INSERT INTO permission (key, resource, action, description, sensitive) VALUES
  ('profiles.view', 'profiles', 'view', 'See masked profiles, dashboards, metrics', false),
  ('profiles.export', 'profiles', 'export', 'Download masked lists', false),
  ('profiles.view_pii', 'profiles', 'view_pii', 'See and export decrypted details', true),
  ('profiles.onboard', 'profiles', 'onboard', 'Links, bulk uploads, forms; edit and pause profiles', false),
  ('profiles.verify', 'profiles', 'verify', 'Mark profiles verified', false),
  ('profiles.retire', 'profiles', 'retire', 'Retire a profile (irreversible)', false),
  ('profiles.move', 'profiles', 'move', 'Move profiles to another aggregator', false),
  ('profiles.act_on_behalf', 'profiles', 'act_on_behalf', 'Connect or apply for a profile''s owner', false),
  ('campaigns.run', 'campaigns', 'run', 'Email and voice campaigns', true),
  ('orgs.onboard', 'organisations', 'onboard', 'Invite and approve child organisations', false),
  ('orgs.block', 'organisations', 'block', 'Suspend or remove a child organisation', false),
  ('org.manage', 'organisation', 'manage', 'Organisation profile; invite and approve coordinators; assign their roles', false),
  ('contact.unmask', 'contacts', 'unmask', 'See the full email and phone of users in reach', true),
  ('agreement.manage', 'agreements', 'manage', 'Create and link agreements (terms, privacy, consent)', false),
  ('network.administer', 'network', 'administer', 'Network configuration, service clients, audit, bans; assign admin roles', false)
ON CONFLICT (key) DO UPDATE
  SET resource = EXCLUDED.resource, action = EXCLUDED.action,
      description = EXCLUDED.description, sensitive = EXCLUDED.sensitive,
      deprecated = false;

INSERT INTO role (key, name, description, is_builtin, account_type, base_for,
                  assignable_org_types, assigned_by, max_days) VALUES
  ('coordinator', 'Coordinator', 'An approved coordinator of an aggregator organisation.', true, 'coordinator', 'org_member', '{aggregator}', NULL, NULL),
  ('data_export', 'Data Export', 'Downloads masked profile lists.', true, 'coordinator', NULL, '{aggregator}', 'org.manage', NULL),
  ('network_admin', 'Network Admin', 'The root organisation''s owner; administers the network.', true, 'admin', 'root_owner', '{network_facilitator}', NULL, NULL),
  ('org_admin', 'Org Admin', 'An aggregator organisation''s owner.', true, 'admin', 'org_owner', '{aggregator}', NULL, NULL),
  ('org_onboarder', 'Org Onboarder', 'Onboards other organisations (Super Aggregator).', true, 'admin', NULL, '{aggregator}', 'network.administer', NULL),
  ('pii_access', 'PII Access', 'Sees and exports decrypted profile details.', true, 'coordinator', NULL, '{aggregator}', 'org.manage', 90)
ON CONFLICT (key) DO UPDATE
  SET name = EXCLUDED.name, description = EXCLUDED.description,
      is_builtin = EXCLUDED.is_builtin, account_type = EXCLUDED.account_type,
      base_for = EXCLUDED.base_for, assignable_org_types = EXCLUDED.assignable_org_types,
      assigned_by = EXCLUDED.assigned_by, max_days = EXCLUDED.max_days,
      updated_at = now();

INSERT INTO role_permission (role_key, permission_key) VALUES
  ('coordinator', 'profiles.view'),
  ('coordinator', 'profiles.onboard'),
  ('coordinator', 'campaigns.run'),
  ('data_export', 'profiles.export'),
  ('network_admin', 'profiles.view'),
  ('network_admin', 'profiles.export'),
  ('network_admin', 'profiles.onboard'),
  ('network_admin', 'profiles.verify'),
  ('network_admin', 'profiles.retire'),
  ('network_admin', 'profiles.move'),
  ('network_admin', 'campaigns.run'),
  ('network_admin', 'orgs.onboard'),
  ('network_admin', 'orgs.block'),
  ('network_admin', 'contact.unmask'),
  ('network_admin', 'agreement.manage'),
  ('network_admin', 'network.administer'),
  ('org_admin', 'profiles.view'),
  ('org_admin', 'profiles.export'),
  ('org_admin', 'profiles.onboard'),
  ('org_admin', 'profiles.retire'),
  ('org_admin', 'campaigns.run'),
  ('org_admin', 'org.manage'),
  ('org_admin', 'contact.unmask'),
  ('org_onboarder', 'profiles.verify'),
  ('org_onboarder', 'profiles.move'),
  ('org_onboarder', 'orgs.onboard'),
  ('pii_access', 'profiles.view_pii')
ON CONFLICT (role_key, permission_key) DO NOTHING;

-- Leave the transaction as the role that started it (drizzle writes its
-- metadata right after this file).
RESET ROLE;
SELECT set_config('lock_timeout', current_setting('aggregator_dpg.prev_lock_timeout'), true),
       set_config('statement_timeout', current_setting('aggregator_dpg.prev_statement_timeout'), true);
