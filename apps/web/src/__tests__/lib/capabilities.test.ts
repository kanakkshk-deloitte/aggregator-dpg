import { describe, expect, it } from 'vitest';
import {
  can,
  canInvite,
  canManageOrg,
  canViewCoordinators,
  coordinatorsHref,
} from '@/lib/capabilities';

describe('can', () => {
  it('allows everything when access control is off', () => {
    expect(can(null, 'profiles.view_pii')).toBe(true);
    expect(can(undefined, 'org.manage')).toBe(true);
  });

  it('allows only listed capabilities otherwise', () => {
    expect(can(['profiles.view'], 'profiles.view')).toBe(true);
    expect(can(['profiles.view'], 'profiles.view_pii')).toBe(false);
    expect(can([], 'profiles.view')).toBe(false);
  });
});

describe('canManageOrg', () => {
  const root = { id: 'root', org_type: 'network_facilitator' };
  const owned = { id: 'own', org_type: 'aggregator', capabilities: ['org.manage'] };

  it('with access control off, allows the network admin everywhere and an owner its own orgs', () => {
    expect(canManageOrg({ capabilities: null, orgs: [root] }, 'any')).toBe(true);
    expect(canManageOrg({ capabilities: null, orgs: [owned] }, 'own')).toBe(true);
    // An org below the owner's own is only viewed.
    expect(canManageOrg({ capabilities: null, orgs: [owned] }, 'below')).toBe(false);
  });

  it('allows only organisations where org.manage is held', () => {
    const me = {
      capabilities: ['org.manage'],
      orgs: [{ ...root, capabilities: ['orgs.onboard'] }, owned],
    };
    expect(canManageOrg(me, 'own')).toBe(true);
    expect(canManageOrg(me, 'other')).toBe(false);
  });

  it('allows every organisation when org.manage is held in the root', () => {
    const me = { capabilities: ['org.manage'], orgs: [{ ...root, capabilities: ['org.manage'] }] };
    expect(canManageOrg(me, 'other')).toBe(true);
  });

  it('treats missing per-organisation capabilities as not held', () => {
    expect(
      canManageOrg({ capabilities: [], orgs: [{ id: 'own', org_type: 'aggregator' }] }, 'own'),
    ).toBe(false);
  });
});

describe('canInvite', () => {
  const root = { id: 'root', org_type: 'network_facilitator' };
  const dflt = {
    id: 'dflt',
    org_type: 'aggregator',
    is_default: true,
    capabilities: ['org.manage'],
  };
  const real = {
    id: 'real',
    org_type: 'aggregator',
    is_default: false,
    capabilities: ['org.manage'],
  };

  it('is offered when access control is off', () => {
    expect(canInvite({ capabilities: null, orgs: [] })).toBe(true);
  });

  it('is not offered to a network admin that manages only the Default org', () => {
    const me = {
      capabilities: ['org.manage'],
      orgs: [{ ...root, capabilities: ['orgs.onboard'] }, dflt],
    };
    expect(canInvite(me)).toBe(false);
  });

  it('is offered for a managed org that takes invites, or org.manage in the root', () => {
    expect(canInvite({ capabilities: ['org.manage'], orgs: [real] })).toBe(true);
    expect(
      canInvite({
        capabilities: ['org.manage'],
        orgs: [{ ...root, capabilities: ['org.manage'] }],
      }),
    ).toBe(true);
  });
});

describe('canViewCoordinators', () => {
  it('admits an org admin, not the network admin or others', () => {
    expect(canViewCoordinators({ capabilities: ['org.manage'], orgs: [] })).toBe(true);
    expect(canViewCoordinators({ capabilities: ['network.administer'], orgs: [] })).toBe(false);
    expect(
      canViewCoordinators({ capabilities: ['org.manage'], orgs: [], is_network_admin: true }),
    ).toBe(false);
    expect(canViewCoordinators({ capabilities: ['profiles.view'], orgs: [] })).toBe(false);
    expect(canViewCoordinators({ capabilities: null, orgs: [] })).toBe(true);
  });
});

describe('coordinatorsHref', () => {
  const org = (id: string, over: { org_type?: string; is_default?: boolean } = {}) => ({
    id,
    org_type: 'aggregator',
    is_default: false,
    ...over,
  });

  it('sends an owner of one organisation to the console home', () => {
    expect(coordinatorsHref({ is_network_admin: false, orgs: [org('a')] })).toBe('/console');
  });

  it('sends an owner of several organisations to the coordinators page', () => {
    expect(coordinatorsHref({ is_network_admin: false, orgs: [org('a'), org('b')] })).toBe(
      '/console/coordinators',
    );
  });

  it('sends the network admin to the coordinators page', () => {
    expect(coordinatorsHref({ is_network_admin: true, orgs: [org('a')] })).toBe(
      '/console/coordinators',
    );
  });

  it('does not count the Default organisation', () => {
    expect(
      coordinatorsHref({ is_network_admin: false, orgs: [org('d', { is_default: true })] }),
    ).toBe('/console/coordinators');
  });
});
