/**
 * Unit tests for the org-owner grant-token service (#701).
 *
 * @module @aggregator-dpg/api
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mintGrantToken, verifyGrantToken, _resetGrantTokenKey } from './grant-token.js';
import { mintInviteToken, _resetInviteTokenKey } from './invite-token.js';

const ORG = '22222222-2222-2222-2222-222222222222';

describe('grant-token', () => {
  beforeEach(() => {
    _resetGrantTokenKey();
    _resetInviteTokenKey();
    process.env.APPROVAL_TOKEN_SECRET = 'k'.repeat(48);
  });

  it('mints and verifies a round trip', async () => {
    const { token } = await mintGrantToken({ org: ORG });
    const res = await verifyGrantToken(token);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.org).toBe(ORG);
    expect(res.expired).toBe(false);
  });

  it('defaults to a 90-day expiry', async () => {
    const { expiresAt } = await mintGrantToken({ org: ORG });
    const days = (expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(89.9);
    expect(days).toBeLessThan(90.1);
  });

  it('rejects an expired grant by default', async () => {
    const { token } = await mintGrantToken({ org: ORG, ttlSec: -1 });
    const res = await verifyGrantToken(token);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('EXPIRED');
  });

  it('accepts an expired-but-signed grant under allowExpired (recovery path)', async () => {
    const { token } = await mintGrantToken({ org: ORG, ttlSec: -1 });
    const res = await verifyGrantToken(token, { allowExpired: true });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.org).toBe(ORG);
    expect(res.expired).toBe(true);
  });

  it('rejects a token minted for a different audience (invite replayed as grant)', async () => {
    const { token } = await mintInviteToken({ jti: 'j', org: ORG, email: 'a@b.in' });
    const res = await verifyGrantToken(token);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('INVALID');
  });

  it('rejects a malformed string', async () => {
    const res = await verifyGrantToken('nope');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('MALFORMED');
  });
});
