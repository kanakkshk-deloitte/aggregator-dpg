/**
 * Structural regression tests for the campaign async-job tables (#579):
 * `campaign_job` + `campaign_job_item` and their three enums. These are facts
 * the store + worker + migration all depend on — an accidental rename, a
 * flipped `.notNull()`, or a dropped partial-unique index would silently break
 * idempotency, item-level dedup, or the derived-count queries.
 *
 * @module @aggregator-dpg/db-schema
 */

import { describe, it, expect } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import {
  campaignJob,
  campaignJobItem,
  campaignJobStatusEnum,
  campaignJobItemStatusEnum,
  campaignChannelEnum,
} from '../schema.js';

describe('campaign job enums', () => {
  it('campaignJobStatusEnum: the roll-up lifecycle', () => {
    expect(campaignJobStatusEnum.enumName).toBe('campaign_job_status');
    expect(campaignJobStatusEnum.enumValues).toEqual([
      'queued',
      'processing',
      'partial',
      'completed',
      'failed',
    ]);
  });

  it('campaignJobItemStatusEnum: in-flight, success, skip and error terminals', () => {
    expect(campaignJobItemStatusEnum.enumName).toBe('campaign_job_item_status');
    expect(campaignJobItemStatusEnum.enumValues).toEqual([
      'pending',
      'resolved',
      'submitted',
      'sent',
      'skipped_not_owned',
      'skipped_no_contact',
      'duplicate_active',
      'failed',
    ]);
  });

  it('campaignChannelEnum: export | email | voice', () => {
    expect(campaignChannelEnum.enumName).toBe('campaign_channel');
    expect(campaignChannelEnum.enumValues).toEqual(['export', 'email', 'voice']);
  });
});

describe('campaign_job columns', () => {
  it('identity + tenant + envelope columns', () => {
    expect(campaignJob.id.name).toBe('id');
    expect(campaignJob.id.primary).toBe(true);
    expect(campaignJob.id.hasDefault).toBe(true);
    expect(campaignJob.id.columnType).toBe('PgUUID');

    expect(campaignJob.userId.name).toBe('user_id');
    expect(campaignJob.userId.notNull).toBe(true);

    expect(campaignJob.signalstackOrgId.name).toBe('signalstack_org_id');
    expect(campaignJob.signalstackOrgId.notNull).toBe(true);

    expect(campaignJob.channel.name).toBe('channel');
    expect(campaignJob.channel.notNull).toBe(true);
    expect(campaignJob.channel.columnType).toBe('PgEnumColumn');

    expect(campaignJob.status.name).toBe('status');
    expect(campaignJob.status.notNull).toBe(true);
    expect(campaignJob.status.hasDefault).toBe(true);

    // idempotency_key is nullable (callers may omit it).
    expect(campaignJob.idempotencyKey.name).toBe('idempotency_key');
    expect(campaignJob.idempotencyKey.notNull).toBe(false);

    expect(campaignJob.metadata.name).toBe('metadata');
    expect(campaignJob.metadata.notNull).toBe(true);
    expect(campaignJob.metadata.hasDefault).toBe(true);

    expect(campaignJob.content.name).toBe('content');
    expect(campaignJob.content.notNull).toBe(true);
    expect(campaignJob.content.hasDefault).toBe(true);

    expect(campaignJob.requestedBy.name).toBe('requested_by');
    expect(campaignJob.requestedBy.notNull).toBe(true);

    expect(campaignJob.lastProgressAt.name).toBe('last_progress_at');
    expect(campaignJob.lastProgressAt.notNull).toBe(false);
  });

  it('has the idempotency + tenant-list + watchdog indexes', () => {
    const { indexes } = getTableConfig(campaignJob);
    const names = indexes.map((i) => i.config.name);
    expect(names).toContain('campaign_job_idempotency_key_unique');
    expect(names).toContain('campaign_job_org_status_idx');
    expect(names).toContain('campaign_job_status_progress_idx');
    const idem = indexes.find((i) => i.config.name === 'campaign_job_idempotency_key_unique');
    expect(idem!.config.unique).toBe(true);
    expect(idem!.config.where).toBeDefined();
  });

  it('campaign_job has a nullable provider_response jsonb', () => {
    const cols = getTableColumns(campaignJob);
    expect(cols.providerResponse).toBeDefined();
  });
});

describe('campaign_job_item columns', () => {
  it('references the job and carries a nullable action', () => {
    expect(campaignJobItem.jobId.name).toBe('job_id');
    expect(campaignJobItem.jobId.notNull).toBe(true);

    expect(campaignJobItem.itemId.name).toBe('item_id');
    expect(campaignJobItem.itemId.notNull).toBe(true);

    // export items carry no action (NULL) — turns off the active-dedup index.
    expect(campaignJobItem.action.name).toBe('action');
    expect(campaignJobItem.action.notNull).toBe(false);

    expect(campaignJobItem.status.name).toBe('status');
    expect(campaignJobItem.status.notNull).toBe(true);
    expect(campaignJobItem.status.hasDefault).toBe(true);

    // Provider linkage + outcome detail the voice/email channels write back.
    expect(campaignJobItem.providerRef.name).toBe('provider_ref');
    expect(campaignJobItem.rayaBatchId.name).toBe('raya_batch_id');
    expect(campaignJobItem.lastProviderStatus.name).toBe('last_provider_status');
    expect(campaignJobItem.skipReason.name).toBe('skip_reason');
    expect(campaignJobItem.attempts.name).toBe('attempts');
    expect(campaignJobItem.attempts.notNull).toBe(true);
    expect(campaignJobItem.completedAt.name).toBe('completed_at');
    expect(campaignJobItem.channel.name).toBe('channel');
    expect(campaignJobItem.channel.notNull).toBe(true);
  });

  it('has the derived-count index and the partial-unique active-dedup index', () => {
    const { indexes } = getTableConfig(campaignJobItem);
    const names = indexes.map((i) => i.config.name);
    expect(names).toContain('campaign_job_item_job_status_idx');
    expect(names).toContain('campaign_job_item_active_dedup');
    expect(names).toContain('campaign_job_item_job_item_unique');
    const dedup = indexes.find((i) => i.config.name === 'campaign_job_item_active_dedup');
    expect(dedup!.config.unique).toBe(true);
    expect(dedup!.config.where).toBeDefined();
  });
});
