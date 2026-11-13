// The coordinator decision service's race handling (design R3): reject is
// compare-and-set first; an approval that loses its compare-and-set to a
// concurrent reject undoes what it did in Keycloak.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import pino from 'pino';
import { FakeMailer, _setMailer } from '@aggregator-dpg/mailer';
import { buildBlueDotConfig } from '@aggregator-dpg/network-config/testing';
import { SignalStackWriterFake } from '@aggregator-dpg/signalstack-writer/testing';
import { UserStoreFake, buildCoordinator, _setUserStore } from '../../user-store/index.js';
import {
  OrganisationStoreFake,
  buildDefaultOrg,
  _setOrganisationStore,
} from '../../organisation-store/index.js';
import { IdpAdminFake, KC_ATTR, _setIdpAdmin } from '../../idp-admin/index.js';
import { _setNetworkConfig } from '../../network-config.js';
import { _setSignalStackWriter } from '../../signalstack.js';
import {
  decideCoordinator,
  priorDecision,
  deciderOf,
  loadCoordinatorAndUser,
  LINK_DECIDER,
} from '../coordinator.js';

const ID = '11111111-1111-4111-8111-111111111111';
const log = pino({ level: 'silent' }) as unknown as FastifyBaseLogger;

describe('decideCoordinator', () => {
  let store: UserStoreFake;
  let idp: IdpAdminFake;
  let mailer: FakeMailer;
  let kcId: string;

  beforeEach(async () => {
    store = new UserStoreFake();
    store.seed([
      buildCoordinator({
        id: ID,
        status: 'pending',
        parentOrgId: buildDefaultOrg().id,
        isDefaultOrg: true,
      }),
    ]);
    const orgs = new OrganisationStoreFake();
    orgs.seed([buildDefaultOrg()]);
    idp = new IdpAdminFake();
    const user = await idp.createUser({
      email: 'c@x.test',
      enabled: false,
      attributes: { [KC_ATTR.AGGREGATOR_ID]: ID },
    });
    if (!user.ok) throw new Error('seed failed');
    kcId = user.value.id;
    mailer = new FakeMailer();
    _setUserStore(store);
    _setOrganisationStore(orgs);
    _setIdpAdmin(idp);
    _setMailer(mailer);
    _setNetworkConfig(buildBlueDotConfig());
    _setSignalStackWriter(new SignalStackWriterFake());
  });

  afterEach(() => {
    _setUserStore(null);
    _setOrganisationStore(null);
    _setIdpAdmin(null);
    _setMailer(null);
    _setNetworkConfig(null);
    _setSignalStackWriter(null);
  });

  const ADMIN = '00000000-0000-4000-8000-0000000000a1';
  const decide = (decision: 'approve' | 'reject', decidedBy = ADMIN) =>
    decideCoordinator({ aggregatorId: ID, decision, decidedBy, log });

  it('approves: enables the user, records the decider, mails once', async () => {
    const out = await decide('approve');
    expect(out).toEqual({ kind: 'decided', decision: 'approve', notified: true });
    const kc = await idp.findById(kcId);
    expect(kc.ok && kc.value?.enabled).toBe(true);
    const row = await store.findById(ID);
    expect(row.ok && row.value?.updatedBy).toBe(ADMIN);
    expect(mailer.outbox).toHaveLength(1);
  });

  it('undoes Keycloak when a concurrent reject wins the approval compare-and-set', async () => {
    const real = store.approveFromPending.bind(store);
    store.approveFromPending = async (id, by) => {
      // The emailed link rejects between this approval's provisioning and its CAS.
      await store.rejectFromPending(id, LINK_DECIDER);
      return real(id, by);
    };
    const out = await decide('approve');
    expect(out).toMatchObject({ kind: 'already_decided', status: 'inactive', decidedBy: 'link' });
    const kc = await idp.findById(kcId);
    expect(kc.ok && kc.value?.enabled).toBe(false);
    expect(kc.ok && kc.value?.attributes?.[KC_ATTR.DECISION_MADE]).toEqual(['rejected']);
    // Only the winner mails (the reject here bypassed the service: no mail at all).
    expect(mailer.outbox).toHaveLength(0);
  });

  it('undoes Keycloak when the approval compare-and-set fails in the database', async () => {
    store.approveFromPending = async () => ({
      ok: false,
      error: { code: 'DB_UNAVAILABLE', message: 'down' },
    });
    expect(await decide('approve')).toEqual({ kind: 'unavailable', dependency: 'db' });
    const kc = await idp.findById(kcId);
    expect(kc.ok && kc.value?.enabled).toBe(false);
    expect(kc.ok && kc.value?.attributes?.[KC_ATTR.DECISION_MADE]).toEqual(['rejected']);
    expect(mailer.outbox).toHaveLength(0);
  });

  it('reports an unknown decider as null, not as the console', async () => {
    await store.approveFromPending(ID, 'self');
    expect(await decide('reject')).toMatchObject({ kind: 'already_decided', decidedBy: null });
  });

  it('a reject that loses its compare-and-set changes nothing and mails nobody', async () => {
    await store.approveFromPending(ID, '00000000-0000-4000-8000-0000000000a2');
    const real = store.rejectFromPending.bind(store);
    let calls = 0;
    store.rejectFromPending = async (id, by) => {
      calls += 1;
      return real(id, by);
    };
    const out = await decide('reject');
    // The pre-read already sees the approval: no CAS attempted.
    expect(out).toMatchObject({ kind: 'already_decided', status: 'active', decidedBy: 'console' });
    expect(calls).toBe(0);
    expect(mailer.outbox).toHaveLength(0);
  });

  it('answers already_decided when the reject CAS itself loses', async () => {
    store.rejectFromPending = async () => {
      await store.approveFromPending(ID, LINK_DECIDER);
      return { ok: true, value: null };
    };
    const out = await decide('reject');
    expect(out).toMatchObject({ kind: 'already_decided', status: 'active', decidedBy: 'link' });
    expect(mailer.outbox).toHaveLength(0);
  });

  it('refuses to approve into an inactive org', async () => {
    const orgs = new OrganisationStoreFake();
    orgs.seed([{ ...buildDefaultOrg(), status: 'inactive' }]);
    _setOrganisationStore(orgs);
    expect(await decide('approve')).toEqual({ kind: 'org_inactive' });
  });

  it('reports unavailable db when the org read fails during approve', async () => {
    const orgs = new OrganisationStoreFake();
    orgs.findById = async () => ({ ok: false, error: { code: 'DB_UNAVAILABLE', message: 'x' } });
    _setOrganisationStore(orgs);
    expect(await decide('approve')).toEqual({ kind: 'unavailable', dependency: 'db' });
  });

  it('maps a coordinator-row read failure to unavailable db', async () => {
    store.findById = async () => ({ ok: false, error: { code: 'DB_UNAVAILABLE', message: 'x' } });
    expect(await decide('approve')).toEqual({ kind: 'unavailable', dependency: 'db' });
  });

  it('maps a missing coordinator row to not_found', async () => {
    store.findById = async () => ({ ok: true, value: null });
    expect(await decide('approve')).toEqual({ kind: 'not_found' });
  });

  it('maps a Keycloak lookup failure to unavailable idp', async () => {
    idp.findByAttribute = async () => ({ ok: false, error: { code: 'BAD_REQUEST', message: 'x' } });
    expect(await decide('approve')).toEqual({ kind: 'unavailable', dependency: 'idp' });
  });

  it('maps a missing Keycloak user to not_found', async () => {
    idp.findByAttribute = async () => ({ ok: true, value: null });
    expect(await decide('approve')).toEqual({ kind: 'not_found' });
  });

  it('returns not_found when a lost approval finds the row gone', async () => {
    let reads = 0;
    const realFind = store.findById.bind(store);
    store.findById = async (id: string) => {
      reads += 1;
      return reads <= 1 ? realFind(id) : { ok: true, value: null };
    };
    store.approveFromPending = async () => ({ ok: true, value: null });
    expect(await decide('approve')).toEqual({ kind: 'not_found' });
  });

  it('still compensates (logging the failure) when the Keycloak undo itself fails', async () => {
    idp.disableUser = async () => ({ ok: false, error: { code: 'BAD_REQUEST', message: 'x' } });
    store.approveFromPending = async () => ({
      ok: false,
      error: { code: 'DB_UNAVAILABLE', message: 'down' },
    });
    expect(await decide('approve')).toEqual({ kind: 'unavailable', dependency: 'db' });
  });

  it('reject: unavailable db when the re-read after a lost CAS fails', async () => {
    store.rejectFromPending = async () => ({ ok: true, value: null });
    store.findById = async () => ({ ok: false, error: { code: 'DB_UNAVAILABLE', message: 'x' } });
    expect(await decide('reject')).toEqual({ kind: 'unavailable', dependency: 'db' });
  });

  it('reject: not_found when the row is gone after a lost CAS', async () => {
    let reads = 0;
    const realFind = store.findById.bind(store);
    store.findById = async (id: string) => {
      reads += 1;
      return reads <= 1 ? realFind(id) : { ok: true, value: null };
    };
    store.rejectFromPending = async () => ({ ok: true, value: null });
    expect(await decide('reject')).toEqual({ kind: 'not_found' });
  });

  it('dates an already-rejected row with no rejected_at from updated_at', async () => {
    store.seed([
      buildCoordinator({
        id: ID,
        status: 'inactive',
        rejectedAt: null,
        updatedBy: LINK_DECIDER,
        parentOrgId: buildDefaultOrg().id,
        isDefaultOrg: true,
      }),
    ]);
    const out = await decide('approve');
    expect(out).toMatchObject({ kind: 'already_decided', status: 'inactive', decidedBy: 'link' });
  });
});

describe('priorDecision', () => {
  it('maps stored statuses to their recorded decision', () => {
    expect(priorDecision('active')).toBe('approved');
    expect(priorDecision('retired')).toBe('approved');
    expect(priorDecision('inactive')).toBe('rejected');
    expect(priorDecision('pending')).toBeNull();
  });
});

describe('deciderOf', () => {
  it('tells a link, a console admin id and an unknown writer apart', () => {
    expect(deciderOf(LINK_DECIDER)).toBe('link');
    expect(deciderOf('00000000-0000-4000-8000-0000000000a1')).toBe('console');
    expect(deciderOf('self')).toBeNull();
    expect(deciderOf(null)).toBeNull();
  });
});

describe('loadCoordinatorAndUser', () => {
  it('returns not_found when the coordinator row is missing', async () => {
    const store = new UserStoreFake();
    _setUserStore(store);
    _setIdpAdmin(new IdpAdminFake());
    const r = await loadCoordinatorAndUser('11111111-1111-4111-8111-111111111111');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not_found');
    _setUserStore(null);
    _setIdpAdmin(null);
  });
});
