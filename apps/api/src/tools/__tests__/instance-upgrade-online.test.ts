import { beforeEach, describe, expect, it } from 'vitest';
import { IdpAdminFake } from '../../services/idp-admin/testing.js';
import { IdentityStoreFake } from '../../services/identity-store/testing.js';
import { IDP_PROVIDER } from '../../services/idp-admin/provider.js';
import { enableOwnersStep, enrichExitCode, enrichIdentities } from '../instance-upgrade-online.js';
import { buildOrganisation, buildDefaultOrg } from '../../services/organisation-store/index.js';
import type { Organisation } from '../../services/organisation-store/index.js';
import { PLACEHOLDER_OWNER_EMAIL } from '../../services/organisation-root.js';

const C1 = '11111111-1111-4111-8111-111111111111';
const C2 = '22222222-2222-4222-8222-222222222222';
const C3 = '33333333-3333-4333-8333-333333333333';

async function kcUser(idp: IdpAdminFake, n: number, aggregatorId: string): Promise<string> {
  const r = await idp.createUser({
    email: `u${n}@x.test`,
    firstName: 'U',
    lastName: `${n}`,
    attributes: { aggregator_id: aggregatorId },
  } as Parameters<IdpAdminFake['createUser']>[0]);
  if (!r.ok) throw new Error('seed failed');
  return r.value.id;
}

describe('enrichIdentities', () => {
  let idp: IdpAdminFake;
  let identities: IdentityStoreFake;
  const pauses: number[] = [];
  const deps = (ids: string[]) => ({
    idp,
    identities,
    listCandidates: () => Promise.resolve(ids),
    pause: (ms: number) => {
      pauses.push(ms);
      return Promise.resolve();
    },
  });

  beforeEach(() => {
    idp = new IdpAdminFake();
    identities = new IdentityStoreFake();
    pauses.length = 0;
  });

  it('links found logins, counts the missing ones and paces every call', async () => {
    const sub1 = await kcUser(idp, 1, C1);
    await kcUser(idp, 2, C2);
    identities.seed([{ userId: C2, provider: IDP_PROVIDER, subject: 'other-subject' }]);
    const report = await enrichIdentities(deps([C1, C2, C3]), {
      dryRun: false,
      ratePerSecond: 4,
    });
    expect(report).toEqual({
      candidates: 3,
      linked: 1,
      already: 0,
      notInKeycloak: 1,
      conflicts: 1,
      failed: 0,
      absentIds: [C3],
      conflictIds: [C2],
    });
    const again = await identities.link(C1, IDP_PROVIDER, sub1, 'coordinator');
    expect(again).toEqual({ ok: true, value: 'already' });
    expect(pauses).toEqual([250, 250, 250]);
  });

  it('writes nothing on a dry run', async () => {
    await kcUser(idp, 1, C1);
    const report = await enrichIdentities(deps([C1]), { dryRun: true, ratePerSecond: 1000 });
    expect(report.linked).toBe(0);
    expect(await identities.link(C1, IDP_PROVIDER, 'x', 'coordinator')).toEqual({
      ok: true,
      value: 'linked',
    });
  });

  it('counts a Keycloak failure and carries on', async () => {
    await kcUser(idp, 2, C2);
    idp.failOnce({ code: 'IDP_UNAVAILABLE', message: 'down' });
    const report = await enrichIdentities(deps([C1, C2]), { dryRun: false, ratePerSecond: 1000 });
    expect(report).toMatchObject({ candidates: 2, failed: 1, linked: 1 });
  });

  it('refuses a rate that would disable the pacing', async () => {
    await expect(
      enrichIdentities(deps([C1]), { dryRun: false, ratePerSecond: Number('abc') }),
    ).rejects.toThrow(RangeError);
    await expect(enrichIdentities(deps([C1]), { dryRun: false, ratePerSecond: 0 })).rejects.toThrow(
      RangeError,
    );
  });

  it('does nothing without candidates', async () => {
    expect(await enrichIdentities(deps([]), { dryRun: false, ratePerSecond: 5 })).toMatchObject({
      candidates: 0,
      linked: 0,
    });
    expect(pauses).toEqual([]);
  });
});

