/**
 * `parseGeoLocation` — the `geo_location` CSV cell (#807).
 *
 * The behaviour worth pinning is that unusable input is NOT a row failure.
 * Coordinates only let Signals skip geocoding, so a bad cell costs a geocoder
 * call rather than correctness; failing the row would push the operator into a
 * re-upload, and `onboard` always inserts, so a re-upload duplicates every row
 * that already succeeded.
 */
import { describe, it, expect } from 'vitest';
import {
  parseGeoLocation,
  schemaOwnsColumn,
  WELL_KNOWN_COLUMNS,
  GEO_LOCATION_COLUMN,
} from '../bulk-columns/index.js';

describe('parseGeoLocation', () => {
  it('parses a pipe-separated pair', () => {
    expect(parseGeoLocation('12.9352|77.6245')).toEqual({
      status: 'ok',
      value: { lat: 12.9352, lng: 77.6245 },
    });
  });

  it('tolerates whitespace around each value', () => {
    expect(parseGeoLocation('  12.9352 | 77.6245  ')).toEqual({
      status: 'ok',
      value: { lat: 12.9352, lng: 77.6245 },
    });
  });

  it('accepts negative coordinates', () => {
    expect(parseGeoLocation('-33.8688|-70.6693')).toEqual({
      status: 'ok',
      value: { lat: -33.8688, lng: -70.6693 },
    });
  });

  it.each([
    ['column absent', undefined],
    ['non-string cell', 42],
    ['empty cell', ''],
    ['whitespace-only cell', '   '],
  ])('treats %s as absent, so the address is geocoded as before', (_label, raw) => {
    expect(parseGeoLocation(raw)).toEqual({ status: 'absent' });
  });

  it.each([
    ['one value only', '12.9352'],
    ['a trailing separator', '12.9352|'],
    ['a leading separator', '|77.6245'],
    ['three values', '12.9352|77.6245|extra'],
    ['non-numeric values', 'twelve|seventy-seven'],
    ['latitude out of range', '91|77.6245'],
    ['longitude out of range', '12.9352|181'],
  ])('reports %s as invalid rather than throwing', (_label, raw) => {
    const result = parseGeoLocation(raw);
    expect(result.status).toBe('invalid');
  });

  // Every invalid branch, not just one: the reason is operator-facing and a
  // participant's coordinates are PII, so an interpolated cell anywhere here
  // leaks them into errors.csv and the logs. One case per `return` in the
  // invalid path.
  it.each([
    ['part count', '12.9352'],
    ['empty segment', '12.9352|'],
    ['non-finite', 'twelve|seventy'],
    ['lat out of range', '91|77.6245'],
    ['lng out of range', '12.9352|999'],
  ])('never echoes the raw cell in the %s reason — coordinates are PII', (_label, raw) => {
    const result = parseGeoLocation(raw);
    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') return;
    for (const fragment of raw.split('|').filter(Boolean)) {
      expect(result.reason).not.toContain(fragment);
    }
  });

  it('exposes geo_location in the header allowlist', () => {
    expect(WELL_KNOWN_COLUMNS).toContain(GEO_LOCATION_COLUMN);
  });
});

describe('schemaOwnsColumn', () => {
  it('is true when the schema declares the property itself', () => {
    expect(
      schemaOwnsColumn({ properties: { geo_location: { type: 'string' } } }, GEO_LOCATION_COLUMN),
    ).toBe(true);
  });

  it('is false when the schema declares other properties', () => {
    expect(
      schemaOwnsColumn({ properties: { name: { type: 'string' } } }, GEO_LOCATION_COLUMN),
    ).toBe(false);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a schema with no properties key', {}],
    ['a non-object properties value', { properties: 'nonsense' }],
  ])('is false for %s rather than throwing', (_label, schema) => {
    expect(schemaOwnsColumn(schema as Record<string, unknown> | null, GEO_LOCATION_COLUMN)).toBe(
      false,
    );
  });

  it('does not treat an inherited Object.prototype key as owned', () => {
    // `Object.hasOwn`, not `in` — otherwise every schema would "own" toString
    // and a column named that would silently never be extracted.
    expect(schemaOwnsColumn({ properties: {} }, 'toString')).toBe(false);
  });
});
