import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as ReactModule from 'react';

const cookiesMock = vi.fn();
vi.mock('next/headers', () => ({ cookies: cookiesMock }));

const getSessionStoreMock = vi.fn();
vi.mock('@/lib/session', () => ({ getSessionStore: getSessionStoreMock }));

// The installed `react` (18.3.1, per package.json) has no `cache` export —
// Next.js vendors its own React build for that at runtime. Stub it as an
// identity wrapper so `server-session.ts` (which memoizes `getSession` via
// React's `cache()`) is importable under Vitest.
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof ReactModule>('react');
  return { ...actual, cache: <T extends (...args: never[]) => unknown>(fn: T): T => fn };
});

describe('getSession', () => {
  beforeEach(() => {
    vi.resetModules();
    cookiesMock.mockReset();
    getSessionStoreMock.mockReset();
  });

  it('returns null when no sid cookie is present', async () => {
    cookiesMock.mockResolvedValue({ get: () => undefined });
    const { getSession } = await import('@/lib/server-session');
    await expect(getSession()).resolves.toBeNull();
    expect(getSessionStoreMock).not.toHaveBeenCalled();
  });

  it('returns the session data when the store finds it', async () => {
    cookiesMock.mockResolvedValue({ get: () => ({ value: 'sid-123' }) });
    const store = { get: vi.fn().mockResolvedValue({ ok: true, value: { sub: 'user-1' } }) };
    getSessionStoreMock.mockReturnValue(store);
    const { getSession } = await import('@/lib/server-session');
    await expect(getSession()).resolves.toEqual({ sub: 'user-1' });
    expect(store.get).toHaveBeenCalledWith('sid-123');
  });

  it('returns null when the store lookup fails (expired/corrupt)', async () => {
    cookiesMock.mockResolvedValue({ get: () => ({ value: 'sid-bad' }) });
    const store = {
      get: vi.fn().mockResolvedValue({ ok: false, error: { code: 'NOT_FOUND' } }),
    };
    getSessionStoreMock.mockReturnValue(store);
    const { getSession } = await import('@/lib/server-session');
    await expect(getSession()).resolves.toBeNull();
  });
});
