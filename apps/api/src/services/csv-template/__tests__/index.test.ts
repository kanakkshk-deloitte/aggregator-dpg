import { describe, it, expect } from 'vitest';
import { buildCsvTemplate } from '../index.js';
import { URL_PATTERN, applyUrlRule } from '@aggregator-dpg/network-config/uri-fields';

/** Trimmed-down purple_dot-style seeker schema exercising every value kind. */
const SEEKER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['beneficiary_name', 'mobile_number', 'age', 'gender', 'disability_type'],
  properties: {
    beneficiary_name: { type: 'string', title: 'Name', minLength: 1 },
    mobile_number: { type: 'string', title: 'Mobile', pattern: '^[0-9]{10}$' },
    age: { type: 'integer', title: 'Age', minimum: 0, maximum: 120 },
    gender: { type: 'string', enum: ['Male', 'Female', 'Other'] },
    disability_type: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', enum: ['Low Vision', 'Blindness', 'Deaf'] },
    },
    email: { type: 'string', format: 'email' },
    pincode: { type: 'string', pattern: '^[0-9]{6}$' },
    catalog_url: { type: 'string', format: 'uri' },
    tags: { type: 'array', items: { type: 'string' } },
    consented: { type: 'boolean' },
  },
} as Record<string, unknown>;

function parse(csv: string): { header: string[]; example: string[] } {
  const lines = csv.trimEnd().split('\n');
  // naive split is fine — assertions below avoid commas inside cells except
  // where explicitly tested via the quoted-cell case.
  return { header: lines[0]!.split(','), example: (lines[1] ?? '').split(',') };
}

