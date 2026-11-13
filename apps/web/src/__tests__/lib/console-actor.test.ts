import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionData } from '@/lib/session';

vi.mock('@/lib/server-session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/upstream-client', () => ({ callApi: vi.fn() }));
const update = vi.fn(async () => ({ ok: true }));
vi.mock('@/lib/session', () => ({ getSessionStore: () => ({ update }) }));
vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({ get: () => ({ value: 'sid-1' }) })),
}));

import { ACTOR_CACHE_MS, getConsoleActor } from '@/lib/console-actor';
import { getSession } from '@/lib/server-session';
import { callApi } from '@/lib/upstream-client';

const me = {
  kind: 'admin',
  user: { id: 'u', contact: { name: null, email: 'a@a.org', phone: null } },
  orgs: [],
  is_network_admin: true,
};
const base = { sub: 's', accessToken: 't' } as SessionData;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('getConsoleActor (C14)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses a fresh cached actor without calling the API', async () => {
    vi.mocked(getSession).mockResolvedValue({
      ...base,
      consoleActor: { me, at: Date.now() },
    } as never);
    expect(await getConsoleActor()).toEqual({ ok: true, me });
    expect(callApi).not.toHaveBeenCalled();
  });

  it('re-reads a stale actor and caches it', async () => {
    vi.mocked(getSession).mockResolvedValue({
      ...base,
      consoleActor: { me, at: Date.now() - ACTOR_CACHE_MS - 1 },
    } as never);
    vi.mocked(callApi).mockResolvedValue(json(me));
    expect(await getConsoleActor()).toEqual({ ok: true, me });
    expect(callApi).toHaveBeenCalledWith('/v1/user/read/me', { method: 'GET' });
    expect(update).toHaveBeenCalledWith('sid-1', { consoleActor: { me, at: expect.any(Number) } });
  });

  it.each([
    ['USER_NOT_PROVISIONED', 'not_provisioned'],
    ['NOT_ORG_ADMIN', 'no_org'],
    ['NOT_APPROVED', 'not_approved'],
    ['SOMETHING_ELSE', 'not_provisioned'],
    [undefined, 'not_provisioned'],
  ])('maps 403 %s to %s', async (code, reason) => {
    vi.mocked(getSession).mockResolvedValue(base);
    vi.mocked(callApi).mockResolvedValue(json({ error: { code } }, 403));
    expect(await getConsoleActor()).toEqual({ ok: false, reason });
    expect(update).not.toHaveBeenCalled();
  });

  it('maps a 403 with an unparseable body to not_provisioned', async () => {
    vi.mocked(getSession).mockResolvedValue(base);
    vi.mocked(callApi).mockResolvedValue(
      new Response('not json', { status: 403, headers: { 'content-type': 'text/plain' } }),
    );
    expect(await getConsoleActor()).toEqual({ ok: false, reason: 'not_provisioned' });
  });

  it('reports no session', async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    expect(await getConsoleActor()).toEqual({ ok: false, reason: 'no_session' });
  });

  it('reports no_session when callApi throws "no active session"', async () => {
    vi.mocked(getSession).mockResolvedValue(base);
    vi.mocked(callApi).mockRejectedValue(new Error('no active session'));
    expect(await getConsoleActor()).toEqual({ ok: false, reason: 'no_session' });
  });

  it('reports unavailable when callApi throws any other error', async () => {
    vi.mocked(getSession).mockResolvedValue(base);
    vi.mocked(callApi).mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await getConsoleActor()).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('reports no_session on a 401', async () => {
    vi.mocked(getSession).mockResolvedValue(base);
    vi.mocked(callApi).mockResolvedValue(json({}, 401));
    expect(await getConsoleActor()).toEqual({ ok: false, reason: 'no_session' });
  });

  it('reports unavailable on any other non-ok status', async () => {
    vi.mocked(getSession).mockResolvedValue(base);
    vi.mocked(callApi).mockResolvedValue(json({}, 500));
    expect(await getConsoleActor()).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('does not cache when there is no session cookie', async () => {
    vi.mocked(getSession).mockResolvedValue(base);
    vi.mocked(callApi).mockResolvedValue(json(me));
    const { cookies } = await import('next/headers');
    vi.mocked(cookies).mockResolvedValueOnce({ get: () => undefined } as never);
    expect(await getConsoleActor()).toEqual({ ok: true, me });
    expect(update).not.toHaveBeenCalled();
  });
});
