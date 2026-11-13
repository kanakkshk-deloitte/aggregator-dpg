/**
 * Unit tests for the organisation schema validator
 * (`apps/api/src/services/org-schema-validator.ts`): the default schema's
 * website / GST number / domains rules, the `x-updatable`, `x-check` and
 * `x-network-domains` markers, and that a field added to a schema works with
 * no code change.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildBlueDotConfig } from '@aggregator-dpg/network-config/testing';
import * as networkConfig from '../network-config.js';
import { _setNetworkConfig } from '../network-config.js';
import * as schemaRef from '../schema-ref.js';
import {
  _resetOrgSchemaValidator,
  validateOrgRegistration,
  validateOrgUpdate,
} from '../org-schema-validator.js';

/** Points the validator at a schema file of the test's own. */
function useSchema(schema: object): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'org-schema-'));
  const file = path.join(dir, 'org-registration.v1.json');
  writeFileSync(file, JSON.stringify(schema));
  vi.spyOn(schemaRef, 'resolveSchema').mockReturnValue({
    path: file,
    ref: 'test/org-registration.v1',
  });
  _resetOrgSchemaValidator();
}

/** The repository's shared default org-registration schema. */
function defaultSchema(): Record<string, unknown> {
  const real = schemaRef.resolveSchema('org-registration.v1.json', {});
  if (!real) throw new Error('default org schema missing');
  return JSON.parse(readFileSync(real.path, 'utf8')) as Record<string, unknown>;
}

beforeEach(() => {
  _setNetworkConfig(buildBlueDotConfig());
  _resetOrgSchemaValidator();
});

afterEach(() => {
  vi.restoreAllMocks();
  _resetOrgSchemaValidator();
});