describe('buildCsvTemplate', () => {
  // The workbook takes `identity` for exactly this reason, and CSV is the
  // format an operator gets by default. Without the selectors a phone column
  // that declares no pattern samples as "Example Mobile", which
  // `normalisePhone` strips to zero digits and `bulk-row-process` rejects
  // before Ajv ever sees the row.
  it('uses the configured identity columns for name, phone and email', () => {
    const schema = {
      type: 'object',
      required: ['fullName', 'mobile'],
      properties: {
        fullName: { type: 'string', title: 'Full Name' },
        mobile: { type: 'string', title: 'Mobile' },
        emailId: { type: 'string', title: 'Email', format: 'email' },
      },
    };
    const { header, example } = parse(
      buildCsvTemplate(schema, {
        identity: { name: 'fullName', phone: 'mobile', email: 'emailId' },
      }),
    );
    const at = (name: string): string => example[header.indexOf(name)] ?? '';

    expect(at('mobile')).toBe('9876510000');
    expect(at('fullName')).toBe('Sample Full Name 1');
    expect(at('emailId')).toBe('person1@example.com');

    // Same schema, no selectors: the cells the row parser rejects.
    const plain = parse(buildCsvTemplate(schema));
    expect(plain.example[plain.header.indexOf('mobile')]).toBe('Example Mobile');
  });

  it('lets a column that declares its own shape outrank the identity value', () => {
    const schema = {
      type: 'object',
      required: ['mobile'],
      properties: { mobile: { type: 'string', title: 'Mobile', pattern: '^\\+91[0-9]{10}$' } },
    };
    const { header, example } = parse(
      buildCsvTemplate(schema, { identity: { name: 'fullName', phone: 'mobile' } }),
    );
    const cell = example[header.indexOf('mobile')] ?? '';

    // The hardcoded 10-digit placeholder fails `^\+91…`, so `exampleValue`
    // derives one from the declaration instead of writing a rejected cell.
    expect(cell).toBe('+919876543210');
    expect(new RegExp('^\\+91[0-9]{10}$').test(cell)).toBe(true);
  });

  it('emits a header row followed by one example row of equal width', () => {
    const csv = buildCsvTemplate(SEEKER_SCHEMA, { arrayDelimiter: '|' });
    const lines = csv.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    const { header, example } = parse(csv);
    expect(example).toHaveLength(header.length);
  });

  it('orders required properties before optional ones', () => {
    const { header } = parse(buildCsvTemplate(SEEKER_SCHEMA, { arrayDelimiter: '|' }));
    expect(header.slice(0, 5)).toEqual([
      'beneficiary_name',
      'mobile_number',
      'age',
      'gender',
      'disability_type',
    ]);
  });

  it('demonstrates array fields with the configured delimiter', () => {
    const { header, example } = parse(buildCsvTemplate(SEEKER_SCHEMA, { arrayDelimiter: '|' }));
    const cell = example[header.indexOf('disability_type')]!;
    expect(cell).toBe('Low Vision|Blindness');
    expect(example[header.indexOf('tags')]).toContain('|');
  });

  it('honours a non-default array delimiter', () => {
    const { header, example } = parse(buildCsvTemplate(SEEKER_SCHEMA, { arrayDelimiter: ';' }));
    expect(example[header.indexOf('disability_type')]).toBe('Low Vision;Blindness');
  });

  it('derives values that satisfy the schema constraints', () => {
    const { header, example } = parse(buildCsvTemplate(SEEKER_SCHEMA, { arrayDelimiter: '|' }));
    const get = (f: string) => example[header.indexOf(f)]!;
    expect(get('mobile_number')).toMatch(/^[0-9]{10}$/);
    expect(get('pincode')).toMatch(/^[0-9]{6}$/);
    const age = Number(get('age'));
    expect(age).toBeGreaterThanOrEqual(0);
    expect(age).toBeLessThanOrEqual(120);
    expect(get('gender')).toBe('Male');
    expect(get('email')).toContain('@');
    expect(get('catalog_url')).toMatch(/^https?:\/\//);
    expect(get('consented')).toBe('true');
    expect(get('beneficiary_name').length).toBeGreaterThan(0);
  });

  it('samples a web address for a link field once the URL rule has rewritten it (#904)', () => {
    const schema = applyUrlRule({
      type: 'object',
      properties: {
        website: { type: 'string', title: 'Website', 'x-uri': true },
        catalog_url: { type: 'string', format: 'uri' },
      },
    });
    const { header, example } = parse(buildCsvTemplate(schema));
    const urlRe = new RegExp(URL_PATTERN, 'u');
    for (const col of ['website', 'catalog_url']) {
      const cell = example[header.indexOf(col)] ?? '';
      expect(cell).toBe('https://example.com');
      expect(urlRe.test(cell)).toBe(true);
    }
  });

  it('keeps backward-compatible header-only output when example row disabled', () => {
    const csv = buildCsvTemplate(SEEKER_SCHEMA, { arrayDelimiter: '|', exampleRow: false });
    expect(csv.trimEnd().split('\n')).toHaveLength(1);
  });

  it('quotes example cells containing the CSV separator', () => {
    const schema = {
      type: 'object',
      required: ['address'],
      properties: { address: { type: 'string', title: 'Address, full' } },
    } as Record<string, unknown>;
    const csv = buildCsvTemplate(schema, { arrayDelimiter: '|' });
    const example = csv.trimEnd().split('\n')[1]!;
    // a generated value containing a comma must arrive quoted
    if (example.includes(',')) {
      expect(example.startsWith('"')).toBe(true);
    }
  });

  it('defaults to the pipe delimiter when no options are given', () => {
    const { header, example } = parse(buildCsvTemplate(SEEKER_SCHEMA));
    expect(example[header.indexOf('disability_type')]).toBe('Low Vision|Blindness');
  });

  // The digit run is `min` characters long whether or not a leading character
  // class fixed the first one. Asserting the exact strings pins that length: a
  // run one character short or long fails the pattern it was derived from, and
  // the operator copies a cell `bulk-row-process` rejects.
  it.each([
    ['^[0-9]{10}$', '9876543210'],
    ['^[6-9][0-9]{9}$', '6987654321'],
    ['^\\+91[0-9]{10}$', '+919876543210'],
    ['^[0-9]{6}$', '987654'],
  ])('derives a %s example that satisfies its own pattern', (pattern, expected) => {
    const { header, example } = parse(
      buildCsvTemplate({
        type: 'object',
        required: ['value'],
        properties: { value: { type: 'string', title: 'Value', pattern } },
      }),
    );
    const cell = example[header.indexOf('value')] ?? '';
    expect(cell).toBe(expected);
    expect(new RegExp(pattern).test(cell)).toBe(true);
  });
});
