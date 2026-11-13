/**
 * Google Places (New) autocomplete provider.
 *
 * Loads the Maps JS API once via a shared <script> tag, then resolves each
 * prediction to coordinates and address components.
 *
 * Matches Signals-DPG `apps/ui/src/lib/geo/google-places.ts`.
 *
 * @module apps/web/lib/geo/google-places
 */
import type { GeoComponents, GeoProvider, GeoSuggestion } from './types';

type GoogleNS = {
  maps: {
    importLibrary: (name: string) => Promise<Record<string, unknown>>;
  };
};

let scriptPromise: Promise<void> | null = null;

function loadMapsApi(apiKey: string): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if ((window as unknown as { google?: GoogleNS }).google?.maps?.importLibrary) {
    return Promise.resolve();
  }
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      'script[data-dpg-google-maps="true"]',
    );
    (window as unknown as { __dpgGoogleMapsInit?: () => void }).__dpgGoogleMapsInit = () =>
      resolve();
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error('maps load failed')), {
        once: true,
      });
      return;
    }
    const script = document.createElement('script');
    const url = new URL('https://maps.googleapis.com/maps/api/js');
    url.searchParams.set('key', apiKey);
    url.searchParams.set('libraries', 'places');
    url.searchParams.set('callback', '__dpgGoogleMapsInit');
    url.searchParams.set('loading', 'async');
    url.searchParams.set('v', 'weekly');
    script.src = url.toString();
    script.async = true;
    script.defer = true;
    script.dataset.dpgGoogleMaps = 'true';
    script.onerror = () => reject(new Error('maps load failed'));
    document.head.appendChild(script);
  });
  return scriptPromise;
}

type AddressComponent = { types: string[]; longText: string; shortText: string };

/**
 * Maps Google's flat address-component list onto our `GeoComponents` shape.
 *
 * The lookup order matters: Google returns several locality-like components,
 * and the wrong pick puts a neighbourhood where the city belongs.
 *
 * @param components - `addressComponents` from a resolved Place.
 * @returns The mapped components; any field Google did not supply is absent.
 */
function toGeoComponents(components: AddressComponent[]): GeoComponents {
  const find = (types: string[]): string | undefined =>
    components.find((c) => types.some((t) => c.types.includes(t)))?.longText;

  return {
    locality: find(['sublocality', 'sublocality_level_1', 'neighborhood']) ?? find(['locality']),
    city: find(['locality']) ?? find(['administrative_area_level_2']),
    state: find(['administrative_area_level_1']),
    postcode: find(['postal_code']),
    country: find(['country']),
  };
}

/**
 * Whether a resolved place is in `country`, read from its `country` address
 * component's short code. A place with no country component fails the check.
 *
 * @param components - `addressComponents` from a resolved Place.
 * @param country - Upper-case ISO 3166-1 alpha-2 code.
 * @returns True when the place's country code matches.
 */
function isInCountry(components: AddressComponent[], country: string): boolean {
  return components.find((c) => c.types.includes('country'))?.shortText.toUpperCase() === country;
}

/**
 * Google Places autocomplete provider.
 *
 * `country` (e.g. `IN`) restricts suggestions to that country through
 * `includedRegionCodes`, a hard filter. Each suggestion's country is also
 * checked.
 *
 * @param apiKey - Browser Maps JS API key.
 * @param country - Optional country restriction.
 * @returns The provider.
 */
export function createGooglePlacesProvider(apiKey: string, country?: string): GeoProvider {
  return {
    async suggest(query, signal) {
      const q = query.trim();
      if (!q) return [];
      try {
        await loadMapsApi(apiKey);
        const places = (await (window as unknown as { google: GoogleNS }).google.maps.importLibrary(
          'places',
        )) as {
          AutocompleteSessionToken: new () => object;
          AutocompleteSuggestion: {
            fetchAutocompleteSuggestions: (req: object) => Promise<{
              suggestions: Array<{
                placePrediction: {
                  text: { toString: () => string };
                  toPlace: () => {
                    fetchFields: (req: { fields: string[] }) => Promise<void>;
                    location?: { lat: () => number; lng: () => number };
                    addressComponents?: Array<{
                      types: string[];
                      longText: string;
                      shortText: string;
                    }>;
                  };
                };
              }>;
            }>;
          };
        };

        const token = new places.AutocompleteSessionToken();
        const { suggestions } = await places.AutocompleteSuggestion.fetchAutocompleteSuggestions({
          input: q,
          sessionToken: token,
          ...(country ? { includedRegionCodes: [country.toLowerCase()] } : {}),
        });

        const top = suggestions.slice(0, 5);
        const resolved: (GeoSuggestion | null)[] = await Promise.all(
          top.map(async (s): Promise<GeoSuggestion | null> => {
            if (signal?.aborted) return null;
            const place = s.placePrediction.toPlace();
            await place.fetchFields({ fields: ['location', 'addressComponents'] });
            const loc = place.location;
            if (!loc) return null;
            const components = place.addressComponents ?? [];
            if (country && !isInCountry(components, country)) return null;
            return {
              label: s.placePrediction.text.toString(),
              lat: loc.lat(),
              lng: loc.lng(),
              components: toGeoComponents(components),
            };
          }),
        );
        return resolved.filter((x): x is GeoSuggestion => x !== null);
      } catch {
        return [];
      }
    },
  };
}
