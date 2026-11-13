/**
 * CSV template generator for bulk uploads. Produces a header row (required
 * columns first, then optional) plus one example row derived from the JSON
 * Schema, showing how to format each cell, including array delimiters.
 *
 * @module apps/api/services/csv-template
 */

import type { JsonSchema } from '@aggregator-dpg/schema-loader/interface';
import {
  WELL_KNOWN_COLUMNS,
  wellKnownColumnMeta,
} from '@aggregator-dpg/shared-primitives/bulk-columns';

/**
 * Example cell for a well-known column, or undefined when `name` is a normal
 * schema property. Well-known columns have no JSON Schema to sample from.
 */
export function wellKnownExample(name: string): string | undefined {
  return wellKnownColumnMeta(name)?.example;
}

export interface CsvTemplateOptions {
  /**
   * Delimiter used to join array-typed cells, from the network binding's
   * `csv_array_delimiter`. Must match what the bulk parser splits on
   * (`apps/worker/src/jobs/bulk-row-process.ts`).
   */
  arrayDelimiter?: string;
  /** Set false to emit a header-only template. */
  exampleRow?: boolean;
  /**
   * The domain's identity selectors (`ResolvedDomain.identity`), naming which
   * columns hold the name / phone / email.
   *
   * Used to give those columns valid sample values. The XLSX template takes
   * the same option so both formats agree.
   */
  identity?: IdentitySelectors | undefined;
}

/**
 * The columns holding the name / phone / email, from the network binding.
 *
 * Structurally `ResolvedDomain.identity`, redeclared here so `csv-template`
 * stays free of a `network-config` dependency.
 */
export interface IdentitySelectors {
  name: string;
  phone: string;
  email?: string | undefined;
}

/**
 * Column order for a participant schema: required properties first (in the
 * schema's own `required` order), then every remaining property in declaration
 * order.
 *
 * Also used by the XLSX template, so both formats have the same columns in the
 * same order.
 *
 * @param schema - Participant JSON Schema.
 * @returns Property names in template column order.
 */
export function orderedColumns(schema: JsonSchema): string[] {
  const properties = (schema['properties'] as Record<string, Record<string, unknown>>) ?? {};
  const required = Array.isArray(schema['required']) ? (schema['required'] as string[]) : [];
  const requiredSet = new Set(required);

  const ordered: string[] = [];
  for (const r of required) {
    if (properties[r]) ordered.push(r);
  }
  for (const name of Object.keys(properties)) {
    if (!requiredSet.has(name)) ordered.push(name);
  }
  // Well-known columns go last, unless the schema already has that name (the schema wins).
  for (const name of WELL_KNOWN_COLUMNS) {
    if (!properties[name]) ordered.push(name);
  }
  return ordered;
}

/**
 * Builds the downloadable CSV template for a participant schema.
 *
 * @param schema - The participant JSON Schema (object-typed, draft 2020-12).
 * @param options - Array delimiter, example-row toggle, identity selectors.
 * @returns CSV text: header line, then (by default) one example line.
 */
export function buildCsvTemplate(schema: JsonSchema, options: CsvTemplateOptions = {}): string {
  const { arrayDelimiter = '|', exampleRow = true, identity } = options;
  const properties = (schema['properties'] as Record<string, Record<string, unknown>>) ?? {};
  const ordered = orderedColumns(schema);

  const header = ordered.map(escapeCsvCell).join(',') + '\n';
  if (!exampleRow) return header;

  const example =
    ordered
      .map((name) => {
        const wellKnown = wellKnownExample(name);
        if (wellKnown !== undefined) return escapeCsvCell(wellKnown);
        const prop = properties[name] ?? {};
        const identityCell =
          identity === undefined ? undefined : identityExample(name, prop, identity);
        return escapeCsvCell(identityCell ?? exampleValue(name, prop, arrayDelimiter));
      })
      .join(',') + '\n';
  return header + example;
}

