import { describe, expect, it } from 'vitest';
import { type ConfigError } from '@aggregator-dpg/shared-primitives/errors';
import type { RoleDefinition } from '../interface.js';
import { BUILTIN_ROLES } from '../builtin-roles.js';
import { assertRoleCatalogue, roleCatalogueIssues } from '../roles.js';
import { buildRole } from '../testing/index.js';

const shipped = (): RoleDefinition[] => structuredClone(BUILTIN_ROLES) as RoleDefinition[];
const role = (key: string) => shipped().find((r) => r.key === key)!;

// Expectations come from docs/rbac/rbac-permissions-and-roles.md §3, not from
// the const, so the built-ins are tested against the catalogue.
const MATRIX: Record<string, string[]> = {
  network_admin: [
    'agreement.manage',
    'campaigns.run',
    'contact.unmask',
    'network.administer',
    'orgs.block',
    'orgs.onboard',
    'profiles.export',
    'profiles.move',
    'profiles.onboard',
    'profiles.retire',
    'profiles.verify',
    'profiles.view',
  ],
  org_admin: [
    'campaigns.run',
    'contact.unmask',
    'org.manage',
    'orgs.onboard',
    'profiles.export',
    'profiles.onboard',
    'profiles.retire',
    'profiles.view',
  ],
  org_onboarder: ['orgs.onboard', 'profiles.move', 'profiles.verify'],
  coordinator: ['campaigns.run', 'profiles.onboard', 'profiles.view'],
  pii_access: ['profiles.view_pii'],
  data_export: ['profiles.export'],
};

describe('BUILTIN_ROLES', () => {
  it('holds exactly the six built-in roles of the catalogue', () => {
    expect(shipped().map((r) => r.key)).toEqual(Object.keys(MATRIX).sort());
  });

  it.each(Object.entries(MATRIX))('%s holds the catalogue permissions', (key, perms) => {
    expect([...role(key).permissions].sort()).toEqual(perms);
  });

  it('maps each membership to one base role', () => {
    expect(role('coordinator').baseFor).toBe('org_member');
    expect(role('org_admin').baseFor).toBe('org_owner');
    expect(role('network_admin').baseFor).toBe('root_owner');
  });

  it('marks the additional roles with who assigns them', () => {
    expect(role('org_onboarder')).toMatchObject({
      baseFor: null,
      assignedBy: 'network.administer',
      accountType: 'admin',
    });
    expect(role('pii_access')).toMatchObject({
      assignedBy: 'org.manage',
      maxDays: 90,
      accountType: 'coordinator',
    });
    expect(role('data_export')).toMatchObject({ assignedBy: 'org.manage', maxDays: null });
  });

  it('gives no role personal data together with the root', () => {
    for (const r of shipped()) {
      if (r.permissions.includes('profiles.view_pii')) {
        expect(r.assignableOrgTypes).not.toContain('network_facilitator');
      }
    }
  });
});

describe('role rules', () => {
  const issues = (change: (roles: RoleDefinition[]) => void) => {
    const roles = shipped();
    change(roles);
    return roleCatalogueIssues(roles).join('\n');
  };

  it('accepts the shipped roles plus a custom role', () => {
    expect(roleCatalogueIssues([...shipped(), buildRole()])).toEqual([]);
  });

  it('refuses a duplicate key', () => {
    expect(issues((r) => r.push(buildRole({ key: 'coordinator' })))).toMatch(/duplicate key/);
  });

  it('refuses a duplicate permission', () => {
    expect(
      issues((r) => r.push(buildRole({ permissions: ['profiles.view', 'profiles.view'] }))),
    ).toMatch(/duplicate permission/);
  });

  it('refuses a missing or second base role', () => {
    expect(
      issues((r) =>
        r.splice(
          r.findIndex((x) => x.key === 'coordinator'),
          1,
        ),
      ),
    ).toMatch(/org_member: expected exactly one, found 0/);
    expect(
      issues((r) =>
        r.push(buildRole({ key: 'c2', baseFor: 'org_member', isBuiltin: true, assignedBy: null })),
      ),
    ).toMatch(/org_member: expected exactly one, found 2/);
  });

  it('refuses a custom base role, an assigned base role and an expiring base role', () => {
    const text = issues((r) => {
      const c = r.find((x) => x.key === 'coordinator')!;
      c.isBuiltin = false;
      c.assignedBy = 'org.manage';
      c.maxDays = 30;
    });
    expect(text).toMatch(/only a built-in role can be a base role/);
    expect(text).toMatch(/not assigned by hand/);
    expect(text).toMatch(/has no expiry/);
  });

  it('refuses a base role for the wrong account type or organisation type', () => {
    expect(
      issues((r) => (r.find((x) => x.key === 'org_admin')!.accountType = 'coordinator')),
    ).toMatch(/org_owner is held by admin accounts/);
    expect(
      issues(
        (r) => (r.find((x) => x.key === 'network_admin')!.assignableOrgTypes = ['aggregator']),
      ),
    ).toMatch(/root_owner is held in the root organisation only/);
    expect(
      issues(
        (r) =>
          (r.find((x) => x.key === 'coordinator')!.assignableOrgTypes = [
            'aggregator',
            'network_facilitator',
          ]),
      ),
    ).toMatch(/org_member is not held in the root organisation/);
  });

  it('refuses an additional role without assigned_by', () => {
    expect(issues((r) => r.push(buildRole({ assignedBy: null })))).toMatch(/needs assigned_by/);
  });

  it('refuses personal data held through the root', () => {
    expect(
      issues((r) =>
        r.push(
          buildRole({
            permissions: ['profiles.view_pii'],
            assignableOrgTypes: ['network_facilitator'],
          }),
        ),
      ),
    ).toMatch(/never held through the root/);
  });
});

describe('assertRoleCatalogue', () => {
  it('accepts the built-in roles', () => {
    expect(() => assertRoleCatalogue(shipped(), 'test')).not.toThrow();
  });

  it('throws RBAC_CONFIG_INVALID listing the broken rule', () => {
    const roles = [...shipped(), buildRole({ key: 'bad', assignedBy: null })];
    try {
      assertRoleCatalogue(roles, 'test');
      expect.unreachable('broken catalogue should be rejected');
    } catch (e) {
      expect((e as ConfigError).code).toBe('RBAC_CONFIG_INVALID');
      expect(JSON.stringify((e as ConfigError).details)).toMatch(/needs assigned_by/);
    }
  });
});
