/**
 * BFF route test: GET /api/auth/me.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@/lib/server-session', () => ({
  getSession: vi.fn(),
}));

import { GET } from '@/app/api/auth/me/route';
import { getSession } from '@/lib/server-session';

const mockGetSession = vi.mocked(getSession);

describe('GET /api/auth/me', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns the safe identity claims for an active session', async () => {
    mockGetSession.mockResolvedValue({
      sub: 'user-1',
      email: 'jane@x.com',
      phone: '+911234567890',
      name: 'Jane',
      accessToken: 'a',
      refreshToken: 'r',
      idToken: 'i',
      accessTokenExp: Date.now() + 60_000,
      refreshTokenExp: Date.now() + 60_000,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
    });
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      user: { sub: string; email?: string; phone?: string; name?: string };
    };
    expect(body.user).toEqual({
      sub: 'user-1',
      email: 'jane@x.com',
      phone: '+911234567890',
      name: 'Jane',
    });
  });

  it('omits optional claims that are absent from the session', async () => {
    mockGetSession.mockResolvedValue({
      sub: 'user-1',
      accessToken: 'a',
      refreshToken: 'r',
      idToken: 'i',
      accessTokenExp: Date.now() + 60_000,
      refreshTokenExp: Date.now() + 60_000,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
    });
    const res = await GET();
    const body = (await res.json()) as { user: Record<string, unknown> };
    expect(body.user).toEqual({ sub: 'user-1' });
  });

  it('returns 401 when there is no active session', async () => {
    mockGetSession.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('unauthorized');
  });
});
