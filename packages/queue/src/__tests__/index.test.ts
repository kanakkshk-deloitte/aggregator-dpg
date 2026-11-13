/**
 * Unit tests for the queue package surface: queue name constants, job option
 * defaults, the per-upload Redis key namespace, and the ioredis connection
 * factory.
 *
 * `ioredis` is mocked (per testing.md §1 — third-party adapters may be
 * stubbed) so constructing a connection never opens a real socket.
 *
 * @module @aggregator-dpg/queue
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const redisCtorCalls: Array<{ url: string; options: unknown }> = [];

vi.mock('ioredis', () => {
  class MockRedis {
    url: string;
    options: unknown;
    constructor(url: string, options: unknown) {
      this.url = url;
      this.options = options;
      redisCtorCalls.push({ url, options });
    }
  }
  return { Redis: MockRedis };
});

import {
  QueueName,
  DEFAULT_JOB_OPTS,
  CAMPAIGN_PROCESS_JOB_OPTS,
  bulkRedisKeys,
  createRedisConnection,
} from '../index.js';

describe('QueueName', () => {
  it('defines one constant per pipeline queue', () => {
    expect(QueueName).toEqual({
      BulkFileProcess: 'bulk-file-process',
      BulkRowProcess: 'bulk-row-process',
      BulkFinalise: 'bulk-finalise',
      LinkMetricsRollup: 'link-metrics-rollup',
      CronWatchdog: 'cron-watchdog',
      CampaignProcess: 'campaign-process',
    });
  });
});

describe('CAMPAIGN_PROCESS_JOB_OPTS', () => {
  it('mirrors the bounded retry/backoff/retention policy', () => {
    expect(CAMPAIGN_PROCESS_JOB_OPTS).toEqual({
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: { age: 3600 },
      removeOnFail: { age: 604800 },
    });
  });

  it('is spreadable so the API can override attempts', () => {
    expect({ ...CAMPAIGN_PROCESS_JOB_OPTS, attempts: 5 }.attempts).toBe(5);
  });
});

describe('DEFAULT_JOB_OPTS', () => {
  it('sets a bounded retry/backoff/retention policy', () => {
    expect(DEFAULT_JOB_OPTS).toEqual({
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: { age: 3600 },
      removeOnFail: { age: 604800 },
    });
  });
});

describe('bulkRedisKeys', () => {
  it('returns the six namespaced keys for an upload id', () => {
    expect(bulkRedisKeys('up-1')).toEqual([
      'bu:up-1:processed',
      'bu:up-1:counters',
      'bu:up-1:errors',
      'bu:up-1:error_rows',
      'bu:up-1:meta',
      'bu:up-1:lines',
    ]);
  });

  it('namespaces keys per upload id so two uploads never collide', () => {
    const a = bulkRedisKeys('up-a');
    const b = bulkRedisKeys('up-b');
    expect(a.every((k) => k.startsWith('bu:up-a:'))).toBe(true);
    expect(b.every((k) => k.startsWith('bu:up-b:'))).toBe(true);
  });
});

describe('createRedisConnection', () => {
  const originalEnv = process.env.REDIS_URL;

  beforeEach(() => {
    redisCtorCalls.length = 0;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = originalEnv;
  });

  it('uses REDIS_URL from the environment when no url override is given', () => {
    process.env.REDIS_URL = 'redis://env-host:6380';
    createRedisConnection();
    expect(redisCtorCalls).toHaveLength(1);
    expect(redisCtorCalls[0]?.url).toBe('redis://env-host:6380');
  });

  it('falls back to localhost when neither an override nor REDIS_URL is set', () => {
    delete process.env.REDIS_URL;
    createRedisConnection();
    expect(redisCtorCalls[0]?.url).toBe('redis://localhost:6379');
  });

  it('prefers an explicit url override over REDIS_URL', () => {
    process.env.REDIS_URL = 'redis://env-host:6380';
    createRedisConnection({ url: 'redis://explicit-host:6381' });
    expect(redisCtorCalls[0]?.url).toBe('redis://explicit-host:6381');
  });

  it('defaults maxRetriesPerRequest to null (required by BullMQ) and always enables ready-check', () => {
    createRedisConnection();
    expect(redisCtorCalls[0]?.options).toMatchObject({
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });
  });

  it('passes through an explicit maxRetriesPerRequest for non-queue callers', () => {
    createRedisConnection({ maxRetriesPerRequest: 2 });
    expect(redisCtorCalls[0]?.options).toMatchObject({ maxRetriesPerRequest: 2 });
  });

  it('omits commandTimeout when not provided', () => {
    createRedisConnection();
    expect(redisCtorCalls[0]?.options).not.toHaveProperty('commandTimeout');
  });

  it('includes commandTimeout when provided', () => {
    createRedisConnection({ commandTimeout: 500 });
    expect(redisCtorCalls[0]?.options).toMatchObject({ commandTimeout: 500 });
  });

  it('omits enableOfflineQueue when not provided', () => {
    createRedisConnection();
    expect(redisCtorCalls[0]?.options).not.toHaveProperty('enableOfflineQueue');
  });

  it('includes enableOfflineQueue when explicitly disabled', () => {
    createRedisConnection({ enableOfflineQueue: false });
    expect(redisCtorCalls[0]?.options).toMatchObject({ enableOfflineQueue: false });
  });
});
