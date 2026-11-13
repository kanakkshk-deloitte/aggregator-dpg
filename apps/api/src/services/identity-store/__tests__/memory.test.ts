/**
 * Unit tests for the in-memory identity store (`@aggregator-dpg/api`): the same
 * rules as the Postgres adapter — link once, never overwrite, one account per
 * external login.
 */
import { describe, expect, it } from 'vitest';
import { IdentityStoreFake, buildIdentity } from '../testing.js';

describe('InMemoryIdentityStore', () => {
  it('links once, then reports already', async () => {
    const s = new IdentityStoreFake();
    expect(await s.link('u1', 'keycloak', 's1')).toEqual({ ok: true, value: 'linked' });
    expect(await s.link('u1', 'keycloak', 's1')).toEqual({ ok: true, value: 'already' });
    expect(await s.subjectOf('u1', 'keycloak')).toEqual({ ok: true, value: 's1' });
    expect(await s.userOf('keycloak', 's1')).toEqual({ ok: true, value: 'u1' });
  });

  it('never overwrites a different subject (MISMATCH)', async () => {
    const s = new IdentityStoreFake();
    s.seed([buildIdentity({ userId: 'u1', subject: 's1' })]);
    const r = await s.link('u1', 'keycloak', 's2');
    expect(r.ok || r.error.code).toBe('MISMATCH');
    expect(await s.subjectOf('u1', 'keycloak')).toEqual({ ok: true, value: 's1' });
  });

  it('refuses a subject linked to another account (DUPLICATE)', async () => {
    const s = new IdentityStoreFake();
    s.seed([buildIdentity({ userId: 'u1', subject: 's1' })]);
    const r = await s.link('u2', 'keycloak', 's1');
    expect(r.ok || r.error.code).toBe('DUPLICATE');
  });

  it('keeps providers independent (another IdP is a new provider value)', async () => {
    const s = new IdentityStoreFake();
    await s.link('u1', 'keycloak', 's1');
    expect(await s.link('u1', 'other-idp', 'x9')).toEqual({ ok: true, value: 'linked' });
    expect(s.all()).toHaveLength(2);
  });

  it('returns null for unknown users and subjects', async () => {
    const s = new IdentityStoreFake();
    expect(await s.subjectOf('nobody', 'keycloak')).toEqual({ ok: true, value: null });
    expect(await s.userOf('keycloak', 'nobody')).toEqual({ ok: true, value: null });
  });
});
