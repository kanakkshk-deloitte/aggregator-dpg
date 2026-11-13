/**
 * Config-lint over every committed RJSF UI schema under `config/`.
 *
 * These files are authored by non-engineers (that is the point of the
 * schema-driven forms), so the invariants a widget silently depends on have to
 * be asserted somewhere. This suite is that somewhere: it walks the real
 * `config/**` tree rather than a fixture, so a new network or brand copied from
 * an existing one is checked the moment it lands.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const CONFIG_ROOT = path.resolve(process.cwd(), '../../config');

interface JsonSchemaLike {
  properties?: Record<string, { type?: string; items?: { enum?: unknown[] } }>;
}

/** Recursively collects every `*.json` under `dir` that is not a `.ui.json`. */
function schemaFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return schemaFiles(full);
    if (!entry.name.endsWith('.json') || entry.name.endsWith('.ui.json')) return [];
    return [full];
  });
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

/**
 * Every `(schema file, property name)` pair in `config/` whose property is an
 * array-of-enum — the shape RJSF routes through its multi-select code path.
 */
const arrayEnumFields = schemaFiles(CONFIG_ROOT).flatMap((file) => {
  let schema: JsonSchemaLike;
  try {
    schema = readJson<JsonSchemaLike>(file);
  } catch {
    // Not every `.json` under config/ is a JSON Schema (brand.json, datasets).
    return [];
  }
  return Object.entries(schema.properties ?? {})
    .filter(([, prop]) => prop?.type === 'array' && Array.isArray(prop?.items?.enum))
    .map(([name]) => ({ file, name }));
});

describe('config/** UI schemas', () => {
  it('has array-of-enum fields to check (guards against a silently empty sweep)', () => {
    expect(arrayEnumFields.length).toBeGreaterThan(0);
  });

  // RJSF's multi-select path defaults to the *select* widget, and this repo's
  // themed SelectWidget is single-value: handed an array field it writes a
  // scalar, which RJSF then discards — the selection never sticks and a
  // `minItems: 1` field can never be satisfied. `FieldTemplate` also treats a
  // widget-less array as a container, which drops its label and description.
  // Both symptoms disappear once the field names a scalar-leaf widget
  // (`checkboxes`), so declaring one is mandatory, not cosmetic.
  it.each(arrayEnumFields)(
    'array-of-enum field $name in $file declares a ui:widget',
    ({ file, name }) => {
      const uiFile = `${file.slice(0, -'.json'.length)}.ui.json`;
      expect(fs.existsSync(uiFile), `${uiFile} is missing`).toBe(true);
      const ui = readJson<Record<string, { 'ui:widget'?: unknown }>>(uiFile);
      expect(typeof ui[name]?.['ui:widget']).toBe('string');
    },
  );
});
