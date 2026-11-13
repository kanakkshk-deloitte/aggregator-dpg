/**
 * Unit tests for the organisation decision service and owner-access grant
 * (user & org Phase 5).
 *
 * Covers `decideOrg`'s approve / reject happy paths, already-decided and
 * not-found outcomes, the compare-and-set-lost and database-failure branches,
 * mail-failure soft-fails, and every `grantOwnerAccess` result (no login,
 * fully granted, and a partial grant when a step fails), using the in-memory
 * org store, the Keycloak fake and the fake mailer (fakes over mocks).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import pino from 'pino';
import { FakeMailer, _setMailer } from '@aggregator-dpg/mailer';
import {
  OrganisationStoreFake,
  buildOrganisation,
  buildDefaultOrg,
  _setOrganisationStore,
} from '../../organisation-store/index.js';
import { IdpAdminFake, _setIdpAdmin } from '../../idp-admin/index.js';
import { decideOrg, grantOwnerAccess, type OrgDecisionInput } from '../org.js';

const log = pino({ level: 'silent' }) as unknown as FastifyBaseLogger;
const ORG_ID = '33333333-3333-4333-8333-333333333333';
const ADMIN = '00000000-0000-4000-8000-0000000000a1';

describe('decideOrg', () => {
  let store: OrganisationStoreFake;
  let idp: IdpAdminFake;
  let mailer: FakeMailer;
  let ownerSub: string;
  let groupId: string;

  beforeEach(async () => {
    store = new OrganisationStoreFake();
    idp = new IdpAdminFake();
    mailer = new FakeMailer();
    const u = await idp.createUser({ email: 'owner@org.test', enabled: false });
    if (!u.ok) throw new Error('seed kc user');
    ownerSub = u.value.id;
    const g = await idp.createGroup('org:example');
    if (!g.ok) throw new Error('seed group');
    groupId = g.value.id;
    _setOrganisationStore(store);
    _setIdpAdmin(idp);
    _setMailer(mailer);
  });

  afterEach(() => {
    _setOrganisationStore(null);
    _setIdpAdmin(null);
    _setMailer(null);
  });

  const seedPending = (over = {}) =>
    store.seed([
      buildOrganisation({
        id: ORG_ID,
        slug: 'example',
        status: 'pending',
        ownerEmail: 'owner@org.test',
        ownerKcSub: ownerSub,
        kcGroupId: groupId,
        ...over,
      }),
    ]);

  const decide = (over: Partial<OrgDecisionInput> = {}): ReturnType<typeof decideOrg> =>
    decideOrg({ orgId: ORG_ID, decision: 'approve', decidedBy: ADMIN, log, ...over });

  it('approves: grants owner access, mails the owner, reports granted', async () => {
    seedPending();
    const out = await decide({ decision: 'approve' });
    expect(out).toMatchObject({ kind: 'decided', decision: 'approve', notified: true });
    if (out.kind === 'decided') expect(out.ownerAccess.status).toBe('granted');
    const kc = await idp.findById(ownerSub);
    expect(kc.ok && kc.value?.enabled).toBe(true);
    expect(mailer.outbox).toHaveLength(1);
  });

  it('rejects: mails the owner, reports no owner access', async () => {
    seedPending();
    const out = await decide({ decision: 'reject', reason: 'incomplete' });
    expect(out).toMatchObject({ kind: 'decided', decision: 'reject', notified: true });
    if (out.kind === 'decided') expect(out.ownerAccess.status).toBe('no_login');
    expect(mailer.outbox).toHaveLength(1);
  });

  it('soft-fails a failed approval email but still reports decided', async () => {
    seedPending();
    mailer.failOnce({ code: 'TRANSPORT_FAILED', message: 'down' });
    const out = await decide({ decision: 'approve' });
    expect(out).toMatchObject({ kind: 'decided', notified: false });
  });

  it('soft-fails a failed rejection email', async () => {
    seedPending();
    mailer.failOnce({ code: 'TRANSPORT_FAILED', message: 'down' });
    const out = await decide({ decision: 'reject' });
    expect(out).toMatchObject({ kind: 'decided', decision: 'reject', notified: false });
  });

  it('returns not_found for an unknown org', async () => {
    expect(await decide()).toEqual({ kind: 'not_found' });
  });

  it('returns not_found for the Default org (never decidable)', async () => {
    store.seed([buildDefaultOrg({ id: ORG_ID })]);
    expect(await decide()).toEqual({ kind: 'not_found' });
  });

  it('returns already_decided when the org is no longer pending', async () => {
    seedPending({ status: 'active', updatedBy: ADMIN });
    const out = await decide();
    expect(out).toMatchObject({ kind: 'already_decided', status: 'active', decidedBy: 'console' });
  });

  it('dates an already-rejected org with no rejected_at from updated_at', async () => {
    seedPending({ status: 'inactive', rejectedAt: null, updatedBy: ADMIN });
    const out = await decide();
    expect(out).toMatchObject({ kind: 'already_decided', status: 'inactive' });
    if (out.kind === 'already_decided') expect(out.decidedAt).toBeInstanceOf(Date);
  });

  it('reports unavailable when the initial read fails', async () => {
    store.findById = async () => ({ ok: false, error: { code: 'DB_UNAVAILABLE', message: 'x' } });
    expect(await decide()).toEqual({ kind: 'unavailable', dependency: 'db' });
  });

  it('reports unavailable when the compare-and-set itself errors', async () => {
    seedPending();
    store.approve = async () => ({ ok: false, error: { code: 'DB_UNAVAILABLE', message: 'x' } });
    expect(await decide({ decision: 'approve' })).toEqual({
      kind: 'unavailable',
      dependency: 'db',
    });
  });

  it('answers already_decided when the approve CAS loses to a concurrent decision', async () => {
    seedPending();
    store.approve = async () => {
      await store.reject(ORG_ID, 'admin');
      return { ok: true, value: null };
    };
    const out = await decide({ decision: 'approve' });
    expect(out).toMatchObject({ kind: 'already_decided', status: 'inactive', decidedBy: 'link' });
  });

  it('reports unavailable when the re-read after a lost CAS fails', async () => {
    seedPending();
    let reads = 0;
    const realFind = store.findById.bind(store);
    store.findById = async (id: string) => {
      reads += 1;
      return reads === 1
        ? realFind(id)
        : { ok: false, error: { code: 'DB_UNAVAILABLE' as const, message: 'x' } };
    };
    store.reject = async () => ({ ok: true, value: null });
    expect(await decide({ decision: 'reject' })).toEqual({ kind: 'unavailable', dependency: 'db' });
  });

  it('returns not_found when the row is gone after a lost CAS', async () => {
    seedPending();
    let reads = 0;
    const realFind = store.findById.bind(store);
    store.findById = async (id: string) => {
      reads += 1;
      return reads === 1 ? realFind(id) : { ok: true, value: null };
    };
    store.reject = async () => ({ ok: true, value: null });
    expect(await decide({ decision: 'reject' })).toEqual({ kind: 'not_found' });
  });
});

describe('grantOwnerAccess', () => {
  let idp: IdpAdminFake;
  let ownerSub: string;
  let groupId: string;

  beforeEach(async () => {
    idp = new IdpAdminFake();
    const u = await idp.createUser({ email: 'o@test', enabled: false });
    if (!u.ok) throw new Error('seed');
    ownerSub = u.value.id;
    const g = await idp.createGroup('g');
    if (!g.ok) throw new Error('seed');
    groupId = g.value.id;
    _setIdpAdmin(idp);
  });

  afterEach(() => _setIdpAdmin(null));

  it('skips entirely when the owner has no recorded login', async () => {
    const org = buildOrganisation({ ownerKcSub: null });
    expect(await grantOwnerAccess(org, log)).toEqual({
      status: 'no_login',
      enable: 'skipped',
      role: 'skipped',
      group: 'skipped',
    });
  });

  it('grants with the group skipped when the org has no group', async () => {
    const org = buildOrganisation({ ownerKcSub: ownerSub, kcGroupId: null });
    const r = await grantOwnerAccess(org, log);
    expect(r).toEqual({ status: 'granted', enable: 'ok', role: 'ok', group: 'skipped' });
  });

  it('fully grants enable, role and group when all succeed', async () => {
    const org = buildOrganisation({ ownerKcSub: ownerSub, kcGroupId: groupId });
    const r = await grantOwnerAccess(org, log);
    expect(r).toEqual({ status: 'granted', enable: 'ok', role: 'ok', group: 'ok' });
  });

  it('reports partial when the role assignment fails', async () => {
    const org = buildOrganisation({ ownerKcSub: ownerSub, kcGroupId: groupId });
    idp.assignRealmRole = async () => ({
      ok: false,
      error: { code: 'BAD_REQUEST', message: 'nope' },
    });
    const r = await grantOwnerAccess(org, log);
    expect(r).toMatchObject({ status: 'partial', enable: 'ok', role: 'failed', group: 'ok' });
  });

  it('reports partial when the user enable fails', async () => {
    const org = buildOrganisation({ ownerKcSub: ownerSub, kcGroupId: groupId });
    idp.enableUser = async () => ({ ok: false, error: { code: 'BAD_REQUEST', message: 'nope' } });
    const r = await grantOwnerAccess(org, log);
    expect(r).toMatchObject({ status: 'partial', enable: 'failed', role: 'ok', group: 'ok' });
  });

  it('reports partial when adding the user to the group fails', async () => {
    const org = buildOrganisation({ ownerKcSub: ownerSub, kcGroupId: groupId });
    idp.addUserToGroup = async () => ({
      ok: false,
      error: { code: 'BAD_REQUEST', message: 'nope' },
    });
    const r = await grantOwnerAccess(org, log);
    expect(r).toMatchObject({ status: 'partial', enable: 'ok', role: 'ok', group: 'failed' });
  });
});