describe('validateOrgRegistration (default schema)', () => {
  it('accepts the three fields and tidies them', async () => {
    const r = await validateOrgRegistration({
      display_name: 'Acme',
      website: ' https://acme.example.org ',
      gst_number: ' 29abcde1234f1zw ',
      domains: ['seeker', 'provider'],
    });
    expect(r).toEqual({
      ok: true,
      values: {
        website: 'https://acme.example.org',
        gst_number: '29ABCDE1234F1ZW',
        domains: ['seeker', 'provider'],
      },
    });
  });

  it('accepts none of them: all three are optional', async () => {
    expect(await validateOrgRegistration({ display_name: 'Acme' })).toEqual({
      ok: true,
      values: {},
    });
  });

  it('leaves the fixed parts and undeclared keys to the route', async () => {
    const r = await validateOrgRegistration({
      display_name: 'Acme',
      owner: { name: 'x', email: 'not-an-email', phone: 'bad' },
      coordinates: [77, 12],
      organisation_type: 'ngo',
    });
    expect(r).toEqual({ ok: true, values: {} });
  });

  it('drops an empty string, leaving the field empty', async () => {
    expect(await validateOrgRegistration({ website: '  ', gst_number: '' })).toEqual({
      ok: true,
      values: {},
    });
  });

  it.each([
    [
      'website',
      { website: 'http://acme.example.org' },
      'Please enter a website starting with https://',
    ],
    ['website', { website: 'acme.example.org' }, 'Please enter a website starting with https://'],
    ['gst_number', { gst_number: 'hello' }, 'Please enter a valid GSTIN.'],
    ['gst_number', { gst_number: '29ABCDE1234F1Z5' }, 'Please enter a valid GSTIN.'],
  ])('refuses a bad %s with the schema message', async (field, body, message) => {
    expect(await validateOrgRegistration(body)).toEqual({
      ok: false,
      errors: { [field]: message },
    });
  });

  it('refuses a domain the network does not have, keyed by the field', async () => {
    const r = await validateOrgRegistration({ domains: ['seeker', 'astronaut'] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors)).toEqual(['domains']);
  });

  it('names every bad field at once', async () => {
    const r = await validateOrgRegistration({
      website: 'http://x.org',
      gst_number: 'hello',
      domains: ['astronaut'],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(['domains', 'gst_number', 'website']);
  });
});

describe('validateOrgUpdate (default schema)', () => {
  it('accepts x-updatable fields; null and an empty string remove', async () => {
    expect(
      await validateOrgUpdate({ website: 'https://a.example.org', gst_number: null, domains: [] }),
    ).toEqual({
      ok: true,
      values: { website: 'https://a.example.org', domains: [], gst_number: null },
    });
    expect(await validateOrgUpdate({ website: ' ' })).toEqual({
      ok: true,
      values: { website: null },
    });
  });

  it('refuses a field that is not x-updatable', async () => {
    expect(await validateOrgUpdate({ display_name: 'X', organisation_type: 'ngo' })).toEqual({
      ok: false,
      errors: {
        display_name: 'is not an editable field',
        organisation_type: 'is not an editable field',
      },
    });
  });

  it('checks the GSTIN check character after the shape', async () => {
    expect(await validateOrgUpdate({ gst_number: '27AAPFU0939F1ZV' })).toEqual({
      ok: true,
      values: { gst_number: '27AAPFU0939F1ZV' },
    });
    expect(await validateOrgUpdate({ gst_number: '27AAPFU0939F1ZX' })).toEqual({
      ok: false,
      errors: { gst_number: 'Please enter a valid GSTIN.' },
    });
  });
});

describe('a schema change needs no code change', () => {
  it('validates, accepts and updates a field added to the schema', async () => {
    const schema = defaultSchema();
    (schema['properties'] as Record<string, unknown>)['registration_number'] = {
      type: 'string',
      title: 'Registration number',
      pattern: '^[A-Z]{2}[0-9]{6}$',
      'x-error-message': 'Please enter a registration number like KA123456.',
      'x-updatable': true,
    };
    useSchema(schema);

    expect(await validateOrgRegistration({ registration_number: 'KA123456' })).toEqual({
      ok: true,
      values: { registration_number: 'KA123456' },
    });
    expect(await validateOrgRegistration({ registration_number: 'nope' })).toEqual({
      ok: false,
      errors: { registration_number: 'Please enter a registration number like KA123456.' },
    });
    expect(await validateOrgUpdate({ registration_number: 'MH654321' })).toEqual({
      ok: true,
      values: { registration_number: 'MH654321' },
    });
  });

  it('stops accepting a field removed from the schema', async () => {
    const schema = defaultSchema();
    delete (schema['properties'] as Record<string, unknown>)['gst_number'];
    useSchema(schema);
    expect(await validateOrgRegistration({ gst_number: '27AAPFU0939F1ZV' })).toEqual({
      ok: true,
      values: {},
    });
    expect(await validateOrgUpdate({ gst_number: '27AAPFU0939F1ZV' })).toEqual({
      ok: false,
      errors: { gst_number: 'is not an editable field' },
    });
  });

  it('applies x-check and x-network-domains to any field that carries them', async () => {
    useSchema({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        branch_gstin: { type: 'string', 'x-check': 'gstin', 'x-updatable': true },
        serves: { type: 'array', items: { type: 'string' }, 'x-network-domains': true },
      },
      required: ['serves'],
    });
    expect(
      await validateOrgRegistration({ branch_gstin: '27aapfu0939f1zv', serves: ['provider'] }),
    ).toEqual({
      ok: true,
      values: { branch_gstin: '27AAPFU0939F1ZV', serves: ['provider'] },
    });
    const missing = await validateOrgRegistration({});
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.errors['serves']).toBe('is required');
  });
});

describe('failure scenarios', () => {
  it('throws when no org-registration schema exists, and recovers once one does', async () => {
    vi.spyOn(schemaRef, 'resolveSchema').mockReturnValue(null);
    _resetOrgSchemaValidator();
    await expect(validateOrgRegistration({})).rejects.toThrow(/org-registration schema not found/);
    vi.restoreAllMocks();
    expect((await validateOrgRegistration({})).ok).toBe(true);
  });

  it('keeps the schema as written when network config is unavailable', async () => {
    vi.spyOn(networkConfig, 'getNetworkConfig').mockRejectedValue(new Error('config down'));
    _resetOrgSchemaValidator();
    // With no domain ids to fill in, any string is accepted.
    expect((await validateOrgRegistration({ domains: ['anything'] })).ok).toBe(true);
  });
});
