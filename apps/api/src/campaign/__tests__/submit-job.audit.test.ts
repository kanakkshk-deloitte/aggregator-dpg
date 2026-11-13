// Env must be set before any import that pulls in `config` (parsed once at
// first import). Mirrors the campaign-export.test.ts convention.
process.env.SIGNALSTACK_BASE_URL = 'http://signals.local';
process.env.SIGNALSTACK_ADMIN_KEY = 'k';
process.env.SIGNALSTACK_ACTING_ORG_ID = 'svc';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { _setAccessTokenVerifier, _resetJwks } from '../../services/auth/access-token.js';
import { UserStoreFake, buildCoordinator, _setUserStore } from '../../services/user-store/index.js';
import {
  InMemoryCampaignJobStore,
  _setCampaignJobStore,
} from '../../services/campaign-job-store/index.js';
import { _setCampaignAuditWriter } from '../../services/campaign-audit/index.js';
import { CampaignAuditWriterFake } from '@aggregator-dpg/campaign-audit/testing';

// The route only persists + enqueues; mock the queue so no real Redis is
// touched.
const { enqueueCampaignProcessMock } = vi.hoisted(() => ({
  enqueueCampaignProcessMock: vi.fn(),
}));
vi.mock('../../services/campaign-process-queue/index.js', () => ({
  enqueueCampaignProcess: enqueueCampaignProcessMock,
}));

// The rate limiter is mocked so tests never open a Redis socket.
const { consumeMock } = vi.hoisted(() => ({ consumeMock: vi.fn() }));
vi.mock('../../services/rate-limiter/index.js', () => ({
  consume: consumeMock,
}));

const VALID_UUID = '11111111-1111-1111-1111-111111111111';

describe('campaign submit — requested audit row (#617)', () => {
  let app: FastifyInstance;
  let auditFake: CampaignAuditWriterFake;

  beforeEach(async () => {
    enqueueCampaignProcessMock.mockReset().mockResolvedValue(undefined);
    consumeMock.mockReset().mockResolvedValue({ allowed: true, count: 1, retryAfterSeconds: 0 });

    _setCampaignJobStore(new InMemoryCampaignJobStore());

    const aggStore = new UserStoreFake();
    aggStore.seed([
      buildCoordinator({ id: 'agg-1', contactEmail: 'aggregator@org.example', status: 'active' }),
    ]);
    _setUserStore(aggStore);

    auditFake = new CampaignAuditWriterFake();
    _setCampaignAuditWriter(auditFake);

    _resetJwks();
    process.env.KEYCLOAK_URL = 'http://kc.local';
    process.env.KEYCLOAK_REALM = 'aggregator';
    _setAccessTokenVerifier(async (token) => {
      if (token === 'good') {
        return {
          sub: 'u1',
          aggregator_id: 'agg-1',
          signalstack_org_id: 'org_5d3b7fa4-x',
          azp: 'campaign-manager',
        };
      }
      throw new Error('invalid');
    });

    app = await buildApp();
  });

  afterEach(async () => {
    await app?.close();
    _setAccessTokenVerifier(null);
    _setUserStore(null);
    _setCampaignJobStore(null);
    _setCampaignAuditWriter(null);
  });

  function post(payload: unknown, headers: Record<string, string> = {}) {
    return app.inject({
      method: 'POST',
      url: '/v1/campaign/export',
      headers: { authorization: 'Bearer good', ...headers },
      payload: payload as object,
    });
  }

  it('writes one requested audit row with the actor and no outcome', async () => {
    const res = await post({
      item_ids: [VALID_UUID],
      metadata: [{ key: 'purpose', value: 'audit' }],
      content: {},
    });
    expect(res.statusCode).toBe(202);
    const rows = auditFake.rows.filter((r) => r.kind === 'requested');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.correlationId).toBe(res.json().job_id);
    expect(rows[0]!.actorSignalstackOrgId).toBe('org_5d3b7fa4-x');
    expect(rows[0]!.purpose).toBe('audit');
    expect(rows[0]!.piiFields).toEqual(['name', 'email', 'phone']);
    expect('outcome' in rows[0]!).toBe(false);
  });

  it('still returns 202 when the audit write fails', async () => {
    auditFake.failWith = new Error('audit down');
    const res = await post({ item_ids: [VALID_UUID], content: {} });
    // Best effort: the campaign is already committed and enqueued by this point.
    expect(res.statusCode).toBe(202);
  });

  it('does not write an audit row for a status poll', async () => {
    const created = await post({ item_ids: [VALID_UUID], content: {} });
    auditFake.reset();
    await app.inject({
      method: 'GET',
      url: `/v1/campaign/export/${created.json().job_id}`,
      headers: { authorization: 'Bearer good' },
    });
    expect(auditFake.rows).toHaveLength(0);
  });

  it('caps an oversized x-request-id header at 200 chars before it reaches the audit row (#617 cheap item)', async () => {
    const oversized = 'x'.repeat(500);
    const res = await post({ item_ids: [VALID_UUID], content: {} }, { 'x-request-id': oversized });
    expect(res.statusCode).toBe(202);
    const rows = auditFake.rows.filter((r) => r.kind === 'requested');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.traceId).toHaveLength(200);
    expect(rows[0]!.traceId).toBe(oversized.slice(0, 200));
  });

  it('writes exactly one requested row on first submit, and NONE on an identical idempotency-key replay (#617 SHOULD-FIX 3)', async () => {
    const body = { item_ids: [VALID_UUID], content: {} };
    const headers = { 'idempotency-key': 'replay-key-1' };

    const first = await post(body, headers);
    expect(first.statusCode).toBe(202);
    expect(auditFake.rows.filter((r) => r.kind === 'requested')).toHaveLength(1);

    const second = await post(body, headers);
    expect(second.statusCode).toBe(202);
    // Same job, not a second one.
    expect(second.json().job_id).toBe(first.json().job_id);
    // The replay must not add a second `requested` row for the same
    // correlation_id — that would double-count "how many people did org X
    // touch" queries.
    expect(auditFake.rows.filter((r) => r.kind === 'requested')).toHaveLength(1);
  });
});