describe('enrichExitCode', () => {
  it('passes when every lookup answered, absent users included', () => {
    expect(enrichExitCode({ failed: 0, conflicts: 0 }, { failed: 0 })).toBe(0);
  });

  it('fails on a lookup failure, a login conflict or an owner-name failure', () => {
    expect(enrichExitCode({ failed: 1, conflicts: 0 }, { failed: 0 })).toBe(1);
    expect(enrichExitCode({ failed: 0, conflicts: 1 }, { failed: 0 })).toBe(1);
    expect(enrichExitCode({ failed: 0, conflicts: 0 }, { failed: 1 })).toBe(1);
  });
});

describe('enableOwnersStep', () => {
  let idp: IdpAdminFake;
  const granted: string[] = [];

  const org = (id: string, over: Partial<Organisation> = {}) =>
    buildOrganisation({ id, slug: `o-${id.slice(0, 4)}`, status: 'active', ...over });

  const deps = (orgs: Organisation[], status: 'granted' | 'partial' = 'granted') => ({
    idp,
    listActiveOrgs: () => Promise.resolve(orgs),
    grant: (o: Organisation) => {
      granted.push(o.id);
      return Promise.resolve({ status });
    },
    pause: () => Promise.resolve(),
  });

  beforeEach(() => {
    idp = new IdpAdminFake();
    granted.length = 0;
  });

  async function owner(n: number): Promise<string> {
    const r = await idp.createUser({ email: `o${n}@x.test`, enabled: false });
    if (!r.ok) throw new Error('seed failed');
    return r.value.id;
  }

  it('grants each owner with a login; lists those without one or with a deleted user', async () => {
    const sub = await owner(1);
    const report = await enableOwnersStep(
      deps([
        org(C1, { ownerKcSub: sub }),
        org(C2, { ownerKcSub: null }),
        org(C3, { ownerKcSub: 'gone' }),
      ]),
      { dryRun: false, ratePerSecond: 100 },
    );
    expect(report).toMatchObject({ orgs: 3, granted: 1, noLogin: 1, missingUser: 1, failed: 0 });
    expect(report.noLoginIds).toEqual([C2]);
    expect(report.missingIds).toEqual([C3]);
    expect(granted).toEqual([C1]);
  });

  it('skips the Default org and placeholder owners', async () => {
    const report = await enableOwnersStep(
      deps([buildDefaultOrg(), org(C1, { ownerEmail: PLACEHOLDER_OWNER_EMAIL })]),
      { dryRun: false, ratePerSecond: 100 },
    );
    expect(report.orgs).toBe(0);
  });

  it('changes nothing on a dry run', async () => {
    const sub = await owner(2);
    const report = await enableOwnersStep(deps([org(C1, { ownerKcSub: sub })]), {
      dryRun: true,
      ratePerSecond: 100,
    });
    expect(report.granted).toBe(1);
    expect(granted).toEqual([]);
  });

  it('counts a partial grant or a lookup error as failed', async () => {
    const sub = await owner(3);
    const partial = await enableOwnersStep(deps([org(C1, { ownerKcSub: sub })], 'partial'), {
      dryRun: false,
      ratePerSecond: 100,
    });
    expect(partial.failedIds).toEqual([C1]);
    idp.failOnce({ code: 'IDP_UNAVAILABLE', message: 'down' });
    const down = await enableOwnersStep(deps([org(C2, { ownerKcSub: sub })]), {
      dryRun: false,
      ratePerSecond: 100,
    });
    expect(down.failedIds).toEqual([C2]);
  });

  it('refuses a non-positive rate', async () => {
    await expect(enableOwnersStep(deps([]), { dryRun: true, ratePerSecond: 0 })).rejects.toThrow(
      RangeError,
    );
  });
});
