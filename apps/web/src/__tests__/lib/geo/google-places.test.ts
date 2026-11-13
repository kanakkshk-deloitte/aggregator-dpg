/**
 * Unit tests for the Google Places provider.
 *
 * The Maps JS API is stubbed on `window.google` rather than loaded: the
 * implementation short-circuits its script loader when `importLibrary` is
 * already present, so every test here exercises the real query and mapping path
 * without a network call or a `<script>` that jsdom could never execute.
 *
 * The mapping is where the risk sits. Each prediction needs a second
 * `fetchFields` round-trip to get its coordinate, and a prediction that resolves
 * without a location must be dropped — surfacing it would put a suggestion in
 * the list that yields no coordinate when picked, which is exactly the silent
 * failure this whole feature exists to remove.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createGooglePlacesProvider } from '@/lib/geo/google-places';

interface StubPlace {
  location?: { lat: () => number; lng: () => number };
  addressComponents?: Array<{ types: string[]; longText: string; shortText: string }>;
  fetchFields?: (req: { fields: string[] }) => Promise<void>;
}

/** Builds one autocomplete prediction whose `toPlace()` resolves to `place`. */
function prediction(text: string, place: StubPlace) {
  return {
    placePrediction: {
      text: { toString: () => text },
      toPlace: () => ({ fetchFields: place.fetchFields ?? (async () => undefined), ...place }),
    },
  };
}

const BENGALURU: StubPlace = {
  location: { lat: () => 12.9251, lng: () => 77.5938 },
  addressComponents: [
    {
      types: ['sublocality', 'sublocality_level_1'],
      longText: 'Jayanagar',
      shortText: 'Jayanagar',
    },
    { types: ['locality'], longText: 'Bengaluru', shortText: 'Bengaluru' },
    {
      types: ['administrative_area_level_1'],
      longText: 'Karnataka',
      shortText: 'KA',
    },
    { types: ['postal_code'], longText: '560041', shortText: '560041' },
    { types: ['country'], longText: 'India', shortText: 'IN' },
  ],
};

/** Installs a `window.google` stub whose autocomplete returns `suggestions`. */
function stubMapsApi(suggestions: unknown[], overrides: { fetch?: () => Promise<unknown> } = {}) {
  const fetchAutocompleteSuggestions = vi.fn(overrides.fetch ?? (async () => ({ suggestions })));
  vi.stubGlobal('google', {
    maps: {
      importLibrary: async () => ({
        AutocompleteSessionToken: class {},
        AutocompleteSuggestion: { fetchAutocompleteSuggestions },
      }),
    },
  });
  return { fetchAutocompleteSuggestions };
}

describe('createGooglePlacesProvider', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns a suggestion with its label, coordinate and components', async () => {
    stubMapsApi([prediction('Jayanagar, Bengaluru, Karnataka, India', BENGALURU)]);

    const [suggestion] = await createGooglePlacesProvider('key-123').suggest('jayanagar');

    expect(suggestion).toMatchObject({
      label: 'Jayanagar, Bengaluru, Karnataka, India',
      lat: 12.9251,
      lng: 77.5938,
    });
    expect(suggestion?.components).toMatchObject({
      locality: 'Jayanagar',
      city: 'Bengaluru',
      state: 'Karnataka',
      postcode: '560041',
      country: 'India',
    });
  });

  it('falls back to the locality when no sublocality is present', async () => {
    stubMapsApi([
      prediction('Bengaluru', {
        location: { lat: () => 12.9, lng: () => 77.5 },
        addressComponents: [{ types: ['locality'], longText: 'Bengaluru', shortText: 'Bengaluru' }],
      }),
    ]);

    const [suggestion] = await createGooglePlacesProvider('key-123').suggest('bengaluru');

    expect(suggestion?.components?.locality).toBe('Bengaluru');
  });

  it('asks for the fields it needs on each prediction', async () => {
    const fetchFields = vi.fn(async () => undefined);
    stubMapsApi([prediction('Jayanagar', { ...BENGALURU, fetchFields })]);

    await createGooglePlacesProvider('key-123').suggest('jayanagar');

    expect(fetchFields).toHaveBeenCalledWith({ fields: ['location', 'addressComponents'] });
  });

  it('drops a prediction that resolves with no location', async () => {
    // A suggestion with no coordinate is worse than no suggestion: picking it
    // would look like it worked and store nothing.
    stubMapsApi([
      prediction('Somewhere vague', { addressComponents: [] }),
      prediction('Jayanagar', BENGALURU),
    ]);

    const results = await createGooglePlacesProvider('key-123').suggest('jaya');

    expect(results).toHaveLength(1);
    expect(results[0]?.label).toBe('Jayanagar');
  });

  it('caps the list at five predictions', async () => {
    stubMapsApi(Array.from({ length: 9 }, (_, i) => prediction(`Place ${i}`, BENGALURU)));

    const results = await createGooglePlacesProvider('key-123').suggest('place');

    expect(results).toHaveLength(5);
  });

  it('returns nothing for a blank query without calling the API', async () => {
    const { fetchAutocompleteSuggestions } = stubMapsApi([]);

    expect(await createGooglePlacesProvider('key-123').suggest('   ')).toEqual([]);
    expect(fetchAutocompleteSuggestions).not.toHaveBeenCalled();
  });

  it('returns nothing rather than throwing when the Maps API rejects', async () => {
    // Runs inside a keystroke handler — a rejection here must not escape.
    stubMapsApi([], {
      fetch: async () => {
        throw new Error('OVER_QUERY_LIMIT');
      },
    });

    expect(await createGooglePlacesProvider('key-123').suggest('jayanagar')).toEqual([]);
  });

  it('returns nothing when an already-aborted signal is supplied', async () => {
    stubMapsApi([prediction('Jayanagar', BENGALURU)]);
    const controller = new AbortController();
    controller.abort();

    expect(
      await createGooglePlacesProvider('key-123').suggest('jayanagar', controller.signal),
    ).toEqual([]);
  });
});

