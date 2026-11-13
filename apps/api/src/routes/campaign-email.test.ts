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
} from '../services/campaign-job-store/index.js';
import { _setCampaignAuditWriter } from '../services/campaign-audit/index.js';
import { CampaignAuditWriterFake } from '@aggregator-dpg/campaign-audit/testing';

// The route only validates + persists + enqueues; mock the queue so no real
// Redis is touched and we can assert the payload / force an enqueue failure.
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
const ORG = 'org_5d3b7fa4-x';
const CONTENT = { subject: 'Hello {{first_name}}', body_markdown: 'Hi **{{name}}**, an update.' };

describe('POST /v1/campaign/email', () => {
  let app: FastifyInstance;
  let store: InMemoryCampaignJobStore;
  let auditFake: CampaignAuditWriterFake;

  beforeEach(async () => {
    enqueueCampaignProcessMock.mockReset().mockResolvedValue(undefined);
    consumeMock.mockReset().mockResolvedValue({ allowed: true, count: 1, retryAfterSeconds: 0 });

    store = new InMemoryCampaignJobStore();
    _setCampaignJobStore(store);

    auditFake = new CampaignAuditWriterFake();
    _setCampaignAuditWriter(auditFake);

    // The shared submit flow resolves `requested_by` from the aggregator (and
    // requires it to be active), so it has to exist for any 2xx path.
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
          signalstack_org_id: ORG,
          azp: 'campaign-manager',
          email: 'user@sanketika.in',
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
      url: '/v1/campaign/email',
      headers: { authorization: 'Bearer good', ...headers },
      payload: payload as object,
    });
  }

  it('returns 202 { job_id }, persists an email job with one item per id, and enqueues it', async () => {
    const res = await post({
      item_ids: [VALID_UUID],
      metadata: [{ key: 'purpose', value: 'Q3 follow-up' }],
      content: CONTENT,
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ status: 'queued', requested: 1 });
    const { job_id: jobId } = res.json();
    expect(jobId).toMatch(/^[0-9a-f-]{36}$/);

    const view = await store.getJob(jobId, ORG);
    expect(view.ok && view.value?.channel).toBe('email');
    expect(view.ok && view.value?.counts.total).toBe(1);
    expect(view.ok && view.value?.metadata).toEqual([{ key: 'purpose', value: 'Q3 follow-up' }]);
    // The template travels on the job row, not the queue payload.
    expect(view.ok && view.value?.content).toEqual(CONTENT);

    expect(enqueueCampaignProcessMock).toHaveBeenCalledTimes(1);
    expect(enqueueCampaignProcessMock.mock.calls[0]![0]).toEqual({ jobId });
    // Retries stay ON for email (attempts: 3) — the worker's per-item terminal
    // guard is what prevents a duplicate send, not attempts: 1.
    expect(enqueueCampaignProcessMock.mock.calls[0]![1]).toEqual({ attempts: 3 });
  });

  it('de-duplicates repeated item ids into one recipient row', async () => {
    const res = await post({ item_ids: [VALID_UUID, VALID_UUID], content: CONTENT });
    expect(res.statusCode).toBe(202);
    expect(res.json().requested).toBe(1);
    const items = await store.getJobItems(res.json().job_id, ORG);
    expect(items.ok && items.value).toHaveLength(1);
  });

  it('leaves every item out of the active-dedup predicate (action null — dedup is voice-only)', async () => {
    const res = await post({ item_ids: [VALID_UUID], content: CONTENT });
    const items = await store.getJobItems(res.json().job_id, ORG);
    expect(items.ok && items.value?.[0]?.action).toBeNull();
  });

  it('is idempotent on the Idempotency-Key header (same job_id, one job)', async () => {
    const body = { item_ids: [VALID_UUID], content: CONTENT };
    const first = await post(body, { 'idempotency-key': 'key-123' });
    const second = await post(body, { 'idempotency-key': 'key-123' });
    expect(first.json().job_id).toBe(second.json().job_id);
    // A replay never creates a second job. It does re-prime the queue for a job
    // still `queued` (the first enqueue may have been lost), which BullMQ
    // collapses because the campaign_job id is the BullMQ jobId — and even a
    // genuine double-run re-emails nobody already marked `sent`.
    const enqueuedIds = enqueueCampaignProcessMock.mock.calls.map(
      (c) => (c[0] as { jobId: string }).jobId,
    );
    expect(new Set(enqueuedIds)).toEqual(new Set([first.json().job_id]));
  });

  it('marks the job failed when the enqueue throws, so it cannot wedge the active cap', async () => {
    enqueueCampaignProcessMock.mockRejectedValueOnce(new Error('redis unavailable'));
    const res = await post({ item_ids: [VALID_UUID], content: CONTENT });
    expect(res.statusCode).toBe(503);

    // `queued` counts against CAMPAIGN_EMAIL_MAX_ACTIVE_PER_ORG and the watchdog
    // only reaps `processing`, so an un-enqueued row left `queued` would let
    // repeated Redis blips permanently consume the org's cap.
    const jobs = await store.listJobs(ORG, { channel: 'email' });
    expect(jobs.ok && jobs.value.jobs[0]?.status).toBe('failed');
    expect(jobs.ok && jobs.value.jobs[0]?.errorReason).toBe('enqueue_failed');
  });

  it('returns 403 AGGREGATOR_INACTIVE when the requesting aggregator is not active', async () => {
    // Inherited from the shared submit flow: all three channels refuse to
    // create work for an aggregator that is no longer active.
    const aggStore = new UserStoreFake();
    aggStore.seed([
      buildCoordinator({ id: 'agg-1', contactEmail: 'aggregator@org.example', status: 'inactive' }),
    ]);
    _setUserStore(aggStore);
    const res = await post({ item_ids: [VALID_UUID], content: CONTENT });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.fields.reason).toBe('AGGREGATOR_INACTIVE');
    expect(enqueueCampaignProcessMock).not.toHaveBeenCalled();
  });

  it('records the requester email as requested_by (audit trail, never a destination)', async () => {
    const res = await post({ item_ids: [VALID_UUID], content: CONTENT });
    expect(res.statusCode).toBe(202);
    const proc = await store.getJobForProcessing(res.json().job_id);
    expect(proc.ok && proc.value?.requestedBy).toBe('user@sanketika.in');
  });

  it('audits `email` on the requested row even for a plain announcement with no placeholders (#617)', async () => {
    // This is the case that used to record `pii_fields = {}` — reading as
    // "nothing released" while every recipient's address went to the mail
    // provider.
    const res = await post({
      item_ids: [VALID_UUID],
      content: { subject: 'Program update', body_markdown: 'No placeholders here.' },
    });
    expect(res.statusCode).toBe(202);
    const rows = auditFake.rows.filter((r) => r.kind === 'requested');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.piiFields).toEqual(['email']);
  });

  it('audits both `email` and `name` when the template uses a name placeholder', async () => {
    const res = await post({
      item_ids: [VALID_UUID],
      content: { subject: 'Hi {{first_name}}', body_markdown: 'Hello there.' },
    });
    expect(res.statusCode).toBe(202);
    const rows = auditFake.rows.filter((r) => r.kind === 'requested');
    expect(rows).toHaveLength(1);
    expect(new Set(rows[0]!.piiFields)).toEqual(new Set(['email', 'name']));
  });

  it('returns 400 UNKNOWN_PLACEHOLDER for a token outside the supported set', async () => {
    const res = await post({
      item_ids: [VALID_UUID],
      content: { subject: 'Hi {{city}}', body_markdown: 'Body {{name}}' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('UNKNOWN_PLACEHOLDER');
    expect(res.json().error.fields.unknown).toEqual(['city']);
    expect(enqueueCampaignProcessMock).not.toHaveBeenCalled();
  });

  it('returns 400 CAMPAIGN_TOO_MANY_ITEMS when the recipient count exceeds the cap', async () => {
    // Distinct uuids so de-dup doesn't collapse them below the 200 cap.
    const distinct = Array.from(
      { length: 201 },
      (_, i) => `11111111-1111-1111-1111-${String(i).padStart(12, '0')}`,
    );
    const res = await post({ item_ids: distinct, content: CONTENT });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('CAMPAIGN_TOO_MANY_ITEMS');
    expect(res.json().error.fields.max).toBe(200);
    expect(enqueueCampaignProcessMock).not.toHaveBeenCalled();
  });

  it('returns 429 CAMPAIGN_RATE_LIMITED when the ingress limiter trips', async () => {
    consumeMock.mockResolvedValueOnce({ allowed: false, count: 99, retryAfterSeconds: 42 });
    const res = await post({ item_ids: [VALID_UUID], content: CONTENT });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('CAMPAIGN_RATE_LIMITED');
    expect(res.headers['retry-after']).toBe('42');
    expect(enqueueCampaignProcessMock).not.toHaveBeenCalled();
  });

  it('rate-limits in its own bucket, not the export channel’s', async () => {
    await post({ item_ids: [VALID_UUID], content: CONTENT });
    expect(consumeMock.mock.calls[0]![0]).toMatchObject({
      namespace: 'campaign-submit-email',
      key: ORG,
    });
  });

  it('returns 429 CAMPAIGN_ACTIVE_LIMIT when the org already has the max active email jobs', async () => {
    for (let i = 0; i < 3; i++) {
      await store.createJob({
        aggregatorId: 'agg-1',
        signalstackOrgId: ORG,
        channel: 'email',
        metadata: [],
        content: CONTENT,
        requestedBy: 'x@x',
        items: [{ itemId: `seed-${i}`, action: null }],
      });
    }
    const res = await post({ item_ids: [VALID_UUID], content: CONTENT });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('CAMPAIGN_ACTIVE_LIMIT');
    expect(enqueueCampaignProcessMock).not.toHaveBeenCalled();
  });

  it('does not count another channel’s active jobs against the email cap', async () => {
    for (let i = 0; i < 3; i++) {
      await store.createJob({
        aggregatorId: 'agg-1',
        signalstackOrgId: ORG,
        channel: 'export',
        metadata: [],
        content: {},
        requestedBy: 'x@x',
        items: [{ itemId: `seed-${i}`, action: null }],
      });
    }
    const res = await post({ item_ids: [VALID_UUID], content: CONTENT });
    expect(res.statusCode).toBe(202);
  });

  it('returns 401 when the token azp is not an allowed campaign client', async () => {
    _setAccessTokenVerifier(async (token) => {
      if (token === 'good') {
        return {
          sub: 'u1',
          aggregator_id: 'agg-1',
          signalstack_org_id: ORG,
          azp: 'aggregator-portal',
        };
      }
      throw new Error('invalid');
    });
    const res = await post({ item_ids: [VALID_UUID], content: CONTENT });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
    expect(enqueueCampaignProcessMock).not.toHaveBeenCalled();
  });

  it('returns 401 when no Authorization header is sent', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/campaign/email',
      payload: { item_ids: [VALID_UUID], content: CONTENT },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 when the token has no signalstack_org_id claim', async () => {
    _setAccessTokenVerifier(async (token) => {
      if (token === 'good') return { sub: 'u1', aggregator_id: 'agg-1', azp: 'campaign-manager' };
      throw new Error('invalid');
    });
    const res = await post({ item_ids: [VALID_UUID], content: CONTENT });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.fields.reason).toBe('MISSING_SIGNALSTACK_ORG');
  });

  it.each([
    ['a missing content block', { item_ids: [VALID_UUID] }],
    ['a missing subject', { item_ids: [VALID_UUID], content: { body_markdown: 'b' } }],
    ['a missing body', { item_ids: [VALID_UUID], content: { subject: 's' } }],
    [
      'an empty subject',
      { item_ids: [VALID_UUID], content: { subject: '  ', body_markdown: 'b' } },
    ],
    [
      'an unknown content key',
      { item_ids: [VALID_UUID], content: { ...CONTENT, cc: 'x@y.example' } },
    ],
    [
      'a top-level key outside the envelope',
      { item_ids: [VALID_UUID], content: CONTENT, purpose: 'audit' },
    ],
    ['a non-email reply_to', { item_ids: [VALID_UUID], content: { ...CONTENT, reply_to: 'nope' } }],
    ['a non-uuid item id', { item_ids: ['not-a-uuid'], content: CONTENT }],
    ['an empty item_ids array', { item_ids: [], content: CONTENT }],
    [
      'an over-long subject',
      { item_ids: [VALID_UUID], content: { subject: 'x'.repeat(201), body_markdown: 'b' } },
    ],
    [
      'an over-long body',
      { item_ids: [VALID_UUID], content: { subject: 's', body_markdown: 'x'.repeat(20001) } },
    ],
  ])('returns 400 for %s', async (_label, payload) => {
    const res = await post(payload);
    expect(res.statusCode).toBe(400);
    expect(enqueueCampaignProcessMock).not.toHaveBeenCalled();
  });

  it('accepts a valid reply_to and stores it on the job content', async () => {
    const res = await post({
      item_ids: [VALID_UUID],
      content: { ...CONTENT, reply_to: 'campaign@org.example' },
    });
    expect(res.statusCode).toBe(202);
    const view = await store.getJob(res.json().job_id, ORG);
    expect(view.ok && view.value?.content).toMatchObject({ reply_to: 'campaign@org.example' });
  });

  it('returns 503 EMAIL_ENQUEUE_FAILED when the job cannot be queued', async () => {
    enqueueCampaignProcessMock.mockRejectedValueOnce(new Error('redis unavailable'));
    const res = await post({ item_ids: [VALID_UUID], content: CONTENT });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('EMAIL_ENQUEUE_FAILED');
  });
});

