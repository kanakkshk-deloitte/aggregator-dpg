import { describe, expect, it } from 'vitest';
import {
  ConsentRecordSchema,
  RegistrationConsentSchema,
  RegistrationPayloadSchema,
} from '../aggregator/index.js';

const validContact = {
  name: 'Rajesh',
  phone: '+919876543210',
  email: 'admin@skillbridge.in',
};

const validConsent = {
  value: true,
  given_at: '2026-01-15T10:00:00Z',
  valid_till: '2027-01-15T10:00:00Z',
};

describe('ConsentRecordSchema', () => {
  it('accepts boolean value (storage shape — does not require literal true)', () => {
    expect(() => ConsentRecordSchema.parse({ ...validConsent, value: false })).not.toThrow();
  });

  it('rejects non-ISO given_at', () => {
    expect(() => ConsentRecordSchema.parse({ ...validConsent, given_at: 'yesterday' })).toThrow();
  });
});

describe('RegistrationConsentSchema', () => {
  it('rejects consent.value=false at registration time', () => {
    expect(() => RegistrationConsentSchema.parse({ ...validConsent, value: false })).toThrow();
  });
});

describe('RegistrationPayloadSchema', () => {
  it('accepts the minimum valid signup body', () => {
    const parsed = RegistrationPayloadSchema.parse({
      name: 'SkillBridge Network',
      type: 'seeker',
      contact: validContact,
      consent: validConsent,
    });
    expect(parsed.locations).toEqual([]);
    expect(parsed.contact.email).toBe('admin@skillbridge.in');
  });

  it('rejects payloads missing required fields', () => {
    expect(() => RegistrationPayloadSchema.parse({ name: 'x', consent: validConsent })).toThrow();
  });

  it('accepts any non-empty domain id (network config decides the valid set)', () => {
    // `RoleTypeSchema` opened to z.string() in the genericisation refactor.
    // Application-layer validation against `getNetworkConfig().domainIds`
    // now handles the closed-set check, not the shared zod schema.
    const parsed = RegistrationPayloadSchema.parse({
      name: 'YellowDot Network',
      type: 'learner',
      contact: validContact,
      consent: validConsent,
    });
    expect(parsed.type).toBe('learner');
  });

  it('rejects unknown top-level fields (strict)', () => {
    expect(() =>
      RegistrationPayloadSchema.parse({
        name: 'x',
        type: 'seeker',
        contact: validContact,
        consent: validConsent,
        personas: [],
      }),
    ).toThrow();
  });
});
