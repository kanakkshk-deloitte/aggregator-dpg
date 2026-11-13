import { describe, it, expect, beforeEach } from 'vitest';
import { SignJWT } from 'jose';
import {
  mintApprovalToken,
  verifyApprovalToken,
  formatApprovalTtl,
  _resetTokenKey,
} from './approval-token.js';

describe('approval-token', () => {
  beforeEach(() => {
    _resetTokenKey();
    process.env.APPROVAL_TOKEN_SECRET = 'k'.repeat(48);
  });

  it('round-trips approve intent', async () => {
    const m = await mintApprovalToken({
      aggregatorId: '11111111-1111-1111-1111-111111111111',
      intent: 'approve',
    });
    const v = await verifyApprovalToken(m.token);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.aggregatorId).toBe('11111111-1111-1111-1111-111111111111');
      expect(v.intent).toBe('approve');
    }
  });

  it('round-trips reject intent', async () => {
    const m = await mintApprovalToken({
      aggregatorId: '22222222-2222-2222-2222-222222222222',
      intent: 'reject',
    });
    const v = await verifyApprovalToken(m.token);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.intent).toBe('reject');
  });

  it('rejects tampered token (signature)', async () => {
    const { token } = await mintApprovalToken({
      aggregatorId: '33333333-3333-3333-3333-333333333333',
      intent: 'approve',
    });
    const tampered = `${token.slice(0, -2)}xx`;
    const v = await verifyApprovalToken(tampered);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(['INVALID', 'MALFORMED']).toContain(v.error.code);
  });

  it('rejects malformed token', async () => {
    const v = await verifyApprovalToken('not-a-jwt');
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error.code).toBe('MALFORMED');
  });

  it('rejects token signed with different secret', async () => {
    const { token } = await mintApprovalToken({
      aggregatorId: '44444444-4444-4444-4444-444444444444',
      intent: 'approve',
    });
    _resetTokenKey();
    process.env.APPROVAL_TOKEN_SECRET = 'z'.repeat(48);
    const v = await verifyApprovalToken(token);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error.code).toBe('INVALID');
  });

  it('rejects expired token', async () => {
    const { token } = await mintApprovalToken({
      aggregatorId: '55555555-5555-5555-5555-555555555555',
      intent: 'approve',
      ttlSec: -10,
    });
    const v = await verifyApprovalToken(token);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error.code).toBe('EXPIRED');
  });

  it('mint records expiry ~1h ahead by default', async () => {
    const before = Date.now();
    const m = await mintApprovalToken({
      aggregatorId: '66666666-6666-6666-6666-666666666666',
      intent: 'approve',
    });
    const oneHour = 60 * 60 * 1000;
    expect(m.expiresAt.getTime() - before).toBeGreaterThanOrEqual(oneHour - 1000);
    expect(m.expiresAt.getTime() - before).toBeLessThan(oneHour + 1000);
  });

  it('throws if secret missing', () => {
    _resetTokenKey();
    delete process.env.APPROVAL_TOKEN_SECRET;
    return expect(
      mintApprovalToken({
        aggregatorId: 'x',
        intent: 'approve',
      }),
    ).rejects.toThrow(/APPROVAL_TOKEN_SECRET/);
  });
});

describe('verifyApprovalToken allowExpired', () => {
  beforeEach(() => {
    _resetTokenKey();
    process.env.APPROVAL_TOKEN_SECRET = 'k'.repeat(48);
  });

  async function mintExpired(): Promise<string> {
    const key = new TextEncoder().encode(process.env.APPROVAL_TOKEN_SECRET);
    return new SignJWT({ intent: 'approve' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('agg-1')
      .setIssuer('aggregator-api')
      .setAudience('aggregator-admin')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(key);
  }

  it('rejects an expired token by default', async () => {
    const t = await mintExpired();
    const r = await verifyApprovalToken(t);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('EXPIRED');
  });

  it('accepts an expired token when allowExpired is set', async () => {
    const t = await mintExpired();
    const r = await verifyApprovalToken(t, { allowExpired: true });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.aggregatorId).toBe('agg-1');
      expect(r.intent).toBe('approve');
    }
  });

  it('still rejects a tampered token even with allowExpired', async () => {
    const t = (await mintApprovalToken({ aggregatorId: 'agg-2', intent: 'approve' })).token;
    const tampered = t.slice(0, -3) + 'aaa';
    const r = await verifyApprovalToken(tampered, { allowExpired: true });
    expect(r.ok).toBe(false);
  });
});

