// Env must be set before any import that pulls in `config` (parsed once at
// first import). Mirrors the campaign-export.test.ts convention.
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
  type CreateJobInput,
} from '../services/campaign-job-store/index.js';

/**
 * A campaign job store that can be told to fail specific operations, so tests
 * can exercise the route's `!result.ok` branches without a real DB. Extends
 * the in-memory fake (per testing.md — extend, don't reinvent) and delegates
 * everything except the toggled method.
 */
class FailingCampaignJobStore extends InMemoryCampaignJobStore {
  failCountActiveJobs = false;
  failCreateJob = false;
  failSetJobStatus = false;

  override async countActiveJobs(
    ...args: Parameters<InMemoryCampaignJobStore['countActiveJobs']>
  ): ReturnType<InMemoryCampaignJobStore['countActiveJobs']> {
    if (this.failCountActiveJobs) {
      return { ok: false, error: { code: 'DB_UNAVAILABLE', message: 'db down' } };
    }
    return super.countActiveJobs(...args);
  }

  override async createJob(
    input: CreateJobInput,
  ): ReturnType<InMemoryCampaignJobStore['createJob']> {
    if (this.failCreateJob) {
      return { ok: false, error: { code: 'DB_UNAVAILABLE', message: 'db down' } };
    }
    return super.createJob(input);
  }

  override async setJobStatus(
    ...args: Parameters<InMemoryCampaignJobStore['setJobStatus']>
  ): ReturnType<InMemoryCampaignJobStore['setJobStatus']> {
    if (this.failSetJobStatus) {
      return { ok: false, error: { code: 'DB_UNAVAILABLE', message: 'db down' } };
    }
    return super.setJobStatus(...args);
  }
}

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

