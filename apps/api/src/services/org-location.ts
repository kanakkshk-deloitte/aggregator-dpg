/**
 * Org-detail mapping for org registration (`@aggregator-dpg/api`).
 *
 * The org form's `address` (and legacy `state`) and picked `coordinates`
 * become one Beckn location, matching migration 0028. `addressDistrict` has
 * no Beckn key; it stays in `profile`.
 */

import type { BecknLocation } from '@aggregator-dpg/shared-primitives/aggregator';

/** The org form's address block (all optional). */
export interface OrgFormAddress {
  streetAddress?: string | undefined;
  addressLocality?: string | undefined;
  addressDistrict?: string | undefined;
  addressRegion?: string | undefined;
  postalCode?: string | undefined;
  addressCountry?: string | undefined;
}

/** A trimmed, non-empty string, or `undefined`. */
function nz(v: string | null | undefined): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

/**
 * The org's `locations` from its form's address, state and picked point. A
 * location is built only from a street, locality or real coordinates; a state
 * alone gives `[]`.
 *
 * @param address - The form's address block.
 * @param state - The legacy standalone state field.
 * @param coordinates - `[lng, lat]` picked from the address autocomplete.
 * @returns Zero or one Beckn location.
 */
export function orgLocationsFrom(
  address: OrgFormAddress | null | undefined,
  state: string | null | undefined,
  coordinates: readonly [number, number] | null | undefined,
): BecknLocation[] {
  const street = nz(address?.streetAddress);
  const locality = nz(address?.addressLocality);
  const realPoint =
    Array.isArray(coordinates) &&
    coordinates.length === 2 &&
    (coordinates[0] !== 0 || coordinates[1] !== 0);
  if (!street && !locality && !realPoint) return [];
  const region = nz(address?.addressRegion) ?? nz(state);
  const postalCode = nz(address?.postalCode);
  const country = nz(address?.addressCountry);
  return [
    {
      geo: { type: 'Point', coordinates: realPoint ? [coordinates[0], coordinates[1]] : [0, 0] },
      address: {
        ...(street ? { streetAddress: street } : {}),
        ...(locality ? { addressLocality: locality } : {}),
        ...(region ? { addressRegion: region } : {}),
        ...(postalCode ? { postalCode } : {}),
        ...(country ? { addressCountry: country } : {}),
      },
    },
  ];
}
