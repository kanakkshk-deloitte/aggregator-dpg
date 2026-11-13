/**
 * Contract tests over the on-disk aggregator schemas for the single Address
 * field (#810).
 *
 * These read `config/` directly rather than a fixture, because the change they
 * guard is spread across 20 files in six network/brand directories and the
 * failure mode is silent: a `.ui.json` that forgets `ui:widget` renders an
 * ordinary text box, and a schema that keeps `addressLocality` renders a second
 * input — both look like working forms, so only a cross-file assertion catches
 * the drift.
 *
 * Three of the network directories are symlinks to the shared base
 * (`blue_dot`, `purple_dot`, `blue_dot/upsdm`), so they are covered by the base
 * entry rather than listed separately.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const CONFIG_ROOT = path.resolve(__dirname, '../../../../../config');

/** Every real (non-symlinked) directory holding aggregator schemas. */
const SCHEMA_DIRS = [
  'schemas/aggregator',
  'blue_dot/ka-dhwd/schemas/aggregator',
  'blue_dot/up-gzb/schemas/aggregator',
  'orange_dot/schemas/aggregator',
  'orange_dot/onetac/schemas/aggregator',
  'purple_dot/alimco/schemas/aggregator',
];

/** Parts the form no longer collects — each one is a second visible input. */
const RETIRED_PARTS = [
  'addressLocality',
  'addressRegion',
  'addressDistrict',
  'postalCode',
  'addressCountry',
];

function readJson(dir: string, file: string): Record<string, unknown> | null {
  const p = path.join(CONFIG_ROOT, dir, file);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
}

/** Asserts an address block exposes exactly the one free-text field. */
function expectSingleAddressField(address: Record<string, unknown>, where: string): void {
  const props = address['properties'] as Record<string, unknown>;
  expect(Object.keys(props), where).toEqual(['streetAddress']);
  for (const part of RETIRED_PARTS) {
    expect(props[part], `${where} still collects ${part}`).toBeUndefined();
  }
}

/** Asserts a ui block routes the field to the autocomplete widget. */
function expectAutocompleteWidget(ui: Record<string, unknown>, where: string): void {
  const field = ui['streetAddress'] as Record<string, unknown>;
  expect(field, `${where} has no streetAddress ui block`).toBeDefined();
  expect(field['ui:widget'], where).toBe('location-autocomplete');
  // Without this the widget renders and autocompletes but never reports the
  // coordinate it resolved — the form silently stores no geo point.
  const options = field['ui:options'] as Record<string, unknown> | undefined;
  expect(options?.['isPrimaryLocation'], `${where} is not the primary location`).toBe(true);
}

// Mirrors the owner block below: a directory that ships no coordinator schema
// is excluded by name rather than exploding on `undefined['properties']`, and
// the count assertion stops the filter from silently emptying the suite.
const COORDINATOR_DIRS = SCHEMA_DIRS.filter((d) => readJson(d, 'registration.v1.json') !== null);

it('finds a coordinator schema to check', () => {
  expect(COORDINATOR_DIRS.length).toBeGreaterThan(0);
});

describe.each(COORDINATOR_DIRS)('coordinator registration schema — %s', (dir) => {
  const schema = readJson(dir, 'registration.v1.json');
  const ui = readJson(dir, 'registration.v1.ui.json');

  it('exposes one Address field under locations[].address', () => {
    const locations = (schema!['properties'] as Record<string, never>)['locations'];
    const address = (locations['items']['properties'] as Record<string, never>)['address'];
    expectSingleAddressField(address, dir);
  });

  it('renders that field with the autocomplete widget', () => {
    const items = (ui?.['locations'] as Record<string, never>)['items'];
    expectAutocompleteWidget(items['address'], dir);
  });

  it('keeps geo required, so the [0,0] placeholder still has a home', () => {
    // The coordinate is merged in at submit, not collected by the form. If
    // `geo` ever stops being required this placeholder can go — until then,
    // dropping it from the seeded form data makes every submission invalid.
    const locations = (schema!['properties'] as Record<string, never>)['locations'];
    expect(locations['items']['required']).toContain('geo');
  });
});

describe('owner registration schema', () => {
  const OWNER_DIRS = SCHEMA_DIRS.filter((d) => readJson(d, 'org-registration.v1.json') !== null);

  it('covers every directory that ships an owner schema', () => {
    expect(OWNER_DIRS.length).toBeGreaterThan(0);
  });

  it.each(OWNER_DIRS)('%s exposes one Address field and no State input', (dir) => {
    const schema = readJson(dir, 'org-registration.v1.json')!;
    const props = schema['properties'] as Record<string, Record<string, unknown>>;
    expectSingleAddressField(props['address']!, dir);
    // `state` was either the only address input (base) or a hidden field
    // derived from the address block. Neither survives a free-text address.
    expect(props['state'], `${dir} still collects state`).toBeUndefined();
  });

  it.each(OWNER_DIRS)('%s renders that field with the autocomplete widget', (dir) => {
    const ui = readJson(dir, 'org-registration.v1.ui.json')!;
    expectAutocompleteWidget(ui['address'] as Record<string, unknown>, dir);
    expect(ui['state'], `${dir} ui still references state`).toBeUndefined();
    expect(ui['ui:order'], `${dir} ui:order still references state`).not.toContain('state');
  });
});