describe('POST /v1/campaign/voice', () => {
  let app: FastifyInstance;
  let store: FailingCampaignJobStore;

  beforeEach(async () => {
    enqueueCampaignProcessMock.mockReset().mockResolvedValue(undefined);
    consumeMock.mockReset().mockResolvedValue({ allowed: true, count: 1, retryAfterSeconds: 0 });

    store = new FailingCampaignJobStore();
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
      url: '/v1/campaign/voice',
      headers: { authorization: 'Bearer good', ...headers },
      payload: payload as object,
    });
  }

  it('returns 202 { status, requested, job_id }, persists a voice job with action voice_call per item, and enqueues it', async () => {
    const res = await post({
      item_ids: [VALID_UUID],
      content: { agent_id: 'agent-123' },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.status).toBe('queued');
    expect(body.requested).toBe(1);
    expect(body.job_id).toMatch(/^[0-9a-f-]{36}$/);

    const proc = await store.getJobForProcessing(body.job_id);
    expect(proc.ok && proc.value?.channel).toBe('voice');
    expect(proc.ok && proc.value?.content).toEqual({ agent_id: 'agent-123', action: 'dispatch' });
    expect(proc.ok && proc.value?.items).toEqual([
      expect.objectContaining({ itemId: VALID_UUID, action: 'voice_call' }),
    ]);

    expect(enqueueCampaignProcessMock).toHaveBeenCalledTimes(1);
    expect(enqueueCampaignProcessMock.mock.calls[0]![0]).toEqual({ jobId: body.job_id });
  });

  it('returns 400 when content.agent_id is missing', async () => {
    const res = await post({ item_ids: [VALID_UUID], content: {} });
    expect(res.statusCode).toBe(400);
    expect(enqueueCampaignProcessMock).not.toHaveBeenCalled();
  });

  it('returns 400 when content.action is not dispatch (v1 unsupported)', async () => {
    const res = await post({
      item_ids: [VALID_UUID],
      content: { agent_id: 'agent-123', action: 'stop' },
    });
    expect(res.statusCode).toBe(400);
    expect(enqueueCampaignProcessMock).not.toHaveBeenCalled();
  });

  it('returns 400 CAMPAIGN_VOICE_TOO_MANY_ITEMS when the item count exceeds the cap', async () => {
    // Distinct uuids so de-dup doesn't collapse them below the cap.
    const distinct = Array.from(
      { length: 501 },
      (_, i) => `11111111-1111-1111-1111-${String(i).padStart(12, '0')}`,
    );
    const res = await post({ item_ids: distinct, content: { agent_id: 'agent-123' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('CAMPAIGN_VOICE_TOO_MANY_ITEMS');
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
    const res = await post({ item_ids: [VALID_UUID], content: { agent_id: 'agent-123' } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
    expect(enqueueCampaignProcessMock).not.toHaveBeenCalled();
  });

  it('returns 403 when the token has no signalstack_org_id claim', async () => {
    _setAccessTokenVerifier(async (token) => {
      if (token === 'good') return { sub: 'u1', aggregator_id: 'agg-1', azp: 'campaign-manager' };
      throw new Error('invalid');
    });
    const res = await post({ item_ids: [VALID_UUID], content: { agent_id: 'agent-123' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.fields.reason).toBe('MISSING_SIGNALSTACK_ORG');
  });

  it('returns 429 CAMPAIGN_RATE_LIMITED when the ingress limiter trips', async () => {
    consumeMock.mockResolvedValueOnce({ allowed: false, count: 99, retryAfterSeconds: 42 });
    const res = await post({ item_ids: [VALID_UUID], content: { agent_id: 'agent-123' } });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('CAMPAIGN_RATE_LIMITED');
    expect(res.headers['retry-after']).toBe('42');
    expect(enqueueCampaignProcessMock).not.toHaveBeenCalled();
    expect(consumeMock.mock.calls[0]![0]).toMatchObject({ namespace: 'campaign-submit-voice' });
  });

  it('returns 429 CAMPAIGN_ACTIVE_LIMIT when the org already has the max active voice jobs', async () => {
    // Seed the per-org active-job cap (default 3) so the request is the 4th.
    for (let i = 0; i < 3; i++) {
      await store.createJob({
        aggregatorId: 'agg-1',
        signalstackOrgId: 'org_5d3b7fa4-x',
        channel: 'voice',
        metadata: [],
        content: {},
        requestedBy: 'x@x',
        items: [{ itemId: `seed-${i}`, action: 'voice_call' }],
      });
    }
    const res = await post({ item_ids: [VALID_UUID], content: { agent_id: 'agent-123' } });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('CAMPAIGN_ACTIVE_LIMIT');
    expect(enqueueCampaignProcessMock).not.toHaveBeenCalled();
  });

  it('returns 503 VOICE_ENQUEUE_FAILED when the job cannot be queued', async () => {
    enqueueCampaignProcessMock.mockRejectedValueOnce(new Error('redis unavailable'));
    const res = await post({ item_ids: [VALID_UUID], content: { agent_id: 'agent-123' } });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('VOICE_ENQUEUE_FAILED');
  });

  it('returns 503 VOICE_ENQUEUE_FAILED with a generic detail when the rejection is not an Error', async () => {
    // cause instanceof Error ? cause.message : 'failed to enqueue voice job'
    enqueueCampaignProcessMock.mockRejectedValueOnce('redis socket hang up');
    const res = await post({ item_ids: [VALID_UUID], content: { agent_id: 'agent-123' } });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.detail).toBe('failed to enqueue voice job');
  });

  it('still returns 503 VOICE_ENQUEUE_FAILED (with the enqueue failure, not a masking one) when marking the job failed also fails', async () => {
    enqueueCampaignProcessMock.mockRejectedValueOnce(new Error('redis unavailable'));
    store.failSetJobStatus = true;
    const res = await post({ item_ids: [VALID_UUID], content: { agent_id: 'agent-123' } });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('VOICE_ENQUEUE_FAILED');
    expect(res.json().error.detail).toBe('redis unavailable');
  });

  it('returns 403 FORBIDDEN AGGREGATOR_INACTIVE when the requesting aggregator is not active', async () => {
    const aggStore = new UserStoreFake();
    aggStore.seed([
      buildCoordinator({ id: 'agg-1', contactEmail: 'aggregator@org.example', status: 'pending' }),
    ]);
    _setUserStore(aggStore);

    const res = await post({ item_ids: [VALID_UUID], content: { agent_id: 'agent-123' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.fields.reason).toBe('AGGREGATOR_INACTIVE');
    expect(enqueueCampaignProcessMock).not.toHaveBeenCalled();
  });

  it('returns 403 FORBIDDEN RECIPIENT_UNRESOLVED when the token has no email and the aggregator has no contact_email', async () => {
    const aggStore = new UserStoreFake();
    aggStore.seed([buildCoordinator({ id: 'agg-1', contactEmail: '', status: 'active' })]);
    _setUserStore(aggStore);
    // The default 'good' verifier already omits an `email` claim.

    const res = await post({ item_ids: [VALID_UUID], content: { agent_id: 'agent-123' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.fields.reason).toBe('RECIPIENT_UNRESOLVED');
    expect(enqueueCampaignProcessMock).not.toHaveBeenCalled();
  });

  it('returns 500 INTERNAL when the active-job count cannot be read', async () => {
    store.failCountActiveJobs = true;
    const res = await post({ item_ids: [VALID_UUID], content: { agent_id: 'agent-123' } });
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe('INTERNAL');
    expect(enqueueCampaignProcessMock).not.toHaveBeenCalled();
  });

  it('returns 500 INTERNAL when the job row cannot be created', async () => {
    store.failCreateJob = true;
    const res = await post({ item_ids: [VALID_UUID], content: { agent_id: 'agent-123' } });
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe('INTERNAL');
    expect(enqueueCampaignProcessMock).not.toHaveBeenCalled();
  });

  it('honours an Idempotency-Key header: a replay while the job is still queued re-enqueues it', async () => {
    const res1 = await post(
      { item_ids: [VALID_UUID], content: { agent_id: 'agent-123' } },
      { 'idempotency-key': 'replay-key-1' },
    );
    expect(res1.statusCode).toBe(202);
    const jobId = res1.json().job_id;

    // The first enqueue never actually landed (simulated below by resetting
    // the mock) — a replay of the same key must find the job still `queued`
    // and enqueue again, not silently accept it as already-handled.
    enqueueCampaignProcessMock.mockClear();
    const res2 = await post(
      { item_ids: [VALID_UUID], content: { agent_id: 'agent-123' } },
      { 'idempotency-key': 'replay-key-1' },
    );
    expect(res2.statusCode).toBe(202);
    expect(res2.json().job_id).toBe(jobId);
    expect(enqueueCampaignProcessMock).toHaveBeenCalledTimes(1);
    expect(enqueueCampaignProcessMock.mock.calls[0]![0]).toEqual({ jobId });
  });

  it('honours an Idempotency-Key header: a replay of an already-processing job does not re-enqueue', async () => {
    const res1 = await post(
      { item_ids: [VALID_UUID], content: { agent_id: 'agent-123' } },
      { 'idempotency-key': 'replay-key-2' },
    );
    const jobId = res1.json().job_id;
    // Simulate the worker having already picked the job up.
    await store.setJobStatus(jobId, 'processing');

    enqueueCampaignProcessMock.mockClear();
    const res2 = await post(
      { item_ids: [VALID_UUID], content: { agent_id: 'agent-123' } },
      { 'idempotency-key': 'replay-key-2' },
    );
    expect(res2.statusCode).toBe(202);
    expect(res2.json().job_id).toBe(jobId);
    expect(enqueueCampaignProcessMock).not.toHaveBeenCalled();
  });

  it('treats a whitespace-only Idempotency-Key header as absent (no idempotency applied)', async () => {
    const res1 = await post(
      { item_ids: [VALID_UUID], content: { agent_id: 'agent-123' } },
      { 'idempotency-key': '   ' },
    );
    const res2 = await post(
      { item_ids: [VALID_UUID], content: { agent_id: 'agent-123' } },
      { 'idempotency-key': '   ' },
    );
    expect(res1.statusCode).toBe(202);
    expect(res2.statusCode).toBe(202);
    // Two distinct jobs, not a dedup replay — the blank key was never applied.
    expect(res1.json().job_id).not.toBe(res2.json().job_id);
    expect(enqueueCampaignProcessMock).toHaveBeenCalledTimes(2);
  });
});