describe('verifyApprovalToken org claim', () => {
  beforeEach(() => {
    _resetTokenKey();
    process.env.APPROVAL_TOKEN_SECRET = 'k'.repeat(48);
  });

  it('round-trips an org claim', async () => {
    const { token } = await mintApprovalToken({
      aggregatorId: 'agg-1',
      intent: 'approve',
      org: 'org-1',
    });
    const v = await verifyApprovalToken(token);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.org).toBe('org-1');
  });

  it('omits org when not minted', async () => {
    const { token } = await mintApprovalToken({ aggregatorId: 'agg-1', intent: 'approve' });
    const v = await verifyApprovalToken(token);
    if (v.ok) expect(v.org).toBeUndefined();
  });
});

describe('verifyApprovalToken malformed/invalid claim paths', () => {
  beforeEach(() => {
    _resetTokenKey();
    process.env.APPROVAL_TOKEN_SECRET = 'k'.repeat(48);
  });

  function key(): Uint8Array {
    return new TextEncoder().encode(process.env.APPROVAL_TOKEN_SECRET);
  }

  it('rejects a well-signed token with no sub claim', async () => {
    const token = await new SignJWT({ intent: 'approve' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('aggregator-api')
      .setAudience('aggregator-admin')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(key());
    const v = await verifyApprovalToken(token);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.error.code).toBe('INVALID');
      expect(v.error.message).toBe('missing sub claim');
    }
  });

  it('rejects a well-signed token with a bad intent claim', async () => {
    const token = await new SignJWT({ intent: 'delete' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('agg-1')
      .setIssuer('aggregator-api')
      .setAudience('aggregator-admin')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(key());
    const v = await verifyApprovalToken(token);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.error.code).toBe('INVALID');
      expect(v.error.message).toBe('bad intent claim');
    }
  });

  it('rejects an expired token (allowExpired) that has no sub claim', async () => {
    const token = await new SignJWT({ intent: 'approve' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('aggregator-api')
      .setAudience('aggregator-admin')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(key());
    const v = await verifyApprovalToken(token, { allowExpired: true });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.error.code).toBe('INVALID');
      expect(v.error.message).toBe('bad claims in expired token');
    }
  });

  it('rejects an expired token (allowExpired) with a bad intent claim', async () => {
    const token = await new SignJWT({ intent: 'nope' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('agg-1')
      .setIssuer('aggregator-api')
      .setAudience('aggregator-admin')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(key());
    const v = await verifyApprovalToken(token, { allowExpired: true });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.error.code).toBe('INVALID');
      expect(v.error.message).toBe('bad claims in expired token');
    }
  });

  it('returns MALFORMED for a dot-containing string that is not a valid JWS', async () => {
    const v = await verifyApprovalToken('not.a.jws');
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error.code).toBe('MALFORMED');
  });

  it('returns INVALID for a token whose audience does not match (generic catch-all)', async () => {
    const token = await new SignJWT({ intent: 'approve' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('agg-1')
      .setIssuer('aggregator-api')
      .setAudience('some-other-audience')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(key());
    const v = await verifyApprovalToken(token);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error.code).toBe('INVALID');
  });
});

describe('formatApprovalTtl', () => {
  it.each([
    [7 * 24 * 60 * 60, '7 days'],
    [24 * 60 * 60, '1 day'],
    [2 * 24 * 60 * 60, '2 days'],
    [60 * 60, '1 hour'],
    [2 * 60 * 60, '2 hours'],
    [30 * 60, '30 minutes'],
    [60, '1 minute'],
    [45, '45 seconds'],
  ])('formats %d seconds as "%s"', (secs, expected) => {
    expect(formatApprovalTtl(secs)).toBe(expected);
  });

  it('picks the largest whole unit that divides the lifetime', () => {
    expect(formatApprovalTtl(5400)).toBe('90 minutes'); // not a whole hour
    expect(formatApprovalTtl(3661)).toBe('3661 seconds'); // no whole-minute fit
  });

  it('returns a safe phrase for non-positive or invalid input', () => {
    expect(formatApprovalTtl(0)).toBe('a limited time');
    expect(formatApprovalTtl(-5)).toBe('a limited time');
    expect(formatApprovalTtl(Number.NaN)).toBe('a limited time');
  });
});
