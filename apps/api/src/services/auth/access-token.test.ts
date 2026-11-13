/**
 * Tests for the approval gate + signalstack login-time backfill.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { requireApproved, _setAccessTokenVerifier, _resetJwks } from './access-token.js';
import { getIdentityStore } from '../identity-store/index.js';
import type { IdentityStoreFake } from '../identity-store/testing.js';
import { UserStoreFake, _setUserStore, buildCoordinator } from '../user-store/index.js';
import { IdpAdminFake, _setIdpAdmin } from '../idp-admin/index.js';
import { _setSignalStackWriter } from '../signalstack.js';
import { _setNetworkConfig } from '../network-config.js';
import { buildBlueDotConfig } from '@aggregator-dpg/network-config/testing';
import { SignalStackWriterFake } from '@aggregator-dpg/signalstack-writer/testing';
import { SignalStackWriterBase } from '@aggregator-dpg/signalstack-writer/interface';
import { UpstreamError } from '@aggregator-dpg/shared-primitives/errors';
import { err } from '@aggregator-dpg/shared-primitives/result';

const aggregatorId = '11111111-1111-1111-1111-111111111111';

function makeReq(claims: Record<string, unknown>): FastifyRequest {
  _setAccessTokenVerifier(async () => claims);
  return {
    headers: { authorization: 'Bearer stub' },
  } as unknown as FastifyRequest;
}

describe('requireApproved + signalstack backfill', () => {
  let store: UserStoreFake;
  let idp: IdpAdminFake;
  let writer: SignalStackWriterFake;
  let kcUserId: string;

  beforeEach(async () => {
    _resetJwks();
    process.env.KEYCLOAK_URL = 'http://kc.local';
    process.env.KEYCLOAK_REALM = 'bluedots';
    process.env.SIGNALSTACK_BASE_URL = 'http://stub-signalstack';
    process.env.SIGNALSTACK_ADMIN_KEY = 'stub-key';
    process.env.SIGNALSTACK_ACTING_ORG_ID = 'org_platform';

    store = new UserStoreFake();
    store.seed([
      buildCoordinator({
        id: aggregatorId,
        orgSlug: 'trrain-abcd',
        name: 'TRRAIN',
        status: 'active',
      }),
    ]);
    _setUserStore(store);

    idp = new IdpAdminFake();
    const created = await idp.createUser({
      email: 'asha@trrain.org',
      attributes: {
        aggregator_id: aggregatorId,
        decision_made: 'approved',
      },
      enabled: true,
    });
    if (!created.ok) throw new Error('seed kc user failed');
    kcUserId = created.value.id;
    _setIdpAdmin(idp);

    writer = new SignalStackWriterFake();
    _setSignalStackWriter(writer);

    // backfillSignalstackOrgId now sources upsert domains from the live
    // network config — pin a blue_dot-shaped config so the legacy
    // ['seeker','provider'] expectations in this file still hold.
    _setNetworkConfig(buildBlueDotConfig());
  });

  afterEach(() => {
    _setUserStore(null);
    _setIdpAdmin(null);
    _setSignalStackWriter(null);
    _setAccessTokenVerifier(null);
    _setNetworkConfig(null);
  });

  it('passes through when signalstack_org_id claim already present (no upsert)', async () => {
    const req = makeReq({
      sub: kcUserId,
      aggregator_id: aggregatorId,
      decision_made: 'approved',
      signalstack_org_id: 'org_existing',
    });

    const result = await requireApproved(req);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.signalstackOrgId).toBe('org_existing');
    }
    expect(writer.listAggregators()).toHaveLength(0);
  });

  it('rejects with NOT_APPROVED when decision_made is pending (no upsert)', async () => {
    const req = makeReq({
      sub: kcUserId,
      aggregator_id: aggregatorId,
      decision_made: 'pending',
    });

    const result = await requireApproved(req);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NOT_APPROVED');
    expect(writer.listAggregators()).toHaveLength(0);
  });

  it('backfills signalstack_org_id when approved + claim missing', async () => {
    const req = makeReq({
      sub: kcUserId,
      aggregator_id: aggregatorId,
      decision_made: 'approved',
    });

    const result = await requireApproved(req);
    expect(result.ok).toBe(true);
    // 0027: the first approved request records the coordinator's IdP login.
    const identities = getIdentityStore() as IdentityStoreFake;
    expect(identities.all()).toEqual([
      { userId: aggregatorId, provider: 'keycloak', subject: kcUserId },
    ]);

    const aggregators = writer.listAggregators();
    expect(aggregators).toHaveLength(1);
    expect(aggregators[0]?.external_id).toBe(aggregatorId);
    expect(aggregators[0]?.name).toBe('TRRAIN');
    expect(aggregators[0]?.slug).toBe('trrain-abcd');

    const after = await idp.findById(kcUserId);
    expect(after.ok).toBe(true);
    if (after.ok && after.value) {
      expect(after.value.attributes?.signalstack_org_id?.[0]).toBe(aggregators[0]?.org_id);
    }

    // DB mirror is dual-written alongside the KC attribute so the worker
    // and anonymous public-link path can resolve the org id offline.
    const dbAfter = await store.findById(aggregatorId);
    if (dbAfter.ok && dbAfter.value) {
      expect(dbAfter.value.signalstackOrgId).toBe(aggregators[0]?.org_id);
    }

    if (result.ok) {
      expect(result.context.signalstackOrgId).toBe(aggregators[0]?.org_id);
    }
  });

  it('soft-fails when signalstack upsert returns an error', async () => {
    class FailingWriter extends SignalStackWriterBase {
      async onboard() {
        return err(new UpstreamError('not used', { code: 'X' }));
      }
      async upsertAggregator() {
        return err(
          new UpstreamError('signalstack down', {
            code: 'SIGNALSTACK_SERVER_ERROR',
          }),
        );
      }
      async fetchDashboard() {
        return err(new UpstreamError('not used', { code: 'X' }));
      }
      async exportDashboardCsv() {
        return err(new UpstreamError('not used', { code: 'X' }));
      }
      async fetchDecryptedProfiles() {
        return err(new UpstreamError('not used', { code: 'X' }));
      }
      async probeUser() {
        return err(new UpstreamError('not used', { code: 'X' }));
      }
    }
    _setSignalStackWriter(new FailingWriter());

    const req = makeReq({
      sub: kcUserId,
      aggregator_id: aggregatorId,
      decision_made: 'approved',
    });

    const result = await requireApproved(req);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.context.signalstackOrgId).toBeUndefined();

    const after = await idp.findById(kcUserId);
    if (after.ok && after.value) {
      expect(after.value.attributes?.signalstack_org_id).toBeUndefined();
    }
  });

  it('skips backfill cleanly when signalstack writer is disabled', async () => {
    _setSignalStackWriter(null);

    const req = makeReq({
      sub: kcUserId,
      aggregator_id: aggregatorId,
      decision_made: 'approved',
    });

    const result = await requireApproved(req);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.context.signalstackOrgId).toBeUndefined();
  });
});
