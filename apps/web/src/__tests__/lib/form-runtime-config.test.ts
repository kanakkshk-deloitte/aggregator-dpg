/**
 * Unit tests for the form widgets' runtime configuration reader.
 *
 * The behaviour worth pinning is how "unconfigured" is represented. Helm renders
 * an unset chart value as `""` rather than omitting the variable, so treating a
 * blank string as configured would hand the widgets an empty Maps key and an
 * empty reference base URL — a broken autocomplete instead of the intended
 * graceful fallback to a plain text input.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { getFormRuntimeConfig, DEFAULT_COLLEGE_DATASET } from '@/lib/form-runtime-config';

const KEYS = [
  'GOOGLE_MAPS_API_KEY',
  'PHOTON_URL',
  'COLLEGE_DATASET',
  'REFERENCE_BASE_URL',
  'GEO_COUNTRY',
] as const;

afterEach(() => {
  for (const key of KEYS) delete process.env[key];
});

describe('getFormRuntimeConfig', () => {
  it('reads GEO_COUNTRY as an upper-case ISO code (signals-dpg#785)', () => {
    process.env.GEO_COUNTRY = ' in ';
    expect(getFormRuntimeConfig().geoCountry).toBe('IN');
  });

  it('omits geoCountry when GEO_COUNTRY is unset, blank, or not a two-letter code', () => {
    expect(getFormRuntimeConfig()).not.toHaveProperty('geoCountry');
    process.env.GEO_COUNTRY = '';
    expect(getFormRuntimeConfig()).not.toHaveProperty('geoCountry');
    process.env.GEO_COUNTRY = 'India';
    expect(getFormRuntimeConfig()).not.toHaveProperty('geoCountry');
  });

  it('reads every configured value', () => {
    process.env.GOOGLE_MAPS_API_KEY = 'maps-key-123';
    process.env.PHOTON_URL = 'https://photon.internal';
    process.env.COLLEGE_DATASET = 'up';
    process.env.REFERENCE_BASE_URL = 'https://cdn.example/reference/';

    expect(getFormRuntimeConfig()).toEqual({
      googleMapsApiKey: 'maps-key-123',
      photonUrl: 'https://photon.internal',
      collegeDataset: 'up',
      referenceBaseUrl: 'https://cdn.example/reference/',
    });
  });

  it('omits optional keys entirely when unset, rather than setting them undefined', () => {
    // Absence, not a present-but-undefined property: the widgets spread this
    // object into a provider config, and `exactOptionalPropertyTypes` makes the
    // distinction a real one rather than a stylistic preference.
    const config = getFormRuntimeConfig();

    expect(config).not.toHaveProperty('googleMapsApiKey');
    expect(config).not.toHaveProperty('photonUrl');
    expect(config).not.toHaveProperty('referenceBaseUrl');
  });

  it('treats a blank value as unset — the shape Helm renders for an unset chart value', () => {
    process.env.GOOGLE_MAPS_API_KEY = '';
    process.env.REFERENCE_BASE_URL = '   ';

    const config = getFormRuntimeConfig();

    expect(config).not.toHaveProperty('googleMapsApiKey');
    expect(config).not.toHaveProperty('referenceBaseUrl');
  });

  it('trims surrounding whitespace off a real value', () => {
    process.env.GOOGLE_MAPS_API_KEY = '  maps-key-123  ';

    expect(getFormRuntimeConfig().googleMapsApiKey).toBe('maps-key-123');
  });

  it('defaults the college region when unset', () => {
    expect(getFormRuntimeConfig().collegeDataset).toBe(DEFAULT_COLLEGE_DATASET);
  });

  it('defaults the college region when set blank', () => {
    process.env.COLLEGE_DATASET = '';

    expect(getFormRuntimeConfig().collegeDataset).toBe(DEFAULT_COLLEGE_DATASET);
  });

  it('always populates collegeDataset, so callers never build a "colleges-undefined" id', () => {
    expect(typeof getFormRuntimeConfig().collegeDataset).toBe('string');
    expect(getFormRuntimeConfig().collegeDataset.length).toBeGreaterThan(0);
  });
});
