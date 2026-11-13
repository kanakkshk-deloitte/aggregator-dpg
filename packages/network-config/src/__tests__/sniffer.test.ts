import { describe, it, expect } from 'vitest';
import { sniffIdentitySelectors } from '../sniffer.js';

describe('sniffIdentitySelectors', () => {
  it('detects blue_dot seeker fields (name / phone / email)', () => {
    const schema = {
      properties: {
        name: { type: 'string', minLength: 1 },
        phone: { type: 'string', minLength: 8 },
        email: { type: 'string', format: 'email' },
        age: { type: 'integer' },
      },
    };
    expect(sniffIdentitySelectors(schema)).toEqual({
      name: 'name',
      phone: 'phone',
      email: 'email',
    });
  });

  it('detects blue_dot provider fields with hiringManager naming', () => {
    const schema = {
      properties: {
        jobProviderName: { type: 'string', minLength: 1 },
        hiringManagerPhoneNumber: { type: 'string' },
        hiringManagerEmail: { type: 'string', format: 'email' },
      },
    };
    expect(sniffIdentitySelectors(schema)).toEqual({
      name: 'jobProviderName',
      phone: 'hiringManagerPhoneNumber',
      email: 'hiringManagerEmail',
    });
  });

  it('detects purple_dot seeker (beneficiary_name + mobile_number)', () => {
    const schema = {
      properties: {
        beneficiary_name: { type: 'string', minLength: 1 },
        mobile_number: { type: 'string', pattern: '^[0-9]{10}$' },
        email: { type: 'string', format: 'email' },
        age: { type: 'integer' },
      },
    };
    expect(sniffIdentitySelectors(schema)).toEqual({
      name: 'beneficiary_name',
      phone: 'mobile_number',
      email: 'email',
    });
  });

  it('detects purple_dot provider (contact_name + contact_phone)', () => {
    const schema = {
      properties: {
        contact_name: { type: 'string', minLength: 1 },
        contact_phone: { type: 'string', pattern: '^[0-9]{10}$' },
        contact_email: { type: 'string', format: 'email' },
        organisation_name: { type: 'string' },
      },
    };
    const out = sniffIdentitySelectors(schema);
    expect(out?.phone).toBe('contact_phone');
    expect(out?.email).toBe('contact_email');
    // Name picks `contact_name` (first match) — organisation_name is a fine
    // alternate but the heuristic chooses declaration order on ties.
    expect(out?.name).toBe('contact_name');
  });

  it('returns null when phone field is missing entirely', () => {
    const schema = {
      properties: {
        name: { type: 'string' },
        email: { type: 'string', format: 'email' },
      },
    };
    expect(sniffIdentitySelectors(schema)).toBeNull();
  });

  it('returns null when email field is missing entirely', () => {
    const schema = {
      properties: {
        name: { type: 'string' },
        phone: { type: 'string', format: 'tel' },
      },
    };
    expect(sniffIdentitySelectors(schema)).toBeNull();
  });

  it('returns null on non-object input', () => {
    expect(sniffIdentitySelectors(null)).toBeNull();
    expect(sniffIdentitySelectors('schema')).toBeNull();
    expect(sniffIdentitySelectors({})).toBeNull();
  });

  it('skips fields that would shadow phone/email when picking name', () => {
    // `email_address` matches the name heuristic (contains _name? no — but contains "email")
    // → must NOT be picked as `name`.
    const schema = {
      properties: {
        email_address: { type: 'string', format: 'email' },
        phone: { type: 'string', format: 'tel' },
        full_name: { type: 'string', minLength: 1 },
      },
    };
    expect(sniffIdentitySelectors(schema)).toEqual({
      name: 'full_name',
      phone: 'phone',
      email: 'email_address',
    });
  });

  it('falls through to name-based detection when a phone pattern does not match a known phone shape', () => {
    // `pattern` is present but matches none of the PHONE_PATTERNS (10-digit,
    // leading `+`, e.164) — detection must fall back to the field-name check.
    const schema = {
      properties: {
        mobile: { type: 'string', pattern: '^[a-zA-Z]+$' },
        name: { type: 'string' },
        email: { type: 'string', format: 'email' },
      },
    };
    expect(sniffIdentitySelectors(schema)).toEqual({
      name: 'name',
      phone: 'mobile',
      email: 'email',
    });
  });

  it('returns null when phone and email are found but no name-like field exists', () => {
    const schema = {
      properties: {
        phone: { type: 'string', format: 'tel' },
        email: { type: 'string', format: 'email' },
        age: { type: 'integer' },
      },
    };
    expect(sniffIdentitySelectors(schema)).toBeNull();
  });

  it('resolves an array-typed `type` field (e.g. ["string", "null"]) as a name candidate', () => {
    const schema = {
      properties: {
        name: { type: ['string', 'null'] },
        phone: { type: 'string', format: 'tel' },
        email: { type: 'string', format: 'email' },
      },
    };
    expect(sniffIdentitySelectors(schema)).toEqual({
      name: 'name',
      phone: 'phone',
      email: 'email',
    });
  });

  it('does not pick a name-pattern field whose type is neither string nor undefined', () => {
    const schema = {
      properties: {
        // Matches the `_name_` naming heuristic but is typed as an integer —
        // must be rejected in favour of the genuinely string-typed candidate.
        name_count: { type: 'integer' },
        full_name: { type: 'string', minLength: 1 },
        phone: { type: 'string', format: 'tel' },
        email: { type: 'string', format: 'email' },
      },
    };
    expect(sniffIdentitySelectors(schema)).toEqual({
      name: 'full_name',
      phone: 'phone',
      email: 'email',
    });
  });
});
