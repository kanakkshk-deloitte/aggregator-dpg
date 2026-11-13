/**
 * Unit tests for the coordinator invite-token mint/verify service (#700).
 *
 * @module @aggregator-dpg/api
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mintInviteToken, verifyInviteToken, _resetInviteTokenKey } from './invite-token.js';
import { mintApprovalToken, _resetTokenKey } from './approval-token.js';

const JTI = '11111111-1111-1111-1111-111111111111';
const ORG = '22222222-2222-2222-2222-222222222222';
const EMAIL = 'coord@org.example';

describe('invite-token', () => {
  beforeEach(() => {
    _resetInviteTokenKey();
    _resetTokenKey();
    process.env.APPROVAL_TOKEN_SECRET = 'k'.repeat(48);
  });

  it('mints and verifies a round trip, echoing the bound claims', async () => {
    const { token, expiresAt } = await mintInviteToken({ jti: JTI, org: ORG, email: EMAIL });
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
    const res = await verifyInviteToken(token);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.jti).toBe(JTI);
    expect(res.org).toBe(ORG);
    expect(res.email).toBe(EMAIL);
    expect(res.role).toBe('coordinator');
  });

  it('defaults to a 14-day expiry', async () => {
    const { expiresAt } = await mintInviteToken({ jti: JTI, org: ORG, email: EMAIL });
    const days = (expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThan(14.1);
  });

  it('honours a custom ttlSec', async () => {
    const { expiresAt } = await mintInviteToken({ jti: JTI, org: ORG, email: EMAIL, ttlSec: 60 });
    const secs = (expiresAt.getTime() - Date.now()) / 1000;
    expect(secs).toBeGreaterThan(50);
    expect(secs).toBeLessThan(70);
  });

  it('rejects a tampered signature', async () => {
    const { token } = await mintInviteToken({ jti: JTI, org: ORG, email: EMAIL });
    const parts = token.split('.');
    const tampered = `${parts[0]}.${parts[1]}.${'A'.repeat(parts[2]!.length)}`;
    const res = await verifyInviteToken(tampered);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('INVALID');
  });

  it('rejects an expired token', async () => {
    const { token } = await mintInviteToken({ jti: JTI, org: ORG, email: EMAIL, ttlSec: -1 });
    const res = await verifyInviteToken(token);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('EXPIRED');
  });

  it('rejects a token minted for a different audience (approval token replayed)', async () => {
    // Same secret, different audience (aggregator-admin) — must not verify as an
    // invite. This is the cross-token-replay guard.
    const { token } = await mintApprovalToken({ aggregatorId: JTI, intent: 'approve' });
    const res = await verifyInviteToken(token);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('INVALID');
  });

  it('rejects a malformed (non-JWT) string', async () => {
    const res = await verifyInviteToken('not-a-jwt');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('MALFORMED');
  });

  it('rejects an empty token', async () => {
    const res = await verifyInviteToken('');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('MALFORMED');
  });
});
