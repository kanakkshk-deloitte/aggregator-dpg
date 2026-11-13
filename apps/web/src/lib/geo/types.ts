/**
 * Shared shapes for address autocomplete.
 *
 * Matches Signals-DPG `apps/ui/src/lib/geo/types.ts` so `location` fields
 * behave the same in both apps.
 *
 * One difference: `GeoComponents` members are `?: string | undefined` because
 * this app uses `exactOptionalPropertyTypes` and the providers assign
 * `undefined` explicitly.
 *
 * @module apps/web/lib/geo/types
 */
export interface LatLng {
  lat: number;
  lng: number;
}

export interface GeoComponents {
  locality?: string | undefined; // area / sublocality / neighbourhood
  city?: string | undefined;
  state?: string | undefined;
  postcode?: string | undefined;
  country?: string | undefined;
}

export interface GeoSuggestion extends LatLng {
  /** Human-readable label shown in the dropdown. */
  label: string;
  components?: GeoComponents;
}

export interface GeoProvider {
  /** Returns ranked suggestions for a free-text query (empty array on error). */
  suggest(query: string, signal?: AbortSignal): Promise<GeoSuggestion[]>;
}
