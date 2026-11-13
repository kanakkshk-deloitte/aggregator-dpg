/**
 * Unit tests for InMemoryRoleStore's live-role reads, which back the console's
 * coordinator list (#873).
 */
import { describe, it, expect } from 'vitest';
import { InMemoryRoleStore } from '../memory.js';

const NOW = new Date('2026-06-01T00:00:00Z');
const DAY = 86_400_000;

describe('InMemoryRoleStore.listLiveForUsers', () => {
  it('returns only the live roles of the requested users', async () => {
    const store = new InMemoryRoleStore();
    store.seed([
      { userId: 'u1', roleKey: 'data_export', orgId: 'o1' },
      {
        userId: 'u1',
        roleKey: 'pii_access',
        orgId: 'o1',
        expiresAt: new Date(NOW.getTime() + DAY),
      },
      { userId: 'u2', roleKey: 'pii_access', orgId: 'o1', revokedAt: NOW, revokedBy: 'admin' },
      { userId: 'u3', roleKey: 'data_export', orgId: 'o1', expiresAt: NOW },
      { userId: 'u4', roleKey: 'data_export', orgId: 'o1' },
    ]);
    const res = await store.listLiveForUsers(['u1', 'u2', 'u3'], NOW);
    expect(
      res.ok && res.value.map((r) => `${r.userId}:${r.roleKey}`).sort((a, b) => a.localeCompare(b)),
    ).toEqual(['u1:data_export', 'u1:pii_access']);
  });

  it('returns an empty list for no users', async () => {
    const store = new InMemoryRoleStore();
    store.seed([{ userId: 'u1', roleKey: 'data_export', orgId: 'o1' }]);
    expect(await store.listLiveForUsers([], NOW)).toEqual({ ok: true, value: [] });
  });

  it('reports the store failure', async () => {
    const store = new InMemoryRoleStore();
    store.failWith({ code: 'DB_UNAVAILABLE', message: 'down' });
    expect(await store.listLiveForUsers(['u1'], NOW)).toEqual({
      ok: false,
      error: { code: 'DB_UNAVAILABLE', message: 'down' },
    });
  });
});

describe('InMemoryRoleStore.listUsersExpiredBetween', () => {
  const at = (ms: number) => new Date(NOW.getTime() + ms);

  it('returns each user with an unrevoked role that expired in (from, to], once', async () => {
    const store = new InMemoryRoleStore();
    store.seed([
      { userId: 'u1', roleKey: 'pii_access', orgId: 'o1', expiresAt: at(-1000) },
      { userId: 'u1', roleKey: 'data_export', orgId: 'o1', expiresAt: at(-500) },
      { userId: 'u2', roleKey: 'pii_access', orgId: 'o1', expiresAt: at(0) },
      { userId: 'u3', roleKey: 'pii_access', orgId: 'o1', expiresAt: at(-DAY) },
      { userId: 'u4', roleKey: 'pii_access', orgId: 'o1', expiresAt: at(DAY) },
      { userId: 'u5', roleKey: 'data_export', orgId: 'o1' },
      {
        userId: 'u6',
        roleKey: 'pii_access',
        orgId: 'o1',
        expiresAt: at(-1000),
        revokedAt: at(-2000),
        revokedBy: 'admin',
      },
    ]);
    const res = await store.listUsersExpiredBetween(at(-60_000), NOW);
    expect(res.ok && [...res.value].sort()).toEqual(['u1', 'u2']);
  });

  it('excludes an expiry exactly at the window start', async () => {
    const store = new InMemoryRoleStore();
    store.seed([{ userId: 'u1', roleKey: 'pii_access', orgId: 'o1', expiresAt: at(-60_000) }]);
    expect(await store.listUsersExpiredBetween(at(-60_000), NOW)).toEqual({ ok: true, value: [] });
  });

  it('reports the store failure', async () => {
    const store = new InMemoryRoleStore();
    store.failWith({ code: 'DB_UNAVAILABLE', message: 'down' });
    expect((await store.listUsersExpiredBetween(at(-1), NOW)).ok).toBe(false);
  });
});
