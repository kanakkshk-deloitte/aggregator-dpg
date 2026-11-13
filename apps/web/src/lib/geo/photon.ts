/**
 * Key-less geocoding fallback, used when no Google Maps key is configured.
 *
 * Matches Signals-DPG `apps/ui/src/lib/geo/photon.ts`, with minor type fixes.
 *
 * @module apps/web/lib/geo/photon
 */
import type { GeoComponents, GeoProvider, GeoSuggestion } from './types';

const DEFAULT_PHOTON_URL = 'https://photon.komoot.io';

/**
 * Timeout for a single geocoder call.
 *
 * The caller's `signal` only cancels on the next keystroke, so a separate
 * deadline stops a stalled request from hanging.
 */
const REQUEST_TIMEOUT_MS = 4_000;

interface PhotonFeature {
  geometry?: { coordinates?: [number, number] }; // [lng, lat]
  properties?: {
    name?: string;
    city?: string;
    state?: string;
    postcode?: string;
    country?: string;
    /** ISO 3166-1 alpha-2, e.g. `IN`. */
    countrycode?: string;
    /** Feature granularity, e.g. `city`, `district`, `state`, `country`. */
    type?: string;
  };
}

/**
 * Combines the caller's cancellation signal with a request deadline.
 *
 * Does not use `AbortSignal.any`, which some target browsers lack.
 *
 * @param signal - The caller's cancel signal, if any.
 * @returns The combined signal, and `clear` to call once the request settles.
 */
function withDeadline(signal?: AbortSignal): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const cancel = () => {
    clearTimeout(timer);
    controller.abort();
  };
  if (signal) {
    if (signal.aborted) cancel();
    else signal.addEventListener('abort', cancel, { once: true });
  }
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

/** Feature types too coarse to use as an address. */
const COARSE_TYPES = new Set(['country', 'state']);

/**
 * Whether a feature is inside `country` and finer than state level.
 *
 * Needed because older Photon servers ignore the `countrycode` param.
 *
 * @param f - A Photon feature.
 * @param country - Upper-case ISO 3166-1 alpha-2 code.
 * @returns True when the feature may be suggested.
 */
function isInCountry(f: PhotonFeature, country: string): boolean {
  const p = f.properties ?? {};
  return p.countrycode?.toUpperCase() === country && !(p.type && COARSE_TYPES.has(p.type));
}

/**
 * Maps a Photon FeatureCollection JSON into suggestions. Exported for testing.
 *
 * @param json - The Photon response body.
 * @returns The suggestions.
 */
export function parsePhotonFeatures(json: unknown): GeoSuggestion[] {
  const features = (json as { features?: PhotonFeature[] })?.features ?? [];
  const out: GeoSuggestion[] = [];
  for (const f of features) {
    const coords = f.geometry?.coordinates;
    if (coords?.length !== 2) continue;
    const [lng, lat] = coords;
    if (typeof lat !== 'number' || typeof lng !== 'number') continue;
    const p = f.properties ?? {};
    const label = [p.name, p.city, p.state, p.postcode, p.country]
      .filter((s): s is string => Boolean(s?.trim()))
      .join(', ');
    const components: GeoComponents = {
      locality: p.name,
      city: p.city,
      state: p.state,
      postcode: p.postcode,
      country: p.country,
    };
    out.push({ label: label || `${lat}, ${lng}`, lat, lng, components });
  }
  return out;
}

/**
 * Photon autocomplete provider.
 *
 * `country` (e.g. `IN`) restricts suggestions to that country. It is sent as
 * `countrycode` and re-checked on each feature. Country- and state-level
 * features are dropped.
 *
 * @param baseUrl - Photon host. Defaults to the public one.
 * @param country - Optional country restriction.
 * @returns The provider.
 */
export function createPhotonProvider(baseUrl = DEFAULT_PHOTON_URL, country?: string): GeoProvider {
  return {
    async suggest(query, signal) {
      const q = query.trim();
      if (!q) return [];
      const deadline = withDeadline(signal);
      try {
        const base = `${baseUrl.replace(/\/$/, '')}/api?q=${encodeURIComponent(q)}&limit=5`;
        const url = country ? `${base}&countrycode=${country}` : base;
        const res = await fetch(url, { signal: deadline.signal });
        if (!res.ok) return [];
        const json = (await res.json()) as { features?: PhotonFeature[] };
        if (!country) return parsePhotonFeatures(json);
        return parsePhotonFeatures({
          features: (json.features ?? []).filter((f) => isInCountry(f, country)),
        });
      } catch {
        return [];
      } finally {
        deadline.clear();
      }
    },
  };
}
