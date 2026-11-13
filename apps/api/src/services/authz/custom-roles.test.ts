/**
 * Unit tests for the CUSTOM-ROLES defense-in-depth guard in `custom-roles.ts`
 * (`@aggregator-dpg/api`, RBAC R6).
 *
 * The primary gate is route-not-registration (`v1-iam.ts`); these functions
 * carry a second `custom_roles_disabled` guard that must short-circuit every
 * write before it touches the runtime or the catalogue store when
 * `RBAC_CUSTOM_ROLES_ENABLED` is off. This file covers that gate directly,
 * since it is unreachable through the (unregistered) routes.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createCustomRole, updateCustomRole, deleteCustomRole } from './custom-roles.js';
import { getRbacRuntime, _setRbacRuntime } from './runtime.js';
import { config } from '../../config.js';
import type { Actor } from '../auth/actor/index.js';

const actor: Actor = { userId: 'admin-1', userType: 'admin', active: true, orgs: [] };

const input = {
  key: 'verifier',
  name: 'Verifier',
  description: 'x',
  accountType: 'coordinator',
  assignableOrgTypes: ['aggregator'],
  assignedBy: 'org.manage',
  maxDays: null,
  permissions: ['profiles.verify'],
};

const savedCustomRoles = config.RBAC_CUSTOM_ROLES_ENABLED;

afterEach(() => {
  config.RBAC_CUSTOM_ROLES_ENABLED = savedCustomRoles;
  _setRbacRuntime(null);
});

describe('custom-roles guard with RBAC_CUSTOM_ROLES_ENABLED off', () => {
  it('createCustomRole fails custom_roles_disabled before touching the runtime', async () => {
    config.RBAC_CUSTOM_ROLES_ENABLED = false;
    // A runtime is present (RBAC on) — the guard must still short-circuit, and
    // it runs before `getRbacRuntime`, so no runtime is even required here.
    expect(getRbacRuntime()).toBeNull();
    const res = await createCustomRole(actor, input);
    expect(res).toEqual({ ok: false, failure: { kind: 'custom_roles_disabled' } });
  });

  it('updateCustomRole fails custom_roles_disabled', async () => {
    config.RBAC_CUSTOM_ROLES_ENABLED = false;
    const res = await updateCustomRole(actor, 'verifier', { maxDays: 10 });
    expect(res).toEqual({ ok: false, failure: { kind: 'custom_roles_disabled' } });
  });

  it('deleteCustomRole fails custom_roles_disabled', async () => {
    config.RBAC_CUSTOM_ROLES_ENABLED = false;
    const res = await deleteCustomRole(actor, 'verifier');
    expect(res).toEqual({ ok: false, failure: { kind: 'custom_roles_disabled' } });
  });

  it('the disabled guard takes precedence over the rbac_off guard', async () => {
    // Both the flag is off AND the runtime is null (RBAC off too). The
    // custom-roles guard is checked first, so the failure is the capability
    // one, not `rbac_off` — the write never depended on the runtime at all.
    config.RBAC_CUSTOM_ROLES_ENABLED = false;
    _setRbacRuntime(null);
    const res = await createCustomRole(actor, input);
    expect(res).toEqual({ ok: false, failure: { kind: 'custom_roles_disabled' } });
  });
});
