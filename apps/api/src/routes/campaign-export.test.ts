// Env must be set before any import that pulls in `config` (parsed once at
// first import). Mirrors the support.test.ts convention.
process.env.SIGNALSTACK_BASE_URL = 'http://signals.local';
process.env.SIGNALSTACK_ADMIN_KEY = 'k';
process.env.SIGNALSTACK_ACTING_ORG_ID = 'svc';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { _setAccessTokenVerifier, _resetJwks } from '../services/auth/access-token.js';
import { UserStoreFake, buildCoordinator, _setUserStore } from '../services/user-store/index.js';
import {
  InMemoryCampaignJobStore,
  _setCampaignJobStore,
} from '../services/campaign-job-store/index.js';

// The route only persists + enqueues; mock the queue so no real Redis is
// touched and we can assert the payload / simulate an enqueue failure.
const { enqueueCampaignProcessMock } = vi.hoisted(() => ({
  enqueueCampaignProcessMock: vi.fn(),
}));
vi.mock('../services/campaign-process-queue/index.js', () => ({
  enqueueCampaignProcess: enqueueCampaignProcessMock,
}));

// The rate limiter is mocked so tests never open a Redis socket and can force
// the "limited" branch deterministically.
const { consumeMock } = vi.hoisted(() => ({ consumeMock: vi.fn() }));
vi.mock('../services/rate-limiter/index.js', () => ({
  consume: consumeMock,
}));

const VALID_UUID = '11111111-1111-1111-1111-111111111111';

