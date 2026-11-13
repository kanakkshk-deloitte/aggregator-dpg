// Env must be set before any import that pulls in `config`.
process.env.SIGNALSTACK_BASE_URL = 'http://signals.local';
process.env.SIGNALSTACK_ADMIN_KEY = 'k';
process.env.SIGNALSTACK_ACTING_ORG_ID = 'svc';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { _setAccessTokenVerifier, _resetJwks } from '../services/auth/access-token.js';
import {
  InMemoryCampaignJobStore,
  _setCampaignJobStore,
} from '../services/campaign-job-store/index.js';

const ORG = 'org_5d3b7fa4-x';

async function seedJob(
  store: InMemoryCampaignJobStore,
  org: string,
  itemIds: string[],
  channel: 'export' | 'email' | 'voice' = 'export',
) {
  const created = await store.createJob({
    aggregatorId: 'agg-1',
    signalstackOrgId: org,
    channel,
    metadata: [{ key: 'purpose', value: 'audit' }],
    content: {},
    requestedBy: 'user@org.example',
    items: itemIds.map((id) => ({ itemId: id, action: null })),
  });
  if (!created.ok) throw new Error('seed failed');
  return created.value.job.id;
}

describe('campaign job status endpoints', () => {
  let app: FastifyInstance;
  let store: InMemoryCampaignJobStore;

  beforeEach(async () => {
    store = new InMemoryCampaignJobStore();
    _setCampaignJobStore(store);

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
      if (token === 'other-org') {
        return {
          sub: 'u2',
          aggregator_id: 'agg-2',
          signalstack_org_id: 'org-other',
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
    _setCampaignJobStore(null);
  });

  const auth = { authorization: 'Bearer good' };

  it('GET /:job_id returns the job status and per-item outcomes', async () => {
    const jobId = await seedJob(store, ORG, ['a', 'b']);
    await store.markItem(jobId, 'a', 'resolved');
    await store.markItem(jobId, 'b', 'failed', 'not owned');
    await store.rollUpStatus(jobId);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/campaign/export/${jobId}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.job_id).toBe(jobId);
    expect(body.status).toBe('partial');
    expect(body.counts).toEqual({
      total: 2,
      pending: 0,
      resolved: 1,
      submitted: 0,
      sent: 0,
      skipped_not_owned: 0,
      skipped_no_contact: 0,
      duplicate_active: 0,
      failed: 1,
    });
    const failed = body.items.find((i: { item_id: string }) => i.item_id === 'b');
    expect(failed.status).toBe('failed');
    expect(failed.error_reason).toBe('not owned');
  });

  it('GET /:job_id (voice) returns provider_batch_ref per item and provider_response on the job', async () => {
    const jobId = await seedJob(store, ORG, ['a'], 'voice');
    await store.markSubmitted(jobId, 'a', { providerBatchRef: 'batch-1', providerRef: 'call-1' });
    await store.setProviderResponse(jobId, { batch_id: 'batch-1', status: 'accepted' });
    await store.rollUpStatus(jobId);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/campaign/voice/${jobId}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.provider_response).toEqual({ batch_id: 'batch-1', status: 'accepted' });
    const item = body.items.find((i: { item_id: string }) => i.item_id === 'a');
    expect(item.status).toBe('submitted');
    expect(item.provider_batch_ref).toBe('batch-1');
  });

  it('GET /:job_id returns 403 for a job owned by another org', async () => {
    const jobId = await seedJob(store, ORG, ['a']);
    const res = await app.inject({
      method: 'GET',
      url: `/v1/campaign/export/${jobId}`,
      headers: { authorization: 'Bearer other-org' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('CAMPAIGN_JOB_FORBIDDEN');
  });

  it('GET / lists the org jobs newest-first with derived counts', async () => {
    const first = await seedJob(store, ORG, ['a']);
    const second = await seedJob(store, ORG, ['b', 'c']);
    const res = await app.inject({ method: 'GET', url: '/v1/campaign/export', headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.jobs.map((j: { job_id: string }) => j.job_id)).toEqual([second, first]);
    expect(body.jobs[0].counts.total).toBe(2);
    expect(body.next_cursor).toBeNull();
  });

  it('GET / paginates via next_cursor and excludes other orgs', async () => {
    const first = await seedJob(store, ORG, ['a']);
    const second = await seedJob(store, ORG, ['b']);
    await seedJob(store, 'org-other', ['x']); // must not appear
    const page1 = await app.inject({
      method: 'GET',
      url: '/v1/campaign/export?limit=1',
      headers: auth,
    });
    expect(page1.json().jobs.map((j: { job_id: string }) => j.job_id)).toEqual([second]);
    const cursor = page1.json().next_cursor;
    expect(cursor).not.toBeNull();
    const page2 = await app.inject({
      method: 'GET',
      url: `/v1/campaign/export?limit=1&cursor=${encodeURIComponent(cursor)}`,
      headers: auth,
    });
    expect(page2.json().jobs.map((j: { job_id: string }) => j.job_id)).toEqual([first]);
  });

  it('GET /:job_id does not serve a job from another channel (403)', async () => {
    // Regression: the /export path used to return email/voice jobs too.
    const emailJob = await seedJob(store, ORG, ['a'], 'email');
    const res = await app.inject({
      method: 'GET',
      url: `/v1/campaign/export/${emailJob}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('CAMPAIGN_JOB_FORBIDDEN');
  });

  it('GET / lists only this channel, never email or voice jobs', async () => {
    const exportJob = await seedJob(store, ORG, ['a'], 'export');
    await seedJob(store, ORG, ['b'], 'email');
    await seedJob(store, ORG, ['c'], 'voice');
    const res = await app.inject({ method: 'GET', url: '/v1/campaign/export', headers: auth });
    expect(res.statusCode).toBe(200);
    const jobs = res.json().jobs as Array<{ job_id: string; channel: string }>;
    expect(jobs.map((j) => j.job_id)).toEqual([exportJob]);
    expect(jobs.every((j) => j.channel === 'export')).toBe(true);
  });

  it('GET / requires auth (401 without a token)', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/campaign/export' });
    expect(res.statusCode).toBe(401);
  });
});