/**
 * True when a candidate identity value satisfies the column's own declaration.
 *
 * A value that fails the column's `format` or `pattern` would be rejected by
 * the row parser. When this returns `false` the caller uses `exampleValue`.
 *
 * @param prop - The column's schema fragment.
 * @param candidate - The identity value being considered for the cell.
 * @param satisfiesFormat - The one `format` this candidate is known to meet,
 *   or undefined when it meets none.
 * @returns `true` when the candidate can be used as-is.
 */
function fitsProperty(
  prop: Record<string, unknown>,
  candidate: string,
  satisfiesFormat?: string,
): boolean {
  const format = prop['format'];
  if (typeof format === 'string' && format !== satisfiesFormat) return false;

  const pattern = prop['pattern'];
  if (typeof pattern !== 'string') return true;
  try {
    return new RegExp(pattern).test(candidate);
  } catch {
    return false;
  }
}

/**
 * Derives a realistic sample value for one configured identity column.
 *
 * Without it, an identity column with no `format` or `pattern` would sample as
 * "Example <Title>", which the row parser rejects for a phone. Shared by both
 * template formats.
 *
 * - A column that declares its own `format` or `pattern` is left to
 *   `exampleValue` when the placeholder does not fit it.
 * - The name sample uses the column's own label, since `identity.name` may
 *   not name a person (for example `jobProviderName`).
 *
 * @param name - Column (property) name.
 * @param prop - The column's schema fragment.
 * @param identity - The domain's identity selectors.
 * @param rowIndex - Zero-based sample row index; 0 for the CSV's single row.
 * @returns The cell value, or undefined when this is not an identity column,
 *   or when the column's own declaration rejects the placeholder.
 */
export function identityExample(
  name: string,
  prop: Record<string, unknown>,
  identity: IdentitySelectors,
  rowIndex = 0,
): string | undefined {
  const label = str(prop, 'title') ?? name;
  let candidate: { value: string; format?: string };
  if (name === identity.name) {
    candidate = { value: `Sample ${label} ${rowIndex + 1}` };
  } else if (name === identity.phone) {
    candidate = { value: `98765${String(10000 + rowIndex).slice(-5)}` };
  } else if (name === identity.email) {
    candidate = { value: `person${rowIndex + 1}@example.com`, format: 'email' };
  } else {
    return undefined;
  }

  return fitsProperty(prop, candidate.value, candidate.format) ? candidate.value : undefined;
}

/** Reads a schema keyword as a string, or undefined when absent/wrong type. */
function str(prop: Record<string, unknown>, key: string): string | undefined {
  return typeof prop[key] === 'string' ? (prop[key] as string) : undefined;
}

/** Reads a schema keyword as a number, or undefined when absent/wrong type. */
function num(prop: Record<string, unknown>, key: string): number | undefined {
  return typeof prop[key] === 'number' ? (prop[key] as number) : undefined;
}

/**
 * Example for an array-typed property: two entries, so the cell demonstrates
 * the delimiter the parser splits on rather than looking like a single value.
 *
 * @param prop - The property's schema fragment.
 * @param arrayDelimiter - Delimiter to join with.
 * @returns The joined cell value.
 */
function arrayExample(prop: Record<string, unknown>, arrayDelimiter: string): string {
  const items = (prop['items'] as Record<string, unknown> | undefined) ?? {};
  const count = Math.max(2, num(prop, 'minItems') ?? 1);
  const itemEnum = Array.isArray(items['enum']) ? (items['enum'] as unknown[]) : undefined;
  const values = itemEnum
    ? itemEnum.slice(0, Math.min(count, itemEnum.length)).map(String)
    : Array.from({ length: count }, (_, i) => `example ${i + 1}`);
  return values.join(arrayDelimiter);
}

/**
 * Example for a numeric property: the midpoint when the schema bounds it on
 * both sides, so the value is inside the range rather than on an edge.
 *
 * @param prop - The property's schema fragment.
 * @param isInteger - Whether the schema type is `integer`.
 * @returns The number as a string.
 */
function numberExample(prop: Record<string, unknown>, isInteger: boolean): string {
  const min = num(prop, 'minimum');
  const max = num(prop, 'maximum');
  if (min !== undefined && max !== undefined) {
    const mid = (min + max) / 2;
    return String(isInteger ? Math.round(mid) : mid);
  }
  return String(min ?? max ?? 1);
}

