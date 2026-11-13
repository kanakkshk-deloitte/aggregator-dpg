import { describe, it, expect } from 'vitest';
import { orgLocationsFrom } from '../org-location.js';

describe('orgLocationsFrom', () => {
  it('builds one Beckn location from the address, state and picked point', () => {
    expect(
      orgLocationsFrom(
        {
          streetAddress: 'A st',
          addressLocality: 'Blr',
          addressDistrict: 'Urban',
          postalCode: '560001',
        },
        'Karnataka',
        [77.5, 12.97],
      ),
    ).toEqual([
      {
        geo: { type: 'Point', coordinates: [77.5, 12.97] },
        address: {
          streetAddress: 'A st',
          addressLocality: 'Blr',
          addressRegion: 'Karnataka',
          postalCode: '560001',
        },
      },
    ]);
  });

  it('prefers the address region over the legacy state, and drops the district', () => {
    const [l] = orgLocationsFrom(
      { addressLocality: 'Kochi', addressRegion: 'Kerala', addressDistrict: 'E' },
      'KA',
      null,
    );
    expect(l?.address).toEqual({ addressLocality: 'Kochi', addressRegion: 'Kerala' });
    expect(l?.geo).toEqual({ type: 'Point', coordinates: [0, 0] });
  });

  it('builds a location from real coordinates alone', () => {
    expect(orgLocationsFrom(null, null, [10, 20])).toHaveLength(1);
  });

  it('gives [] for a state alone, an empty address, or the [0,0] placeholder', () => {
    expect(orgLocationsFrom(null, 'Karnataka', null)).toEqual([]);
    expect(orgLocationsFrom({ streetAddress: '  ' }, null, undefined)).toEqual([]);
    expect(orgLocationsFrom({}, 'KA', [0, 0])).toEqual([]);
  });
});