describe('createGooglePlacesProvider — Maps API loader', () => {
  /**
   * A provider from a FRESH module instance.
   *
   * The loader caches its load promise at module scope — the Maps API may only
   * be added to a page once — so without resetting the module, whichever loader
   * test ran first would satisfy every later one and they would all pass
   * vacuously.
   */
  async function freshProvider(key: string) {
    vi.resetModules();
    document.head.innerHTML = '';
    delete (window as unknown as { google?: unknown }).google;
    const mod = await import('@/lib/geo/google-places');
    return mod.createGooglePlacesProvider(key);
  }

  function loaderScript(): HTMLScriptElement | null {
    return document.querySelector<HTMLScriptElement>('script[data-dpg-google-maps="true"]');
  }

  beforeEach(() => {
    vi.unstubAllGlobals();
    document.head.innerHTML = '';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.head.innerHTML = '';
  });

  it('injects the loader script with the key, the places library and a callback', async () => {
    // The `libraries=places` parameter is why the key needs BOTH Maps
    // JavaScript API and Places API (New) enabled: a Places-only API
    // restriction blocks this script itself, not just the later call.
    const provider = await freshProvider('key-123');
    const pending = provider.suggest('jayanagar');

    const script = loaderScript();
    expect(script).not.toBeNull();
    const url = new URL(script!.src);
    expect(url.origin + url.pathname).toBe('https://maps.googleapis.com/maps/api/js');
    expect(url.searchParams.get('key')).toBe('key-123');
    expect(url.searchParams.get('libraries')).toBe('places');
    expect(url.searchParams.get('callback')).toBe('__dpgGoogleMapsInit');
    expect(url.searchParams.get('loading')).toBe('async');
    expect(script!.async).toBe(true);

    // Settle the pending query the way the Maps API would, so the test does not
    // leave a dangling promise behind it.
    stubMapsApi([]);
    (window as unknown as { __dpgGoogleMapsInit: () => void }).__dpgGoogleMapsInit();
    expect(await pending).toEqual([]);
  });

  it('injects the loader exactly once, however many queries are made', async () => {
    // A second <script> for the Maps API is a console error and a wasted load.
    const provider = await freshProvider('key-123');
    const first = provider.suggest('jayanagar');
    stubMapsApi([]);
    (window as unknown as { __dpgGoogleMapsInit: () => void }).__dpgGoogleMapsInit();
    await first;

    await provider.suggest('koramangala');

    expect(document.querySelectorAll('script[data-dpg-google-maps="true"]')).toHaveLength(1);
  });

  it('returns nothing rather than throwing when the script fails to load', async () => {
    const provider = await freshProvider('key-456');
    const pending = provider.suggest('jayanagar');

    loaderScript()!.onerror!(new Event('error'));

    expect(await pending).toEqual([]);
  });
});

describe('createGooglePlacesProvider country restriction (signals-dpg#785)', () => {
  const BOGURA_BD: StubPlace = {
    location: { lat: () => 24.85, lng: () => 89.37 },
    addressComponents: [{ types: ['country'], longText: 'Bangladesh', shortText: 'BD' }],
  };

  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends includedRegionCodes when a country is set', async () => {
    const { fetchAutocompleteSuggestions } = stubMapsApi([]);
    await createGooglePlacesProvider('key-123', 'IN').suggest('jayanagar');
    expect(fetchAutocompleteSuggestions).toHaveBeenCalledWith(
      expect.objectContaining({ input: 'jayanagar', includedRegionCodes: ['in'] }),
    );
  });

  it('sends no includedRegionCodes when no country is set', async () => {
    const { fetchAutocompleteSuggestions } = stubMapsApi([]);
    await createGooglePlacesProvider('key-123').suggest('jayanagar');
    expect(fetchAutocompleteSuggestions.mock.calls[0]?.[0]).not.toHaveProperty(
      'includedRegionCodes',
    );
  });

  it('drops a suggestion from another country as a backstop', async () => {
    stubMapsApi([
      prediction('Bogura, Bangladesh', BOGURA_BD),
      prediction('Jayanagar, Bengaluru, Karnataka, India', BENGALURU),
    ]);
    const out = await createGooglePlacesProvider('key-123', 'IN').suggest('b');
    expect(out.map((s) => s.label)).toEqual(['Jayanagar, Bengaluru, Karnataka, India']);
  });

  it('keeps foreign suggestions when no country is set', async () => {
    stubMapsApi([
      prediction('Bogura, Bangladesh', BOGURA_BD),
      prediction('Jayanagar, Bengaluru, Karnataka, India', BENGALURU),
    ]);
    const out = await createGooglePlacesProvider('key-123').suggest('b');
    expect(out).toHaveLength(2);
  });
});
