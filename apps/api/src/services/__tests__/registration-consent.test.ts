import { describe, expect, it } from 'vitest';
import { MAX_CONSENT_VALIDITY_MS, stampConsent as stampOrNull } from '../registration-consent.js';

/** Stamps, failing the test when the consent is refused. */
function stampConsent<T extends Parameters<typeof stampOrNull>[0]>(c: T, now: Date): T {
  const out = stampOrNull(c, now);
  if (!out) throw new Error('refused');
  return out;
}

describe('stampConsent', () => {
  const now = new Date('2026-10-06T00:00:00.000Z');
  const base = { value: true as const, given_at: '2020-01-01T00:00:00.000Z' };

  it('server-stamps given_at and keeps a shorter valid_till', () => {
    const out = stampConsent({ ...base, valid_till: '2027-10-06T00:00:00.000Z' }, now);
    expect(out.given_at).toBe(now.toISOString());
    expect(out.valid_till).toBe('2027-10-06T00:00:00.000Z');
  });

  it('clamps a valid_till beyond the ceiling', () => {
    const out = stampConsent({ ...base, valid_till: '2099-01-01T00:00:00.000Z' }, now);
    expect(new Date(out.valid_till).getTime()).toBe(now.getTime() + MAX_CONSENT_VALIDITY_MS);
  });

  it('gives an unparseable valid_till the maximum (the org body is an unchecked string)', () => {
    const out = stampConsent({ ...base, valid_till: 'not-a-date' }, now);
    expect(new Date(out.valid_till).getTime()).toBe(now.getTime() + MAX_CONSENT_VALIDITY_MS);
  });

  it('keeps any other keys of the submitted block', () => {
    const out = stampConsent({ ...base, valid_till: '2027-01-01T00:00:00.000Z', extra: 1 }, now);
    expect(out.extra).toBe(1);
  });

  it('refuses a valid_till that is not after now (a consent born expired)', () => {
    expect(stampOrNull({ ...base, valid_till: '2026-10-05T00:00:00.000Z' }, now)).toBeNull();
    expect(stampOrNull({ ...base, valid_till: now.toISOString() }, now)).toBeNull();
  });
});
