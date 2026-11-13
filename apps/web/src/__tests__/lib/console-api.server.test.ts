import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/upstream-client', () => ({ callApi: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
  notFound: vi.fn(() => {
    throw new Error('NOT_FOUND');
  }),
}));

import { consoleRead } from '@/lib/console-api.server';
import { callApi } from '@/lib/upstream-client';
import { redirect, notFound } from 'next/navigation';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('consoleRead (console-api.server)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads a resource with GET when no body is given', async () => {
    vi.mocked(callApi).mockResolvedValue(json({ id: 'org-1' }));
    await expect(consoleRead('/v1/org/read/org-1')).resolves.toEqual({ id: 'org-1' });
    expect(callApi).toHaveBeenCalledWith('/v1/org/read/org-1', { method: 'GET' });
  });

  it('reads with a POST (search) when a body is given', async () => {
    vi.mocked(callApi).mockResolvedValue(json({ results: [] }));
    await expect(consoleRead('/v1/org/search', { q: 'x' })).resolves.toEqual({ results: [] });
    expect(callApi).toHaveBeenCalledWith('/v1/org/search', { method: 'POST', body: { q: 'x' } });
  });

  it('redirects to login when callApi throws (no session)', async () => {
    vi.mocked(callApi).mockRejectedValue(new Error('no active session'));
    await expect(consoleRead('/v1/org/read/x')).rejects.toThrow('REDIRECT:/api/auth/login?returnTo=/console');
    expect(redirect).toHaveBeenCalledWith('/api/auth/login?returnTo=/console');
  });

  it('redirects to login on 401', async () => {
    vi.mocked(callApi).mockResolvedValue(json({}, 401));
    await expect(consoleRead('/v1/org/read/x')).rejects.toThrow('REDIRECT:/api/auth/login?returnTo=/console');
    expect(redirect).toHaveBeenCalledWith('/api/auth/login?returnTo=/console');
  });

  it('calls notFound on 404', async () => {
    vi.mocked(callApi).mockResolvedValue(json({}, 404));
    await expect(consoleRead('/v1/org/read/x')).rejects.toThrow('NOT_FOUND');
    expect(notFound).toHaveBeenCalled();
  });

  it('logs out with console_not_provisioned on 403 USER_NOT_PROVISIONED', async () => {
    vi.mocked(callApi).mockResolvedValue(json({ error: { code: 'USER_NOT_PROVISIONED' } }, 403));
    await expect(consoleRead('/v1/org/read/x')).rejects.toThrow(
      'REDIRECT:/api/auth/logout?reason=console_not_provisioned',
    );
  });

  it('logs out with console_no_org on 403 NOT_ORG_ADMIN', async () => {
    vi.mocked(callApi).mockResolvedValue(json({ error: { code: 'NOT_ORG_ADMIN' } }, 403));
    await expect(consoleRead('/v1/org/read/x')).rejects.toThrow(
      'REDIRECT:/api/auth/logout?reason=console_no_org',
    );
  });

  it('redirects to /console on 403 with any other code', async () => {
    vi.mocked(callApi).mockResolvedValue(json({ error: { code: 'SOMETHING_ELSE' } }, 403));
    await expect(consoleRead('/v1/org/read/x')).rejects.toThrow('REDIRECT:/console');
    expect(redirect).toHaveBeenCalledWith('/console');
  });

  it('redirects to /console on 403 with an unparseable body', async () => {
    vi.mocked(callApi).mockResolvedValue(
      new Response('not json', { status: 403, headers: { 'content-type': 'text/plain' } }),
    );
    await expect(consoleRead('/v1/org/read/x')).rejects.toThrow('REDIRECT:/console');
    expect(redirect).toHaveBeenCalledWith('/console');
  });

  it('throws on any other non-ok status', async () => {
    vi.mocked(callApi).mockResolvedValue(json({}, 500));
    await expect(consoleRead('/v1/org/read/x')).rejects.toThrow('console read failed (500)');
  });
});
