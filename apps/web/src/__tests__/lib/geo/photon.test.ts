/**
 * Unit tests for the key-less Photon geocoder.
 *
 * This is the provider every unconfigured deployment actually runs, so its
 * failure modes matter more than the Google one's: a malformed feature must be
 * skipped rather than surfacing a suggestion with a broken coordinate, and any
 * transport or parse failure must degrade to "no suggestions" rather than
 * throwing inside a keystroke handler.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parsePhotonFeatures, createPhotonProvider } from '@/lib/geo/photon';

const FEATURE = {
  geometry: { coordinates: [77.5938, 12.9251] },
  properties: {
    name: 'Jayanagar',
    city: 'Bengaluru',
    state: 'Karnataka',
    postcode: '560041',
    country: 'India',
  },
};

describe('parsePhotonFeatures', () => {
  it('maps a feature to a suggestion, converting [lng, lat] to lat/lng', () => {
    // Photon emits GeoJSON order (lng first). Swapping these silently puts
    // every Indian address in the Indian Ocean.
    const [suggestion] = parsePhotonFeatures({ features: [FEATURE] });

    expect(suggestion).toMatchObject({ lat: 12.9251, lng: 77.5938 });
  });

  it('builds the label from the populated address parts, in order', () => {
    const [suggestion] = parsePhotonFeatures({ features: [FEATURE] });

    expect(suggestion?.label).toBe('Jayanagar, Bengaluru, Karnataka, 560041, India');
  });

  it('omits missing parts from the label rather than leaving empty separators', () => {
    const [suggestion] = parsePhotonFeatures({
      features: [{ geometry: { coordinates: [77, 12] }, properties: { name: 'Somewhere' } }],
    });

    expect(suggestion?.label).toBe('Somewhere');
  });

  it('falls back to the raw coordinate when a feature has no usable name at all', () => {
    const [suggestion] = parsePhotonFeatures({
      features: [{ geometry: { coordinates: [77, 12] }, properties: {} }],
    });

    expect(suggestion?.label).toBe('12, 77');
  });

  it('carries the address components through', () => {
    const [suggestion] = parsePhotonFeatures({ features: [FEATURE] });

    expect(suggestion?.components).toMatchObject({ city: 'Bengaluru', state: 'Karnataka' });
  });

  it('skips a feature with no geometry', () => {
    expect(parsePhotonFeatures({ features: [{ properties: { name: 'Nowhere' } }] })).toEqual([]);
  });

  it('skips a feature whose coordinates are not numbers', () => {
    expect(
      parsePhotonFeatures({
        features: [{ geometry: { coordinates: ['77', '12'] }, properties: {} }],
      }),
    ).toEqual([]);
  });

  it('returns an empty list for a response with no features key', () => {
    expect(parsePhotonFeatures({})).toEqual([]);
    expect(parsePhotonFeatures(null)).toEqual([]);
  });
});

describe('createPhotonProvider', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ features: [FEATURE] }) });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('queries the configured host and returns parsed suggestions', async () => {
    const results = await createPhotonProvider('https://photon.test').suggest('jayanagar');

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://photon.test/api?q=jayanagar&limit=5',
    );
    expect(results).toHaveLength(1);
  });

  it('strips a trailing slash off the configured host', async () => {
    await createPhotonProvider('https://photon.test/').suggest('jayanagar');

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://photon.test/api?q=jayanagar&limit=5',
    );
  });

  it('url-encodes the query', async () => {
    await createPhotonProvider('https://photon.test').suggest('mg road, bengaluru');

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('q=mg%20road%2C%20bengaluru');
  });

  it('returns nothing for a blank query without calling out', async () => {
    expect(await createPhotonProvider('https://photon.test').suggest('   ')).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns nothing on a non-2xx response', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });

    expect(await createPhotonProvider('https://photon.test').suggest('jayanagar')).toEqual([]);
  });

  it('returns nothing rather than throwing when the transport fails', async () => {
    // This runs inside a keystroke handler; a throw here would surface as an
    // unhandled rejection with the field left in a half-searched state.
    fetchMock.mockRejectedValue(new Error('network down'));

    expect(await createPhotonProvider('https://photon.test').suggest('jayanagar')).toEqual([]);
  });

  it('aborting a superseded keystroke aborts the request it started', async () => {
    // The caller's signal is no longer forwarded as-is — it is combined with a
    // request deadline — so assert the behaviour rather than object identity:
    // cancelling upstream must still abort what reached `fetch`.
    const controller = new AbortController();

    await createPhotonProvider('https://photon.test').suggest('jayanagar', controller.signal);
    const sent = (fetchMock.mock.calls[0]?.[1] as RequestInit).signal as AbortSignal;
    expect(sent.aborted).toBe(false);

    controller.abort();
    expect(sent.aborted).toBe(true);
  });

  it('always sends a signal, so an unsupplied one still carries the deadline', async () => {
    // Previously this asserted the key was omitted. Every call now carries a
    // deadline, which is the point: a request with no caller signal was the
    // one that could hang indefinitely.
    await createPhotonProvider('https://photon.test').suggest('jayanagar');

    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });
});

describe('request deadline', () => {
  it('aborts a stalled request instead of hanging the dropdown', async () => {
    // The caller's signal only cancels when the NEXT keystroke supersedes this
    // query. A public endpoint that accepts the connection and then goes quiet
    // would otherwise leave the request open and the list empty forever.
    vi.useFakeTimers();
    let observed: AbortSignal | undefined;
    globalThis.fetch = vi.fn((_u: string, init?: RequestInit) => {
      observed = init?.signal ?? undefined;
      return new Promise<Response>((_res, rej) => {
        observed?.addEventListener('abort', () => rej(new Error('aborted')), { once: true });
      });
    }) as unknown as typeof fetch;

    const pending = createPhotonProvider().suggest('MG Road');
    await vi.advanceTimersByTimeAsync(4_000);
    // Failure is swallowed into an empty list, as every other failure here is.
    await expect(pending).resolves.toEqual([]);
    expect(observed?.aborted).toBe(true);
    vi.useRealTimers();
  });

  it('disarms the deadline once the request settles', async () => {
    // A finished request must not stay armed: without clearing on settle the
    // 4s timer fired later and aborted a request that had already completed.
    vi.useFakeTimers();
    let observed: AbortSignal | undefined;
    globalThis.fetch = vi.fn(async (_u: string, init?: RequestInit) => {
      observed = init?.signal ?? undefined;
      return { ok: true, json: async () => ({ features: [] }) } as unknown as Response;
    }) as unknown as typeof fetch;

    await createPhotonProvider().suggest('MG Road');
    await vi.advanceTimersByTimeAsync(4_000);

    expect(observed?.aborted).toBe(false);
    vi.useRealTimers();
  });

  it("still honours the caller's own cancellation", async () => {
    vi.useFakeTimers();
    let observed: AbortSignal | undefined;
    globalThis.fetch = vi.fn((_u: string, init?: RequestInit) => {
      observed = init?.signal ?? undefined;
      return new Promise<Response>((_res, rej) => {
        observed?.addEventListener('abort', () => rej(new Error('aborted')), { once: true });
      });
    }) as unknown as typeof fetch;

    const caller = new AbortController();
    const pending = createPhotonProvider().suggest('MG Road', caller.signal);
    caller.abort();
    await expect(pending).resolves.toEqual([]);
    expect(observed?.aborted).toBe(true);
    vi.useRealTimers();
  });
});

describe('createPhotonProvider country restriction (signals-dpg#788)', () => {
  /** A minimal feature in `countrycode` at granularity `type`. */
  function feature(name: string, countrycode: string, type = 'city') {
    return {
      geometry: { coordinates: [77, 12] },
      properties: { name, country: countrycode, countrycode, type },
    };
  }

  let fetchMock: ReturnType<typeof vi.fn>;

  /** Makes the stubbed Photon answer with `features`. */
  function respond(features: unknown[]) {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ features }) });
    vi.stubGlobal('fetch', fetchMock);
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('adds countrycode to the request when a country is set', async () => {
    respond([]);
    await createPhotonProvider('https://photon.test', 'IN').suggest('dhaka');

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://photon.test/api?q=dhaka&limit=5&countrycode=IN',
    );
  });

  it('drops foreign and country/state-level features as a backstop', async () => {
    // An older Photon server ignores countrycode and answers worldwide, so the
    // filter has to hold on its own.
    respond([
      feature('Dhaka BD', 'BD'),
      feature('India', 'IN', 'country'),
      feature('Bihar', 'IN', 'state'),
      feature('Dhaka IN', 'IN'),
    ]);
    const results = await createPhotonProvider('https://photon.test', 'IN').suggest('dhaka');

    expect(results.map((s) => s.components?.locality)).toEqual(['Dhaka IN']);
  });

  it('keeps every feature when no country is set', async () => {
    respond([feature('Dhaka BD', 'BD'), feature('Dhaka IN', 'IN')]);
    const results = await createPhotonProvider('https://photon.test').suggest('dhaka');

    expect(results).toHaveLength(2);
  });
});
