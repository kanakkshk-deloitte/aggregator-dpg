import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { profileService } from '../../services/profile.service';

const apiResponse = {
  aggregator_id: 'agg-1',
  org_slug: 'trrain-abcd',
  org_name: 'TRRAIN',
  actor_type: 'aggregator',
  type: null,
  url: null,
  contact: {
    name: 'Asha Rao',
    phone: '+919876543210',
    email: 'asha@trrain.org',
  },
  locations: [
    {
      geo: { type: 'Point', coordinates: [72.8777, 19.076] },
      address: {
        streetAddress: '2nd Floor, Trade Centre',
        addressLocality: 'Mumbai',
        addressRegion: 'Maharashtra',
        postalCode: '400051',
        addressCountry: 'IN',
      },
    },
  ],
  consent: { value: true, given_at: '2026-01-01T00:00:00Z', valid_till: '2027-01-01T00:00:00Z' },
  status: 'active',
  identity: {
    first_name: 'Asha',
    last_name: 'Rao',
    email: 'asha@trrain.org',
    email_verified: true,
    phone: '+919876543210',
    phone_verified: false,
    active: true,
  },
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-04-30T00:00:00Z',
};

describe('profileService', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(apiResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('maps API identity to AggregatorProfile.contact', async () => {
    const profile = await profileService.get();
    expect(profile.org).toBe('TRRAIN');
    expect(profile.contact.name).toBe('Asha Rao');
    expect(profile.contact.email).toBe('asha@trrain.org');
    expect(profile.contact.mobile).toBe('+919876543210');
    expect(profile.consent.profileCreation).toBe(true);
  });

  it('renders empty aggregator-details when locations are empty', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ...apiResponse,
            locations: [],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
    ) as unknown as typeof fetch;
    const profile = await profileService.get();
    // `beneficiaries` / `sectors` are now always empty — the personas and
    // services that fed them lived on the removed `aggregator_profile` row.
    expect(profile.beneficiaries).toBe('');
    expect(profile.sectors).toBe('');
    expect(profile.geographies).toBe('');
    expect(profile.address).toBe('');
  });

  // Since #810 registration stores one free-text address, so `addressRegion`
  // and friends are absent on any row created after it. The fixture above is
  // the pre-#810 shape and must keep working; this is the current one.
  it('renders a single-field address, falling back to it for geographies', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ...apiResponse,
            locations: [
              {
                geo: { type: 'Point', coordinates: [77.6245, 12.9352] },
                address: { streetAddress: 'JP Nagar, Bengaluru, Karnataka' },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    ) as unknown as typeof fetch;
    const profile = await profileService.get();
    expect(profile.address).toBe('JP Nagar, Bengaluru, Karnataka');
    // Without the fallback this renders blank for every new registration,
    // because `geographies` used to read `addressRegion` alone.
    expect(profile.geographies).toBe('JP Nagar, Bengaluru, Karnataka');
  });

  it('throws when API returns non-2xx', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('nope', { status: 503 }),
    ) as unknown as typeof fetch;
    // CI on Node 24 / JSDOM 25 sometimes empties template-string error
    // messages; assert that the call throws rather than match the text.
    await expect(profileService.get()).rejects.toThrow();
  });

  it('falls back to the KC identity when contact.name is absent', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ...apiResponse,
            contact: { ...apiResponse.contact, name: '' },
            identity: { ...apiResponse.identity, first_name: 'Asha', last_name: 'Rao' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    ) as unknown as typeof fetch;
    const profile = await profileService.get();
    expect(profile.coordinator).toBe('Asha Rao');
  });

  it('renders an empty registered/lastReviewed date when the API date is invalid', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ ...apiResponse, created_at: 'not-a-date', updated_at: 'not-a-date' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    ) as unknown as typeof fetch;
    const profile = await profileService.get();
    expect(profile.registered).toBe('');
    expect(profile.consent.lastReviewed).toBe('');
  });
});
