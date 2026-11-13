/**
 * Unit tests for the organisation schema helpers (`lib/org-schema.ts`):
 * network domains, the GSTIN check for RJSF, the console's view of the
 * schema, and read-only value text.
 */
import { describe, expect, it } from 'vitest';
import type { FormValidation, RJSFSchema } from '@rjsf/utils';
import {
  applyNetworkDomains,
  consoleOrgSchema,
  gstinCustomValidate,
  orgFieldText,
  orgSchemaFields,
} from '@/lib/org-schema';

const SCHEMA = {
  type: 'object',
  required: ['display_name', 'domains'],
  properties: {
    display_name: { type: 'string', title: 'Organisation Name' },
    website: { type: 'string', title: 'Website', 'x-updatable': true },
    gst_number: {
      type: 'string',
      title: 'GST number',
      'x-check': 'gstin',
      'x-error-message': 'Please enter a valid GSTIN.',
      'x-updatable': true,
    },
    domains: {
      type: 'array',
      title: 'Domains',
      items: { type: 'string' },
      'x-network-domains': true,
      'x-updatable': true,
    },
    organisation_type: { type: 'string', title: 'Organisation Type', enum: ['ngo', 'other'] },
    address: { type: 'object', properties: { streetAddress: { type: 'string' } } },
    owner: { type: 'object' },
    consent: { type: 'object' },
  },
} as unknown as RJSFSchema;

const UI = {
  'ui:order': ['display_name', 'domains', 'website', 'gst_number', 'organisation_type'],
  domains: { 'ui:widget': 'checkboxes' },
  organisation_type: { 'ui:enumNames': ['NGO', 'Other'] },
};

const DOMAINS = [
  { id: 'seeker', label: 'Seekers' },
  { id: 'provider', label: 'Providers' },
];

/** A minimal RJSF error collector for one form. */
function errorCollector(fields: string[]) {
  const errors: Record<string, string[]> = {};
  const validation = Object.fromEntries(
    fields.map((f) => [f, { addError: (m: string) => (errors[f] ??= []).push(m) }]),
  ) as unknown as FormValidation<Record<string, unknown>>;
  return { errors, validation };
}

describe('applyNetworkDomains', () => {
  it('fills x-network-domains choices and labels, leaving the input untouched', () => {
    const out = applyNetworkDomains(SCHEMA, UI, DOMAINS);
    const props = out.schema.properties as Record<string, Record<string, unknown>>;
    expect(props['domains']?.['items']).toEqual({ type: 'string', enum: ['seeker', 'provider'] });
    expect(out.uiSchema['domains']).toEqual({
      'ui:widget': 'checkboxes',
      'ui:enumNames': ['Seekers', 'Providers'],
    });
    expect(
      ((SCHEMA.properties as Record<string, Record<string, unknown>>)['domains'] ?? {})['items'],
    ).toEqual({ type: 'string' });
  });

  it('returns the schema as is when there are no domains', () => {
    const out = applyNetworkDomains(SCHEMA, UI, []);
    expect(out.schema).toBe(SCHEMA);
    expect(out.uiSchema).toBe(UI);
  });

  it('sets an enum on a non-array x-network-domains field', () => {
    const one = {
      type: 'object',
      properties: { primary: { type: 'string', 'x-network-domains': true } },
    } as unknown as RJSFSchema;
    const props = applyNetworkDomains(one, {}, DOMAINS).schema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(props['primary']?.['enum']).toEqual(['seeker', 'provider']);
  });
});

describe('gstinCustomValidate', () => {
  it('adds the schema message for a wrong check character only', () => {
    const validate = gstinCustomValidate(SCHEMA);
    const bad = errorCollector(['gst_number']);
    validate({ gst_number: '29ABCDE1234F1Z5' }, bad.validation);
    expect(bad.errors).toEqual({ gst_number: ['Please enter a valid GSTIN.'] });

    for (const value of ['29ABCDE1234F1ZW', '29abcde1234f1zw', '', undefined]) {
      const ok = errorCollector(['gst_number']);
      validate({ gst_number: value }, ok.validation);
      expect(ok.errors).toEqual({});
    }
  });

  it('uses a default message when the schema has none', () => {
    const plain = {
      type: 'object',
      properties: { tax_id: { type: 'string', 'x-check': 'gstin' } },
    } as unknown as RJSFSchema;
    const c = errorCollector(['tax_id']);
    gstinCustomValidate(plain)({ tax_id: 'hello' }, c.validation);
    expect(c.errors).toEqual({ tax_id: ['Please enter a valid GSTIN.'] });
  });
});

describe('orgSchemaFields / consoleOrgSchema', () => {
  it('lists the schema fields in UI order, without the registration-only parts', () => {
    expect(orgSchemaFields(SCHEMA, UI)).toEqual([
      'domains',
      'website',
      'gst_number',
      'organisation_type',
    ]);
  });

  it('for the owner: x-updatable fields editable, others read-only, nothing required', () => {
    const view = consoleOrgSchema(SCHEMA, UI, true);
    expect(view.updatable).toEqual(['domains', 'website', 'gst_number']);
    expect(view.schema.required).toBeUndefined();
    expect(Object.keys(view.schema.properties ?? {})).toEqual([
      'domains',
      'website',
      'gst_number',
      'organisation_type',
    ]);
    expect(view.uiSchema['organisation_type']).toMatchObject({ 'ui:readonly': true });
    expect(view.uiSchema['website']).toEqual({});
    expect(view.uiSchema['domains']).toEqual({ 'ui:widget': 'checkboxes' });
  });

  it('for anyone else: every field read-only', () => {
    const view = consoleOrgSchema(SCHEMA, UI, false);
    expect(view.updatable).toEqual([]);
    for (const f of ['domains', 'website', 'gst_number', 'organisation_type']) {
      expect(view.uiSchema[f]).toMatchObject({ 'ui:readonly': true });
    }
  });
});

describe('orgFieldText', () => {
  it('shows choices by label, lists joined, empties as null', () => {
    const domains = { items: { type: 'string', enum: ['seeker', 'provider'] } };
    const labels = { 'ui:enumNames': ['Seekers', 'Providers'] };
    expect(orgFieldText(domains, labels, ['provider', 'seeker'])).toBe('Providers, Seekers');
    expect(orgFieldText(domains, labels, [])).toBeNull();
    expect(orgFieldText({ enum: ['ngo'] }, { 'ui:enumNames': ['NGO'] }, 'ngo')).toBe('NGO');
    expect(orgFieldText({}, {}, 'https://x.org')).toBe('https://x.org');
    expect(orgFieldText({}, {}, 'unknown')).toBe('unknown');
    expect(orgFieldText({}, {}, true)).toBe('Yes');
    expect(orgFieldText({}, {}, undefined)).toBeNull();
    expect(orgFieldText({}, {}, '')).toBeNull();
  });
});
