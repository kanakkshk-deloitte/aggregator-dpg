/**
 * Unit tests for the console reach checks (design C7): the network admin
 * reaches every org (`null`), an owner reaches only the orgs it owns, a
 * coordinator reaches nothing, and an out-of-reach `org_id` narrows a search to
 * an empty page rather than leaking that the id exists.
 *
 * @module @aggregator-dpg/api
 */
import { describe, it, expect } from 'vitest';
import type { Actor, ActorOrg } from '../auth/actor/index.js';
import { reachableOrgIds, reachesOrg, scopeOrgFilter } from './scope.js';

const ownerOrg = (id: string): ActorOrg => ({
  id,
  orgType: 'aggregator',
  relation: 'owner',
  isDefault: false,
});

const rootOrg: ActorOrg = {
  id: 'root-1',
  orgType: 'network_facilitator',
  relation: 'owner',
  isDefault: false,
};

const admin = (orgs: ActorOrg[]): Actor => ({
  userId: 'admin-1',
  userType: 'admin',
  active: true,
  orgs,
});

const networkAdmin: Actor = admin([rootOrg, ownerOrg('org-a')]);
const owner: Actor = admin([ownerOrg('org-a'), ownerOrg('org-b')]);
const coordinator: Actor = {
  userId: 'coord-1',
  userType: 'coordinator',
  active: true,
  orgs: [{ id: 'org-c', orgType: 'aggregator', relation: 'member', isDefault: false }],
};

describe('reachableOrgIds', () => {
  it('returns the root and the owned orgs for the network admin, never every org', () => {
    expect(reachableOrgIds(networkAdmin)).toEqual(['root-1', 'org-a']);
  });

  it('returns the owned aggregator org ids for an owner', () => {
    expect(reachableOrgIds(owner)).toEqual(['org-a', 'org-b']);
  });

  it('returns an empty list for a coordinator', () => {
    expect(reachableOrgIds(coordinator)).toEqual([]);
  });
});

describe('reachesOrg', () => {
  it('never reaches a null org', () => {
    expect(reachesOrg(networkAdmin, null)).toBe(false);
    expect(reachesOrg(owner, null)).toBe(false);
  });

  it('the network admin reaches the root and its own orgs only', () => {
    expect(reachesOrg(networkAdmin, 'root-1')).toBe(true);
    expect(reachesOrg(networkAdmin, 'org-a')).toBe(true);
    expect(reachesOrg(networkAdmin, 'any-org')).toBe(false);
  });

  it('an owner reaches an owned org but not an unowned one', () => {
    expect(reachesOrg(owner, 'org-a')).toBe(true);
    expect(reachesOrg(owner, 'org-z')).toBe(false);
  });

  it('a coordinator reaches nothing', () => {
    expect(reachesOrg(coordinator, 'org-c')).toBe(false);
  });
});

describe('scopeOrgFilter', () => {
  it('with no requested org returns the full reach', () => {
    expect(scopeOrgFilter(networkAdmin)).toEqual(['root-1', 'org-a']);
    expect(scopeOrgFilter(owner)).toEqual(['org-a', 'org-b']);
  });

  it('narrows a requested in-reach org to just that org', () => {
    expect(scopeOrgFilter(owner, 'org-b')).toEqual(['org-b']);
    expect(scopeOrgFilter(networkAdmin, 'org-a')).toEqual(['org-a']);
    expect(scopeOrgFilter(networkAdmin, 'org-x')).toEqual([]);
  });

  it('narrows a requested out-of-reach org to an empty page', () => {
    expect(scopeOrgFilter(owner, 'org-z')).toEqual([]);
  });
});
