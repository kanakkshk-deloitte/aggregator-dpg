/**
 * Unit tests for the shared field-error wording.
 *
 * The aggregator words a failed field the way Signals does
 * (`network_workflow.ts` `describeAjvError`), so a participant sees the same
 * sentence whichever side rejects the value (aggregator-dpg#904).
 *
 * @module @aggregator-dpg/network-config
 */
import { describe, it, expect } from 'vitest';
import { describeSchemaIssue, fieldLabel, formatFieldErrors } from '../field-errors.js';
import { URL_PATTERN } from '../uri-fields.js';

const SCHEMA = {
  type: 'object',
  properties: {
    website: { type: 'string', title: 'Website', 'x-uri': true, pattern: URL_PATTERN },
    mobile: { type: 'string', title: 'Mobile Number', pattern: '^[0-9]{10}$' },
    gender: { type: 'string', title: 'Gender', enum: ['Male', 'Female', 'Other'] },
    age: { type: 'integer', title: 'Age', minimum: 14 },
    links: {
      type: 'array',
      title: 'Links',
      'x-uri': true,
      items: { type: 'string', pattern: URL_PATTERN },
    },
    note: { type: 'string', pattern: '^\\S' },
  },
};

describe('describeSchemaIssue', () => {
  it('words a failed URL pattern as Signals does, labelled with the field title', () => {
    expect(
      describeSchemaIssue(
        { keyword: 'pattern', instancePath: '/website', message: 'must match pattern "…"' },
        SCHEMA,
      ),
    ).toEqual({ field: 'website', label: 'Website', message: 'Please enter a valid web address.' });
  });

  it('finds the URL marker on the parent of an array item', () => {
    expect(
      describeSchemaIssue({ keyword: 'pattern', instancePath: '/links/1', message: 'x' }, SCHEMA),
    ).toEqual({ field: 'links.1', label: 'Links', message: 'Please enter a valid web address.' });
  });

  it('never shows the regex for any other failed pattern', () => {
    expect(
      describeSchemaIssue({ keyword: 'pattern', instancePath: '/mobile', message: 'x' }, SCHEMA)
        .message,
    ).toBe('Please enter a valid Mobile Number.');
    expect(
      describeSchemaIssue({ keyword: 'pattern', instancePath: '/note', message: 'x' }, SCHEMA),
    ).toEqual({ field: 'note', label: 'note', message: 'Please enter a valid value.' });
  });

  it('lists the allowed values for an enum', () => {
    expect(
      describeSchemaIssue(
        {
          keyword: 'enum',
          instancePath: '/gender',
          params: { allowedValues: ['Male', 'Female', 'Other'] },
          message: 'must be equal to one of the allowed values',
        },
        SCHEMA,
      ).message,
    ).toBe('must be one of: Male, Female, Other');
  });

  it("keeps ajv's message for an enum issue that carries no allowed values", () => {
    expect(
      describeSchemaIssue({ keyword: 'enum', instancePath: '/gender', message: 'bad' }, SCHEMA)
        .message,
    ).toBe('bad');
  });

  it('names the missing property for a required error', () => {
    expect(
      describeSchemaIssue(
        { keyword: 'required', instancePath: '', params: { missingProperty: 'age' } },
        SCHEMA,
      ),
    ).toEqual({ field: 'age', label: 'Age', message: 'is required' });
  });

  it('names an unknown key', () => {
    expect(
      describeSchemaIssue(
        { keyword: 'additionalProperties', instancePath: '', params: { additionalProperty: 'x' } },
        SCHEMA,
      ),
    ).toEqual({ field: 'x', label: 'x', message: 'is not an allowed field' });
  });

  it("uses the field's own x-error-message for a failed pattern", () => {
    const schema = {
      properties: {
        pin: {
          type: 'string',
          title: 'PIN code',
          pattern: '^\\d{6}$',
          'x-error-message': 'Enter a 6-digit PIN code.',
        },
      },
    };
    expect(
      describeSchemaIssue({ keyword: 'pattern', instancePath: '/pin', message: 'x' }, schema),
    ).toEqual({ field: 'pin', label: 'PIN code', message: 'Enter a 6-digit PIN code.' });
  });

  it('reads minLength 1 as "is required", other minLengths keep ajv\'s message', () => {
    expect(
      describeSchemaIssue(
        { keyword: 'minLength', instancePath: '/website', params: { limit: 1 }, message: 'x' },
        SCHEMA,
      ).message,
    ).toBe('is required');
    expect(
      describeSchemaIssue(
        {
          keyword: 'minLength',
          instancePath: '/website',
          params: { limit: 5 },
          message: 'must NOT have fewer than 5 characters',
        },
        SCHEMA,
      ).message,
    ).toBe('must NOT have fewer than 5 characters');
  });

  it('names an unevaluated key like an unknown one', () => {
    expect(
      describeSchemaIssue(
        {
          keyword: 'unevaluatedProperties',
          instancePath: '',
          params: { unevaluatedProperty: 'x' },
        },
        SCHEMA,
      ),
    ).toEqual({ field: 'x', label: 'x', message: 'is not an allowed field' });
  });

  it("falls back to ajv's own message for other keywords", () => {
    expect(
      describeSchemaIssue(
        { keyword: 'minimum', instancePath: '/age', message: 'must be >= 14' },
        SCHEMA,
      ),
    ).toEqual({ field: 'age', label: 'Age', message: 'must be >= 14' });
  });

  it('copes with a missing schema or a malformed issue', () => {
    expect(describeSchemaIssue({ keyword: 'type', instancePath: '/a/b' }, undefined)).toEqual({
      field: 'a.b',
      label: 'a.b',
      message: 'is invalid',
    });
    expect(describeSchemaIssue({}, SCHEMA)).toEqual({
      field: '',
      label: '',
      message: 'is invalid',
    });
  });
});

describe('fieldLabel', () => {
  it('uses the field title, the list title for an item, else the path', () => {
    expect(fieldLabel(SCHEMA, 'website')).toBe('Website');
    expect(fieldLabel(SCHEMA, 'links.0')).toBe('Links');
    expect(fieldLabel(SCHEMA, 'note')).toBe('note');
    expect(fieldLabel(undefined, 'a.b')).toBe('a.b');
  });
});

describe('formatFieldErrors', () => {
  it('joins one "Label: message" line per field, first message per field wins', () => {
    expect(
      formatFieldErrors([
        { field: 'website', label: 'Website', message: 'Please enter a valid web address.' },
        { field: 'website', label: 'Website', message: 'must be string' },
        { field: 'age', label: 'Age', message: 'must be >= 14' },
      ]),
    ).toBe('Website: Please enter a valid web address. Age: must be >= 14.');
  });

  it('adds a full stop only where the message lacks one, and keeps field-less messages', () => {
    expect(
      formatFieldErrors([
        { field: 'age', label: 'Age', message: 'is required' },
        { field: '', label: '', message: 'must match "then" schema' },
      ]),
    ).toBe('Age: is required. must match "then" schema.');
  });

  it('returns an empty string for no errors', () => {
    expect(formatFieldErrors([])).toBe('');
  });
});
