/**
 * Unit tests for the bulk-upload BullMQ enqueue surface.
 *
 * `bullmq` and `@aggregator-dpg/queue`'s `createRedisConnection` are mocked
 * (per testing.md §1 — third-party adapters may be stubbed) so no real Redis
 * connection or queue is created. Covers the singleton caching, the
 * idempotent-by-`uploadId` enqueue, failure logging + rethrow, and shutdown.
 *
 * @module @aggregator-dpg/api
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const addMock = vi.fn();
const closeMock = vi.fn();
const queueCtorCalls: Array<{ name: string; opts: unknown }> = [];

vi.mock('bullmq', () => {
  class MockQueue {
    add = addMock;
    close = closeMock;
    constructor(name: string, opts: unknown) {
      queueCtorCalls.push({ name, opts });
    }
  }
  return { Queue: MockQueue };
});

const onMock = vi.fn();
const quitMock = vi.fn().mockResolvedValue(undefined);
const redisCtorCalls: Array<{ url: string }> = [];

vi.mock('@aggregator-dpg/queue', () => ({
  QueueName: { BulkFileProcess: 'bulk-file-process' },
  DEFAULT_JOB_OPTS: { attempts: 3 },
  createRedisConnection: vi.fn((opts: { url: string }) => {
    redisCtorCalls.push({ url: opts.url });
    return { on: onMock, quit: quitMock };
  }),
}));

describe('bulk-queue', () => {
  beforeEach(() => {
    vi.resetModules();
    addMock.mockReset();
    closeMock.mockReset();
    onMock.mockReset();
    quitMock.mockClear();
    queueCtorCalls.length = 0;
    redisCtorCalls.length = 0;
  });

  it('enqueues a bulk-file-process job keyed by uploadId for idempotency', async () => {
    addMock.mockResolvedValue(undefined);
    const { enqueueBulkFileProcess } = await import('./index.js');
    await enqueueBulkFileProcess({
      uploadId: 'up-1',
      aggregatorId: 'agg-1',
      s3Key: 'bulk-uploads/agg-1/up-1/raw.csv',
      participantType: 'seeker',
      schemaId: 'profile',
      schemaVersion: '1.0',
    });
    expect(addMock).toHaveBeenCalledTimes(1);
    expect(addMock.mock.calls[0]?.[2]).toEqual({ jobId: 'up-1' });
  });

  it('builds the Redis connection + queue lazily and caches them across calls', async () => {
    addMock.mockResolvedValue(undefined);
    const { enqueueBulkFileProcess } = await import('./index.js');
    await enqueueBulkFileProcess({
      uploadId: 'up-1',
      aggregatorId: 'agg-1',
      s3Key: 'k',
      participantType: 'seeker',
      schemaId: 's',
      schemaVersion: '1',
    });
    await enqueueBulkFileProcess({
      uploadId: 'up-2',
      aggregatorId: 'agg-1',
      s3Key: 'k2',
      participantType: 'seeker',
      schemaId: 's',
      schemaVersion: '1',
    });
    // Singleton: exactly one Redis connection + one Queue built across both calls.
    expect(redisCtorCalls).toHaveLength(1);
    expect(queueCtorCalls).toHaveLength(1);
    expect(onMock).toHaveBeenCalledWith('error', expect.any(Function));
  });

  it('logs the redis error handler without throwing when invoked', async () => {
    addMock.mockResolvedValue(undefined);
    const { enqueueBulkFileProcess } = await import('./index.js');
    await enqueueBulkFileProcess({
      uploadId: 'up-1',
      aggregatorId: 'agg-1',
      s3Key: 'k',
      participantType: 'seeker',
      schemaId: 's',
      schemaVersion: '1',
    });
    const errorHandler = onMock.mock.calls.find((c) => c[0] === 'error')?.[1] as (
      err: Error,
    ) => void;
    expect(() => errorHandler(new Error('conn reset'))).not.toThrow();
  });

  it('logs and rethrows when the enqueue call fails', async () => {
    addMock.mockRejectedValue(new Error('redis unavailable'));
    const { enqueueBulkFileProcess } = await import('./index.js');
    await expect(
      enqueueBulkFileProcess({
        uploadId: 'up-err',
        aggregatorId: 'agg-1',
        s3Key: 'k',
        participantType: 'seeker',
        schemaId: 's',
        schemaVersion: '1',
      }),
    ).rejects.toThrow('redis unavailable');
  });

  it('closeBulkQueue closes the queue and quits the connection, then resets singletons', async () => {
    addMock.mockResolvedValue(undefined);
    closeMock.mockResolvedValue(undefined);
    const { enqueueBulkFileProcess, closeBulkQueue } = await import('./index.js');
    await enqueueBulkFileProcess({
      uploadId: 'up-1',
      aggregatorId: 'agg-1',
      s3Key: 'k',
      participantType: 'seeker',
      schemaId: 's',
      schemaVersion: '1',
    });
    await closeBulkQueue();
    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(quitMock).toHaveBeenCalledTimes(1);

    // A subsequent enqueue rebuilds fresh singletons — proves the reset happened.
    await enqueueBulkFileProcess({
      uploadId: 'up-2',
      aggregatorId: 'agg-1',
      s3Key: 'k',
      participantType: 'seeker',
      schemaId: 's',
      schemaVersion: '1',
    });
    expect(redisCtorCalls).toHaveLength(2);
    expect(queueCtorCalls).toHaveLength(2);
  });

  it('closeBulkQueue tolerates a quit() rejection (swallowed via .catch)', async () => {
    quitMock.mockRejectedValueOnce(new Error('already closed'));
    closeMock.mockResolvedValue(undefined);
    addMock.mockResolvedValue(undefined);
    const { enqueueBulkFileProcess, closeBulkQueue } = await import('./index.js');
    await enqueueBulkFileProcess({
      uploadId: 'up-1',
      aggregatorId: 'agg-1',
      s3Key: 'k',
      participantType: 'seeker',
      schemaId: 's',
      schemaVersion: '1',
    });
    await expect(closeBulkQueue()).resolves.toBeUndefined();
  });

  it('closeBulkQueue is a no-op when nothing was ever built', async () => {
    const { closeBulkQueue } = await import('./index.js');
    await expect(closeBulkQueue()).resolves.toBeUndefined();
    expect(closeMock).not.toHaveBeenCalled();
  });

  it('_resetBulkQueue delegates to closeBulkQueue', async () => {
    addMock.mockResolvedValue(undefined);
    closeMock.mockResolvedValue(undefined);
    const { enqueueBulkFileProcess, _resetBulkQueue } = await import('./index.js');
    await enqueueBulkFileProcess({
      uploadId: 'up-1',
      aggregatorId: 'agg-1',
      s3Key: 'k',
      participantType: 'seeker',
      schemaId: 's',
      schemaVersion: '1',
    });
    await _resetBulkQueue();
    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(quitMock).toHaveBeenCalledTimes(1);
  });
});