/** Example for a recognised `format`, or undefined when the format is unknown. */
function formatExample(format: string | undefined): string | undefined {
  switch (format) {
    case 'email':
      return 'person@example.com';
    case 'uri':
    case 'url':
      return 'https://example.com';
    case 'date':
      return '2024-01-01';
    case 'date-time':
      return '2024-01-01T00:00:00Z';
    default:
      return undefined;
  }
}

/**
 * A value that satisfies a simple `pattern`, or undefined when none can be
 * synthesised.
 *
 * Handles digit-run patterns (phone, pincode, Aadhaar): fixed (`{10}`) and
 * bounded (`{6,10}`) runs, an optional literal prefix (`^\+91[0-9]{10}$`), and
 * a leading class (`^[6-9][0-9]{9}$`).
 *
 * The result is tested against the pattern before it is returned. Anything
 * that does not match yields undefined, and the caller leaves the cell blank.
 *
 * @param pattern - The schema's `pattern`, when it declares one.
 * @returns A string matching the pattern, or undefined.
 */
function patternExample(pattern: string | undefined): string | undefined {
  if (pattern === undefined) return undefined;

  // ^<prefix?><[a-b]?>(digit-class){n[,m]}$ — the prefix is a literal run, the
  // optional leading class fixes the first digit (`^[6-9][0-9]{9}$`).
  const m =
    /^\^?((?:\\\+|\+)?[0-9A-Za-z-]*?)(?:\[(\d)-\d\])?(?:\[0-9\]|\\d)\{(\d+)(?:,(\d+))?\}\$?$/.exec(
      pattern,
    );
  if (!m) return undefined;

  const prefix = (m[1] ?? '').replace(String.raw`\+`, '+');
  const firstDigit = m[2];
  const min = Number(m[3]);
  const runLength = firstDigit === undefined ? min : min + 1;
  const digits = '9876543210';
  if (runLength > digits.length * 4) return undefined;

  // `min` characters either way: with no leading class the whole run is `min`
  // long, and with one the class supplies the first and `min` more follow it.
  const body =
    (firstDigit ?? '') + digits.repeat(Math.ceil(runLength / digits.length)).slice(0, min);
  const candidate = prefix + body;

  // Verify before returning.
  try {
    return new RegExp(pattern).test(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Derives a deterministic, schema-valid example value for one property.
 *
 * Uses only the schema (enum, format, pattern, bounds), never the field name.
 *
 * @param name - Property name, used only as a label fallback.
 * @param prop - The property's schema fragment.
 * @param arrayDelimiter - Delimiter for array-typed cells.
 * @returns The example cell value.
 */
export function exampleValue(
  name: string,
  prop: Record<string, unknown>,
  arrayDelimiter: string,
): string {
  const type = str(prop, 'type') ?? 'string';

  if (type === 'array') return arrayExample(prop, arrayDelimiter);

  const ownEnum = prop['enum'];
  if (Array.isArray(ownEnum) && ownEnum.length > 0) return String(ownEnum[0]);

  if (type === 'integer' || type === 'number') return numberExample(prop, type === 'integer');
  if (type === 'boolean') return 'true';

  // A link field: the network-config loader rewrites both `x-uri` and
  // `format: "uri"` to the Signals URL rule, which marks it `x-uri` and drops
  // the format (#904). Its pattern is too general for `patternExample`.
  if (prop['x-uri'] === true) return 'https://example.com';

  const fromFormat = formatExample(str(prop, 'format'));
  if (fromFormat !== undefined) return fromFormat;

  const pattern = str(prop, 'pattern');
  const fromPattern = patternExample(pattern);
  if (fromPattern !== undefined) return fromPattern;
  // A pattern we could not satisfy: leave the cell blank rather than emit a value the parser rejects.
  if (pattern !== undefined) return '';

  const base = `Example ${str(prop, 'title') ?? name}`;
  const minLength = num(prop, 'minLength') ?? 0;
  return minLength > base.length ? base.padEnd(minLength, '.') : base;
}

function escapeCsvCell(value: string): string {
  if (value === '') return '';
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}