describe('POST /v1/campaign/export', () => {
  let app: FastifyInstance;
  let store: InMemoryCampaignJobStore;

  beforeEach(async () => {
    enqueueCampaignProcessMock.mockReset().mockResolvedValue(undefined);
    consumeMock.mockReset().mockResolvedValue({ allowed: true, count: 1, retryAfterSeconds: 0 });

    store = new InMemoryCampaignJobStore();
    _setCampaignJobStore(store);

    const aggStore = new UserStoreFake();
    aggStore.seed([
      buildCoordinator({ id: 'agg-1', contactEmail: 'aggregator@org.example', status: 'active' }),
    ]);
    _setUserStore(aggStore);

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
  });

  function post(payload: unknown, headers: Record<string, string> = {}) {
    return app.inject({
      method: 'POST',
      url: '/v1/campaign/export',
      headers: { authorization: 'Bearer good', ...headers },
      payload: payload as object,
    });
  }

  it('returns 202 { job_id }, persists a job with one item per id, and enqueues it', async () => {
    const res = await post({
      item_ids: [VALID_UUID],
      metadata: [{ key: 'purpose', value: 'audit' }],
    });
    expect(res.statusCode).toBe(202);
    const { job_id } = res.json();
    expect(job_id).toMatch(/^[0-9a-f-]{36}$/);

    const view = await store.getJob(job_id, 'org_5d3b7fa4-x');
    expect(view.ok && view.value?.counts.total).toBe(1);
    expect(view.ok && view.value?.metadata).toEqual([{ key: 'purpose', value: 'audit' }]);

    expect(enqueueCampaignProcessMock).toHaveBeenCalledTimes(1);
    expect(enqueueCampaignProcessMock.mock.calls[0]![0]).toEqual({ jobId: job_id });
  });

  it('stores the requesting token email as the job recipient over the DB contact_email', async () => {
    _setAccessTokenVerifier(async (token) => {
      if (token === 'good') {
        return {
          sub: 'u1',
          aggregator_id: 'agg-1',
          signalstack_org_id: 'org_5d3b7fa4-x',
          azp: 'campaign-manager',
          email: 'user@sanketika.in',
        };
      }
      throw new Error('invalid');
    });
    const res = await post({ item_ids: [VALID_UUID] });
    expect(res.statusCode).toBe(202);
    const proc = await store.getJobForProcessing(res.json().job_id);
    expect(proc.ok && proc.value?.requestedBy).toBe('user@sanketika.in');
  });

  it('is idempotent on the Idempotency-Key header (same job_id, enqueues once)', async () => {
    const body = { item_ids: [VALID_UUID] };
    const first = await post(body, { 'idempotency-key': 'key-123' });
    const second = await post(body, { 'idempotency-key': 'key-123' });
    expect(first.json().job_id).toBe(second.json().job_id);
    // A replay never creates a second job. It does re-prime the queue for a
    // job still `queued` (the first enqueue may have been lost), which BullMQ
    // collapses because the campaign_job id is used as the BullMQ jobId.
    const enqueuedIds = enqueueCampaignProcessMock.mock.calls.map(
      (c) => (c[0] as { jobId: string }).jobId,
    );
    expect(new Set(enqueuedIds)).toEqual(new Set([first.json().job_id]));
  });

  it('returns 400 CAMPAIGN_TOO_MANY_ITEMS when the item count exceeds the cap', async () => {
    // Distinct uuids so de-dup doesn't collapse them below the cap.
    const distinct = Array.from(
      { length: 501 },
      (_, i) => `11111111-1111-1111-1111-${String(i).padStart(12, '0')}`,
    );
    const res = await post({ item_ids: distinct });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('CAMPAIGN_TOO_MANY_ITEMS');
    expect(enqueueCampaignProcessMock).not.toHaveBeenCalled();
  });

  it('returns 429 CAMPAIGN_RATE_LIMITED when the ingress limiter trips', async () => {
    consumeMock.mockResolvedValueOnce({ allowed: false, count: 99, retryAfterSeconds: 42 });
    const res = await post({ item_ids: [VALID_UUID] });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('CAMPAIGN_RATE_LIMITED');
    expect(res.headers['retry-after']).toBe('42');
    expect(enqueueCampaignProcessMock).not.toHaveBeenCalled();
  });

  it('returns 429 CAMPAIGN_ACTIVE_LIMIT when the org already has the max active jobs', async () => {
    // Seed the per-org active-job cap (default 3) so the request is the 4th.
    for (let i = 0; i < 3; i++) {
      await store.createJob({
        aggregatorId: 'agg-1',
        signalstackOrgId: 'org_5d3b7fa4-x',
        channel: 'export',
        metadata: [],
        content: {},
        requestedBy: 'x@x',
        items: [{ itemId: `seed-${i}`, action: null }],
      });
    }
    const res = await post({ item_ids: [VALID_UUID] });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('CAMPAIGN_ACTIVE_LIMIT');
    expect(enqueueCampaignProcessMock).not.toHaveBeenCalled();
  });

  it('returns 401 when the token azp is not an allowed campaign client', async () => {
    _setAccessTokenVerifier(async (token) => {
      if (token === 'good') {
        return {
          sub: 'u1',
          aggregator_id: 'agg-1',
          signalstack_org_id: 'org_5d3b7fa4-x',
          azp: 'aggregator-portal',
        };
      }
      throw new Error('invalid');
    });
    const res = await post({ item_ids: [VALID_UUID] });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
    expect(enqueueCampaignProcessMock).not.toHaveBeenCalled();
  });

  it('returns 403 AGGREGATOR_INACTIVE when the requesting aggregator is not active', async () => {
    const aggStore = new UserStoreFake();
    aggStore.seed([
      buildCoordinator({ id: 'agg-1', contactEmail: 'aggregator@org.example', status: 'inactive' }),
    ]);
    _setUserStore(aggStore);
    const res = await post({ item_ids: [VALID_UUID] });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.fields.reason).toBe('AGGREGATOR_INACTIVE');
    expect(enqueueCampaignProcessMock).not.toHaveBeenCalled();
  });

  it('returns 403 RECIPIENT_UNRESOLVED when neither token nor aggregator has an email', async () => {
    const aggStore = new UserStoreFake();
    aggStore.seed([buildCoordinator({ id: 'agg-1', contactEmail: '', status: 'active' })]);
    _setUserStore(aggStore);
    const res = await post({ item_ids: [VALID_UUID] });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.fields.reason).toBe('RECIPIENT_UNRESOLVED');
  });

  it('returns 401 when no Authorization header is sent', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/campaign/export',
      payload: { item_ids: [VALID_UUID] },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 when the token has no signalstack_org_id claim', async () => {
    _setAccessTokenVerifier(async (token) => {
      if (token === 'good') return { sub: 'u1', aggregator_id: 'agg-1', azp: 'campaign-manager' };
      throw new Error('invalid');
    });
    const res = await post({ item_ids: [VALID_UUID] });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.fields.reason).toBe('MISSING_SIGNALSTACK_ORG');
  });

  it('returns 400 for a non-uuid item id', async () => {
    const res = await post({ item_ids: ['not-a-uuid'] });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for an empty item_ids array', async () => {
    const res = await post({ item_ids: [] });
    expect(res.statusCode).toBe(400);
  });

  it('returns 503 EXPORT_ENQUEUE_FAILED when the job cannot be queued', async () => {
    enqueueCampaignProcessMock.mockRejectedValueOnce(new Error('redis unavailable'));
    const res = await post({ item_ids: [VALID_UUID] });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('EXPORT_ENQUEUE_FAILED');
  });

  it('does not strand the job row when the enqueue fails', async () => {
    enqueueCampaignProcessMock.mockRejectedValueOnce(new Error('redis unavailable'));
    await post({ item_ids: [VALID_UUID] });

    // The row was committed before the enqueue was attempted. Leaving it
    // `queued` would be a lie no worker will ever correct — and it would keep
    // consuming the org's active-job slot, so a run of Redis blips would wedge
    // the org out of exporting entirely.
    const list = await store.listJobs('org_5d3b7fa4-x', { channel: 'export', limit: 10 });
    const jobs = list.ok ? list.value.jobs : [];
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.status).toBe('failed');

    const active = await store.countActiveJobs('org_5d3b7fa4-x', 'export');
    expect(active.ok && active.value).toBe(0);
  });

  it('rejects a token without aggregator_id', async () => {
    _setAccessTokenVerifier(async (token) => {
      if (token === 'good') {
        return {
          sub: 'other-uuid',
          azp: 'campaign-manager',
          preferred_username: 'someone@org.example',
        };
      }
      throw new Error('invalid');
    });
    const res = await post({ item_ids: [VALID_UUID] });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.fields.reason).toBe('MISSING_AGGREGATOR_ID');
  });

  it('re-enqueues an idempotency replay whose job is still queued', async () => {
    const headers = { 'Idempotency-Key': 'replay-key-1' };
    const first = await post({ item_ids: [VALID_UUID] }, headers);
    expect(first.statusCode).toBe(202);
    enqueueCampaignProcessMock.mockClear();

    const second = await post({ item_ids: [VALID_UUID] }, headers);
    expect(second.statusCode).toBe(202);
    expect(second.json().job_id).toBe(first.json().job_id);
    // Same job id, but the queue is re-primed: a replay of a still-`queued`
    // job means the original enqueue may never have landed, and answering 202
    // again without re-queuing would promise an export that never runs.
    expect(enqueueCampaignProcessMock).toHaveBeenCalledTimes(1);
  });
});
