/**
 * Unit tests for the geo provider selector.
 *
 * Three behaviours, each of which fails silently if it regresses: the key
 * decides which geocoder is used (get it backwards and an unconfigured
 * deployment starts calling Google with no key), the PII-mask guard must
 * short-circuit before any network call (otherwise a masked value like "***"
 * is sent to a third party), and the provider is memoised per configuration
 * (otherwise every widget mount loses the shared suggestion cache and, on the
 * Google path, re-adds the Maps loader script).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getGeoProvider } from '@/lib/geo/provider';

describe('getGeoProvider', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ features: [] }) });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses the key-less Photon geocoder when no Maps key is configured', async () => {
    await getGeoProvider({ photonUrl: 'https://photon.test' }).suggest('jayanagar');

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('https://photon.test/api?q=jayanagar');
  });

  it('short-circuits a PII-masked query without touching the network', async () => {
    // Read-time masking replaces a private field's value with something like
    // "***" or "+91-XX-XXXX-X123". Geocoding that wastes quota, returns
    // nonsense, and hands a third party a value we deliberately masked.
    const provider = getGeoProvider({ photonUrl: 'https://photon.test' });

    expect(await provider.suggest('***')).toEqual([]);
    expect(await provider.suggest('+91-XX-XXXX-X123')).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still serves a normal query through the same guarded provider', async () => {
    const provider = getGeoProvider({ photonUrl: 'https://photon.test' });

    await provider.suggest('koramangala');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns the same provider instance for the same configuration', () => {
    // Memoised so the session suggestion cache and the single Maps-script load
    // are shared across every widget on the form.
    const a = getGeoProvider({ photonUrl: 'https://photon.test' });
    const b = getGeoProvider({ photonUrl: 'https://photon.test' });

    expect(a).toBe(b);
  });

  it('returns a different provider when the configuration differs', () => {
    const a = getGeoProvider({ photonUrl: 'https://photon.test' });
    const b = getGeoProvider({ googleMapsApiKey: 'key-123' });

    expect(a).not.toBe(b);
  });
});
