/**
 * Selects and memoises the active geo provider.
 *
 * Matches Signals-DPG `apps/ui/src/lib/geo/provider.ts`: Google Places when a
 * maps key is set, key-less Photon otherwise, a session cache in front, and a
 * PII-mask guard so masked values are never geocoded.
 *
 * Unlike Signals, config arrives per request from React context, so providers
 * are memoised by the config they were built from.
 *
 * @module apps/web/lib/geo/provider
 */

import type { GeoProvider } from './types';
import { createPhotonProvider } from './photon';
import { createGooglePlacesProvider } from './google-places';
import { looksLikePIIMask } from './pii-mask';
import { withGeoCache } from './geo-cache';

export interface GeoProviderConfig {
  googleMapsApiKey?: string;
  photonUrl?: string;
  /** ISO 3166-1 alpha-2 country that suggestions are restricted to. */
  country?: string;
}

const cache = new Map<string, GeoProvider>();

/**
 * Returns the geo provider for a given configuration.
 *
 * Memoised so widget mounts share one Maps JS `<script>` load and one
 * suggestion cache.
 *
 * @param config - Maps key, Photon override and country, from the form runtime config.
 * @returns A provider whose `suggest` is cached and PII-mask guarded.
 */
export function getGeoProvider(config: GeoProviderConfig): GeoProvider {
  const key = `${config.googleMapsApiKey ?? ''}|${config.photonUrl ?? ''}|${config.country ?? ''}`;
  const existing = cache.get(key);
  if (existing) return existing;

  const base = withGeoCache(
    config.googleMapsApiKey
      ? createGooglePlacesProvider(config.googleMapsApiKey, config.country)
      : createPhotonProvider(config.photonUrl || undefined, config.country),
  );
  const provider: GeoProvider = {
    suggest: (query, signal) =>
      looksLikePIIMask(query) ? Promise.resolve([]) : base.suggest(query, signal),
  };
  cache.set(key, provider);
  return provider;
}
