/**
 * The coordinator's org link and org-detail rendering in the in-memory store
 * (`@aggregator-dpg/api`, migration 0028). The Postgres store follows the same
 * rules through its join (see `postgres.test.ts` and the integration suite).
 */
import { describe, it, expect } from 'vitest';
import { InMemoryUserStore, MEMORY_DEFAULT_ORG_ID } from '../memory.js';
import { UserStoreFake, buildCoordinator, buildCreateCoordinatorInput } from '../testing.js';
import { NO_CONSENT_WRITE } from '../../consent-ledger/hook.js';

const CONSENT = {
  value: true,
  given_at: '2026-01-01T00:00:00Z',
  valid_till: '2027-01-01T00:00:00Z',
};

describe('aggregator store org link (0028)', () => {
  it('persists the org on create and returns it as parentOrgId', async () => {
    const store = new InMemoryUserStore();
    const r = await store.create({
      recordConsent: NO_CONSENT_WRITE,
      orgSlug: 'c1',
      name: 'Coord 1',
      type: 'seeker',
      contact: { name: 'A', phone: '+919000000001', email: 'c1@x.org' },
      consent: CONSENT,
      createdBy: 'self',
      updatedBy: 'self',
      orgId: 'org-1',
    });
    expect(r.ok && r.value.parentOrgId).toBe('org-1');
    expect(r.ok && r.value.isDefaultOrg).toBe(false);
  });

  it('marks a Default-org coordinator', async () => {
    const store = new InMemoryUserStore();
    const r = await store.create(buildCreateCoordinatorInput({ orgId: MEMORY_DEFAULT_ORG_ID }));
    expect(r.ok && r.value.isDefaultOrg).toBe(true);
  });

  it("findByParentOrgId returns only that org's coordinators", async () => {
    const store = new UserStoreFake();
    store.seed([
      buildCoordinator({ id: 'c1', orgSlug: 'c1', contactEmail: 'c1@x.org', parentOrgId: 'org-1' }),
      buildCoordinator({ id: 'c2', orgSlug: 'c2', contactEmail: 'c2@x.org', parentOrgId: 'org-2' }),
      buildCoordinator({ id: 'c3', orgSlug: 'c3', contactEmail: 'c3@x.org', parentOrgId: 'org-1' }),
    ]);
    const list = await store.findByParentOrgId('org-1');
    expect(list.ok && list.value.map((a) => a.id).sort()).toEqual(['c1', 'c3']);
  });
});

describe('org-detail rendering (0028)', () => {
  const loc = (street: string) => ({
    geo: { type: 'Point' as const, coordinates: [77.6, 12.9] },
    address: { streetAddress: street },
  });

  it("renders the org's url / locations / company / GST", async () => {
    const store = new UserStoreFake();
    store.seedOrgDetails('org-1', {
      url: 'https://org.example',
      locations: [loc('Org street')],
      legalName: 'Org Pvt Ltd',
      gstNumber: '29ABCDE1234F1Z5',
    });
    const r = await store.create(buildCreateCoordinatorInput({ orgId: 'org-1' }));
    if (!r.ok) throw new Error('create failed');
    expect(r.value.url).toBe('https://org.example');
    expect(r.value.locations).toEqual([loc('Org street')]);
    expect(r.value.contact.company).toBe('Org Pvt Ltd');
    expect(r.value.contact.gstNumber).toBe('29ABCDE1234F1Z5');
  });

  it("falls back per field to the coordinator's own values when the org's are empty", async () => {
    const store = new UserStoreFake();
    store.seedOrgDetails('org-1', { url: 'https://org.example' });
    const r = await store.create(
      buildCreateCoordinatorInput({
        orgId: 'org-1',
        legacyOrgDetails: { url: 'https://own.example', locations: [loc('Own street')] },
      }),
    );
    if (!r.ok) throw new Error('create failed');
    // The org has a url: it wins. It has no location: the coordinator's shows.
    expect(r.value.url).toBe('https://org.example');
    expect(r.value.locations).toEqual([loc('Own street')]);
    expect(r.value.contact.company).toBeUndefined();
  });

  it('renders empty values when neither has one, and never stores submitted company / GST', async () => {
    const store = new UserStoreFake();
    const r = await store.create(
      buildCreateCoordinatorInput({
        orgId: 'org-1',
        contact: {
          name: 'A',
          phone: '+919000000009',
          email: 'a9@x.org',
          company: 'Ignored',
          gstNumber: 'Ignored',
        },
      }),
    );
    if (!r.ok) throw new Error('create failed');
    expect(r.value.url).toBeNull();
    expect(r.value.locations).toEqual([]);
    expect(r.value.contact).toEqual({ name: 'A', phone: '+919000000009', email: 'a9@x.org' });
  });

  it('ignores an empty legacy value (recorded only so a revert is exact)', async () => {
    const store = new UserStoreFake();
    store.seedOrgDetails('org-1', {});
    const r = await store.create(
      buildCreateCoordinatorInput({
        orgId: 'org-1',
        legacyOrgDetails: { url: null, locations: [] },
      }),
    );
    if (!r.ok) throw new Error('create failed');
    expect(r.value.url).toBeNull();
    expect(r.value.locations).toEqual([]);
  });

  it('re-renders on every read, as the Postgres join does', async () => {
    const store = new UserStoreFake();
    const r = await store.create(buildCreateCoordinatorInput({ orgId: 'org-late' }));
    if (!r.ok) throw new Error('create failed');
    expect(r.value.url).toBeNull();
    store.seedOrgDetails('org-late', { url: 'https://late.example' });
    const again = await store.findById(r.value.id);
    expect(again.ok && again.value?.url).toBe('https://late.example');
  });
});
