/**
 * BFF route test: POST /api/dashboard/actions.
 *
 * Stub endpoint — no upstream call. Validates session, allowlisted action,
 * and bounded id list, then acknowledges with 202. Mocks `getSession`
 * (not `callApi`, which this route does not use) and the logger to avoid
 * noisy pino output.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@/lib/server-session', () => ({
  getSession: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() },
  pickRequestId: vi.fn(() => 'req-test'),
}));

import { POST } from '@/app/api/dashboard/actions/route';
import { getSession } from '@/lib/server-session';

const mockGetSession = vi.mocked(getSession);

function fakeSession() {
  return {
    sub: 'user-1',
    accessToken: 'a',
    refreshToken: 'r',
    idToken: 'i',
    accessTokenExp: Date.now() + 60_000,
    refreshTokenExp: Date.now() + 60_000,
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
  };
}

describe('POST /api/dashboard/actions', () => {
  afterEach(() => vi.clearAllMocks());

  it('accepts a valid bulk action', async () => {
    mockGetSession.mockResolvedValue(fakeSession());
    const req = new Request('http://localhost/api/dashboard/actions', {
      method: 'POST',
      body: JSON.stringify({ action: 'trigger_callback', domain: 'seeker', ids: ['a', 'b'] }),
    });
    const res = await POST(req as never);
    expect(res.status).toBe(202);
    const body = (await res.json()) as { accepted?: number };
    expect(body.accepted).toBe(2);
  });

  it('returns 401 when there is no active session', async () => {
    mockGetSession.mockResolvedValue(null);
    const req = new Request('http://localhost/api/dashboard/actions', {
      method: 'POST',
      body: JSON.stringify({ action: 'trigger_callback', domain: 'seeker', ids: ['a'] }),
    });
    const res = await POST(req as never);
    expect(res.status).toBe(401);
  });

  it('returns 400 on malformed JSON body', async () => {
    mockGetSession.mockResolvedValue(fakeSession());
    const req = new Request('http://localhost/api/dashboard/actions', {
      method: 'POST',
      body: 'not json',
    });
    const res = await POST(req as never);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('BAD_REQUEST');
  });

  it('rejects an unknown action', async () => {
    mockGetSession.mockResolvedValue(fakeSession());
    const req = new Request('http://localhost/api/dashboard/actions', {
      method: 'POST',
      body: JSON.stringify({ action: 'delete_everything', domain: 'seeker', ids: ['a'] }),
    });
    const res = await POST(req as never);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message).toContain('unknown action');
  });

  it('rejects an empty ids array', async () => {
    mockGetSession.mockResolvedValue(fakeSession());
    const req = new Request('http://localhost/api/dashboard/actions', {
      method: 'POST',
      body: JSON.stringify({ action: 'trigger_callback', domain: 'seeker', ids: [] }),
    });
    const res = await POST(req as never);
    expect(res.status).toBe(400);
  });

  it('rejects an ids array over the maximum size', async () => {
    mockGetSession.mockResolvedValue(fakeSession());
    const ids = Array.from({ length: 501 }, (_, i) => `id-${i}`);
    const req = new Request('http://localhost/api/dashboard/actions', {
      method: 'POST',
      body: JSON.stringify({ action: 'trigger_callback', domain: 'seeker', ids }),
    });
    const res = await POST(req as never);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message).toContain('maximum');
  });

  it('rejects non-string entries in ids', async () => {
    mockGetSession.mockResolvedValue(fakeSession());
    const req = new Request('http://localhost/api/dashboard/actions', {
      method: 'POST',
      body: JSON.stringify({ action: 'trigger_callback', domain: 'seeker', ids: [1, 2] }),
    });
    const res = await POST(req as never);
    expect(res.status).toBe(400);
  });

  it('rejects a missing domain', async () => {
    mockGetSession.mockResolvedValue(fakeSession());
    const req = new Request('http://localhost/api/dashboard/actions', {
      method: 'POST',
      body: JSON.stringify({ action: 'trigger_callback', ids: ['a'] }),
    });
    const res = await POST(req as never);
    expect(res.status).toBe(400);
  });

  it('rejects a non-object body', async () => {
    mockGetSession.mockResolvedValue(fakeSession());
    const req = new Request('http://localhost/api/dashboard/actions', {
      method: 'POST',
      body: JSON.stringify('a string'),
    });
    const res = await POST(req as never);
    expect(res.status).toBe(400);
  });
});
