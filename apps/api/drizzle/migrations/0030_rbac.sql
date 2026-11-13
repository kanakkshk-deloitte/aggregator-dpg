-- Migration 0030 — RBAC: permissions, roles and role assignments (design:
-- docs/rbac/rbac-design-aggregator.md §1; catalogue:
-- docs/rbac/rbac-permissions-and-roles.md).
-- * `permission`: the catalogue the API checks; synced from code at start.
-- * `role`: a named set of permissions; built-in rows come from
--   config/rbac.yaml, custom rows only from the roles API.
-- * `role_permission`: which permissions a role holds.
-- * `user_role`: an additional role a user holds in an organisation, with an
--   optional expiry. Base roles are not stored: they follow membership
--   (`users.org_id`, `organisations.org_owner`; decision D7).
-- * `iam_audit`: append-only record of role assignments and role changes.
-- Additive and idempotent; applied at boot after the user & org release train.

SELECT set_config('aggregator_dpg.prev_lock_timeout', current_setting('lock_timeout'), true),
       set_config('aggregator_dpg.prev_statement_timeout', current_setting('statement_timeout'), true);
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtext('aggregator-dpg:0030_rbac'));

-- Run as the table owner (same rule as 0025–0029).
DO $$
DECLARE
  v_owner text;
BEGIN
  SELECT pg_get_userbyid(c.relowner) INTO v_owner
    FROM pg_class c
   WHERE c.oid = to_regclass('public.users');
  IF v_owner IS DISTINCT FROM current_user THEN
    IF pg_has_role(current_user, v_owner, 'MEMBER') THEN
      EXECUTE format('SET LOCAL ROLE %I', v_owner);
    ELSE
      RAISE EXCEPTION '0030: run as the owner of "users" (%), not as %', v_owner, current_user;
    END IF;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS permission (
  key          text PRIMARY KEY,
  resource     text NOT NULL,
  action       text NOT NULL,
  description  text NOT NULL,
  sensitive    boolean NOT NULL DEFAULT false,
  deprecated   boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS role (
  key                   text PRIMARY KEY,
  name                  text NOT NULL,
  description           text NOT NULL DEFAULT '',
  is_builtin            boolean NOT NULL DEFAULT false,
  account_type          user_type NOT NULL,
  base_for              text,
  assignable_org_types  org_type[] NOT NULL,
  assigned_by           text REFERENCES permission(key) ON DELETE RESTRICT,
  max_days              integer,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT role_key_chk CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT role_base_for_chk CHECK (base_for IS NULL OR base_for IN ('org_member', 'org_owner', 'root_owner')),
  CONSTRAINT role_base_shape_chk CHECK (
    base_for IS NULL OR (is_builtin AND assigned_by IS NULL AND max_days IS NULL)
  ),
  CONSTRAINT role_additional_shape_chk CHECK (base_for IS NOT NULL OR assigned_by IS NOT NULL),
  CONSTRAINT role_max_days_chk CHECK (max_days IS NULL OR max_days > 0),
  CONSTRAINT role_org_types_chk CHECK (cardinality(assignable_org_types) > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS role_base_for_unique ON role (base_for) WHERE base_for IS NOT NULL;

CREATE TABLE IF NOT EXISTS role_permission (
  role_key        text NOT NULL REFERENCES role(key) ON DELETE CASCADE ON UPDATE CASCADE,
  permission_key  text NOT NULL REFERENCES permission(key) ON DELETE RESTRICT,
  PRIMARY KEY (role_key, permission_key)
);

CREATE TABLE IF NOT EXISTS user_role (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_key    text NOT NULL REFERENCES role(key) ON DELETE RESTRICT ON UPDATE CASCADE,
  org_id      uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  granted_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz,
  revoked_at  timestamptz,
  revoked_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT user_role_expiry_chk CHECK (expires_at IS NULL OR expires_at > granted_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS user_role_live_unique
  ON user_role (user_id, role_key, org_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS user_role_user_idx ON user_role (user_id);
CREATE INDEX IF NOT EXISTS user_role_org_idx ON user_role (org_id);

CREATE TABLE IF NOT EXISTS iam_audit (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  at             timestamptz NOT NULL DEFAULT now(),
  event          text NOT NULL,
  actor_user_id  uuid,
  target_user_id uuid,
  target_org_id  uuid,
  details        jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS iam_audit_at_idx ON iam_audit (at);

CREATE OR REPLACE FUNCTION iam_audit_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'iam_audit is append-only';
END $$;
DROP TRIGGER IF EXISTS iam_audit_append_only_trg ON iam_audit;
CREATE TRIGGER iam_audit_append_only_trg
  BEFORE UPDATE OR DELETE ON iam_audit
  FOR EACH ROW EXECUTE FUNCTION iam_audit_append_only();

-- Leave the transaction as the role that started it (drizzle writes its
-- metadata right after this file).
RESET ROLE;
SELECT set_config('lock_timeout', current_setting('aggregator_dpg.prev_lock_timeout'), true),
       set_config('statement_timeout', current_setting('aggregator_dpg.prev_statement_timeout'), true);