describe('GET /v1/campaign/email/{job_id}', () => {
  let app: FastifyInstance;
  let store: InMemoryCampaignJobStore;

  beforeEach(async () => {
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
          signalstack_org_id: ORG,
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

  async function seedJob(channel: 'email' | 'export') {
    const created = await store.createJob({
      aggregatorId: 'agg-1',
      signalstackOrgId: ORG,
      channel,
      metadata: [],
      content: channel === 'email' ? CONTENT : {},
      requestedBy: 'user@sanketika.in',
      items: [{ itemId: VALID_UUID, action: null }],
    });
    if (!created.ok) throw new Error('seed failed');
    return created.value.job.id;
  }

  it('returns the per-recipient outcomes for an email job', async () => {
    const jobId = await seedJob('email');
    await store.markItem(jobId, VALID_UUID, 'sent', undefined, 'smtp-message-1');
    // The worker rolls the job up from its item counts once the send completes.
    await store.rollUpStatus(jobId);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/campaign/email/${jobId}`,
      headers: { authorization: 'Bearer good' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      channel: 'email',
      status: 'completed',
      items: [{ item_id: VALID_UUID, status: 'sent', provider_ref: 'smtp-message-1' }],
    });
    expect(res.json().counts.sent).toBe(1);
  });

  it('never serves another channel’s job on the email path', async () => {
    const jobId = await seedJob('export');
    const res = await app.inject({
      method: 'GET',
      url: `/v1/campaign/email/${jobId}`,
      headers: { authorization: 'Bearer good' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('lists only the org’s email jobs', async () => {
    const emailJob = await seedJob('email');
    await seedJob('export');
    const res = await app.inject({
      method: 'GET',
      url: '/v1/campaign/email',
      headers: { authorization: 'Bearer good' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().jobs.map((j: { job_id: string }) => j.job_id)).toEqual([emailJob]);
  });
});
