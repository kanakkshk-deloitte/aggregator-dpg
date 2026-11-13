/**
 * Unit tests for best-effort login recording (`identity-store/record.ts`,
 * `@aggregator-dpg/api`): once per process per user, never throws, never
 * overwrites, and a transient failure is retried on the next call.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { _setIdentityStore } from '../index.js';
import { IdentityStoreFake } from '../testing.js';
import { InMemoryIdentityStore } from '../memory.js';
import { _resetRecordedIdentities, recordLoginIdentity } from '../record.js';
import type { IdentityStoreResult, LinkOutcome } from '../interface.js';

afterEach(() => {
  _setIdentityStore(null);
  _resetRecordedIdentities();
});

class CountingStore extends InMemoryIdentityStore {
  calls = 0;
  override link(
    u: string,
    p: string,
    s: string,
    t?: 'admin' | 'coordinator',
  ): Promise<IdentityStoreResult<LinkOutcome>> {
    this.calls += 1;
    return super.link(u, p, s, t);
  }
}

describe('recordLoginIdentity', () => {
  it('links the keycloak subject and writes only once per process', async () => {
    const store = new CountingStore();
    _setIdentityStore(store);
    await recordLoginIdentity('u1', 'sub-1', 'test');
    await recordLoginIdentity('u1', 'sub-1', 'test');
    expect(store.calls).toBe(1);
    expect(await store.subjectOf('u1', 'keycloak')).toEqual({ ok: true, value: 'sub-1' });
  });

  it('does not throw on a conflict and does not retry it', async () => {
    const store = new IdentityStoreFake();
    store.seed([{ userId: 'u1', provider: 'keycloak', subject: 'old' }]);
    _setIdentityStore(store);
    await expect(recordLoginIdentity('u1', 'new', 'test')).resolves.toBeUndefined();
    expect(await store.subjectOf('u1', 'keycloak')).toEqual({ ok: true, value: 'old' });
  });

  it('retries after a transient database failure', async () => {
    let calls = 0;
    class FlakyStore extends InMemoryIdentityStore {
      override link(
        u: string,
        p: string,
        s: string,
        t?: 'admin' | 'coordinator',
      ): Promise<IdentityStoreResult<LinkOutcome>> {
        calls += 1;
        if (calls === 1) {
          return Promise.resolve({ ok: false, error: { code: 'DB_UNAVAILABLE', message: 'down' } });
        }
        return super.link(u, p, s, t);
      }
    }
    _setIdentityStore(new FlakyStore());
    await recordLoginIdentity('u1', 'sub-1', 'test');
    await recordLoginIdentity('u1', 'sub-1', 'test');
    expect(calls).toBe(2);
  });
});
