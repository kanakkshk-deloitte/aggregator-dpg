/**
 * Well-known bulk-CSV columns that are not item-schema properties.
 *
 * These columns are allowed in the header on top of the item schema. They are
 * removed from the row payload before Ajv runs and sent to their own
 * destination, so they never reach `item_state`. They are always optional.
 */

/**
 * `lat|lng`, pipe-separated.
 *
 * A pipe is used because a comma in an unquoted CSV cell shifts later columns.
 * It matches the `csv_array_delimiter` used for array cells.
 */
export const GEO_LOCATION_COLUMN = 'geo_location';

/**
 * Operator-facing metadata for a well-known column.
 *
 * These columns have no JSON Schema, so this supplies the label, description
 * and example for the CSV and XLSX templates.
 */
export interface WellKnownColumnMeta {
  /** Human label, standing in for a schema `title`. */
  title: string;
  /** One-line explanation, standing in for a schema `description`. */
  description: string;
  /** Example cell value. */
  example: string;
}

export const WELL_KNOWN_COLUMN_META: Readonly<Record<string, WellKnownColumnMeta>> = {
  [GEO_LOCATION_COLUMN]: {
    title: 'Location coordinates',
    // Names the separator because users tend to type a comma.
    description:
      'Optional. Latitude and longitude separated by a pipe — for example 12.9352|77.6245. ' +
      'Use a pipe, not a comma. Leave blank to have the address looked up instead.',
    example: '12.9352|77.6245',
  },
};

/** Metadata for `name`, or undefined when it is a normal schema property. */
export function wellKnownColumnMeta(name: string): WellKnownColumnMeta | undefined {
  return WELL_KNOWN_COLUMN_META[name];
}

/** Every well-known column, for the header allowlist. */
export const WELL_KNOWN_COLUMNS: readonly string[] = [GEO_LOCATION_COLUMN];

/** A point as Signals' `item_locations` accepts it. */
export interface ParsedGeoLocation {
  lat: number;
  lng: number;
}

export type GeoLocationParse =
  /** Column absent or blank. The caller geocodes the address instead. */
  | { status: 'absent' }
  | { status: 'ok'; value: ParsedGeoLocation }
  /**
   * Present but unusable. The row still passes and the address is geocoded.
   * `reason` never contains the raw cell, because coordinates are PII.
   */
  | { status: 'invalid'; reason: string };

/**
 * Parses a `geo_location` cell into a point.
 *
 * Unusable input does not fail the row; the address is geocoded instead.
 * Failing it would force a re-upload, and Signals `onboard` duplicates rows
 * that already succeeded.
 *
 * @param raw - The cell value.
 * @returns The parsed point, `absent`, or `invalid` with a reason.
 */
export function parseGeoLocation(raw: unknown): GeoLocationParse {
  if (typeof raw !== 'string') return { status: 'absent' };
  const trimmed = raw.trim();
  if (trimmed === '') return { status: 'absent' };

  const parts = trimmed.split('|');
  if (parts.length !== 2) {
    return {
      status: 'invalid',
      reason: `expected two values separated by '|' (lat|lng), found ${parts.length}`,
    };
  }

  const latRaw = parts[0]?.trim() ?? '';
  const lngRaw = parts[1]?.trim() ?? '';
  // Check before `Number()`, which turns '' into 0.
  if (latRaw === '' || lngRaw === '') {
    return { status: 'invalid', reason: 'latitude and longitude must both be present' };
  }

  const lat = Number(latRaw);
  const lng = Number(lngRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { status: 'invalid', reason: 'latitude and longitude must both be numbers' };
  }
  if (lat < -90 || lat > 90) {
    return { status: 'invalid', reason: 'latitude out of range (-90..90)' };
  }
  if (lng < -180 || lng > 180) {
    return { status: 'invalid', reason: 'longitude out of range (-180..180)' };
  }
  return { status: 'ok', value: { lat, lng } };
}

/**
 * True when the item schema itself declares `name` as a property.
 *
 * When the schema owns the name, the column is treated as a normal schema
 * property and is not extracted.
 *
 * @param schema - The item schema.
 * @param name - The column name.
 * @returns Whether the schema declares `name` in `properties`.
 */
export function schemaOwnsColumn(
  schema: Record<string, unknown> | null | undefined,
  name: string,
): boolean {
  const props = schema?.['properties'];
  if (!props || typeof props !== 'object') return false;
  return Object.hasOwn(props as Record<string, unknown>, name);
}
