/**
 * Unit tests for the worker-side BullMQ enqueue surfaces (Row Processor +
 * Finaliser queues). `bullmq`'s `Queue` and the worker's redis singleton are
 * mocked so no real Redis connection is opened.
 *
 * The module under test caches its `Queue` instances at module scope, so
 * these tests run in sequence and track *all* constructed instances rather
 * than resetting between tests — `latestQueue(name)` always looks at the
 * most recently constructed instance for a given queue name, which is what
 * `closeQueues()` + a subsequent enqueue actually rebuilds.
 *
 * @module @aggregator-dpg/worker
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BulkRowProcessJob, BulkFinaliseJob } from '@aggregator-dpg/queue';

interface FakeQueueInstance {
  name: string;
  opts: unknown;
  add: ReturnType<typeof vi.fn>;
  addBulk: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

const queueInstances: FakeQueueInstance[] = [];

vi.mock('bullmq', () => {
  class Queue {
    name: string;
    opts: unknown;
    add = vi.fn(async () => ({}));
    addBulk = vi.fn(async () => []);
    close = vi.fn(async () => undefined);
    constructor(name: string, opts: unknown) {
      this.name = name;
      this.opts = opts;
      queueInstances.push(this as unknown as FakeQueueInstance);
    }
  }
  return { Queue };
});

vi.mock('./redis.js', () => ({ getRedis: () => ({ __fakeRedis: true }) }));

const infoLog = vi.fn();
vi.mock('../logger.js', () => ({ logger: { info: infoLog, warn: vi.fn(), error: vi.fn() } }));

const { enqueueRowProcess, enqueueRowProcessBulk, enqueueFinalise, closeQueues } =
  await import('./bulk-queue.js');

function rowJob(overrides: Partial<BulkRowProcessJob> = {}): BulkRowProcessJob {
  return {
    uploadId: 'up-1',
    aggregatorId: 'agg-1',
    rowIndex: 0,
    schemaId: 'participant-seeker',
    schemaVersion: 'v1',
    participantType: 'seeker',
    payload: { name: 'Asha' },
    ...overrides,
  };
}

/** The most recently constructed fake Queue instance with the given name. */
function latestQueue(name: string): FakeQueueInstance | undefined {
  return [...queueInstances].reverse().find((q) => q.name === name);
}

function countQueues(name: string): number {
  return queueInstances.filter((q) => q.name === name).length;
}

beforeEach(() => {
  infoLog.mockClear();
});

describe('enqueueRowProcess', () => {
  it('adds a row job with a jobId encoding uploadId + rowIndex', async () => {
    await enqueueRowProcess(rowJob({ uploadId: 'up-9', rowIndex: 3 }));

    const rowQueue = latestQueue('bulk-row-process');
    expect(rowQueue).toBeDefined();
    expect(rowQueue?.add).toHaveBeenCalledWith(
      'bulk-row-process',
      expect.objectContaining({ uploadId: 'up-9', rowIndex: 3 }),
      { jobId: 'up-9__3' },
    );
  });

  it('reuses the same Queue instance across calls (singleton)', async () => {
    const countBefore = countQueues('bulk-row-process');

    await enqueueRowProcess(rowJob());
    await enqueueRowProcess(rowJob({ rowIndex: 1 }));

    expect(countQueues('bulk-row-process')).toBe(countBefore);
  });
});

describe('enqueueRowProcessBulk', () => {
  it('is a no-op for an empty payload array (does not touch the queue)', async () => {
    const countBefore = countQueues('bulk-row-process');

    await enqueueRowProcessBulk([]);

    expect(countQueues('bulk-row-process')).toBe(countBefore);
  });

  it('batches all payloads through a single addBulk call with per-row jobIds', async () => {
    const payloads = [rowJob({ rowIndex: 0 }), rowJob({ rowIndex: 1 })];

    await enqueueRowProcessBulk(payloads);

    const rowQueue = latestQueue('bulk-row-process');
    expect(rowQueue?.addBulk).toHaveBeenCalledWith([
      { name: 'bulk-row-process', data: payloads[0], opts: { jobId: 'up-1__0' } },
      { name: 'bulk-row-process', data: payloads[1], opts: { jobId: 'up-1__1' } },
    ]);
  });
});

describe('enqueueFinalise', () => {
  it('adds a finalise job with a deterministic jobId and logs success', async () => {
    const payload: BulkFinaliseJob = { uploadId: 'up-5' };

    await enqueueFinalise(payload);

    const finaliseQueue = latestQueue('bulk-finalise');
    expect(finaliseQueue?.add).toHaveBeenCalledWith('bulk-finalise', payload, {
      jobId: 'up-5__finalise',
    });
    expect(infoLog).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'bulkQueue.enqueueFinalise', upload_id: 'up-5' }),
    );
  });

  it('always encodes the same jobId for repeated enqueues of one upload (BullMQ dedupes on it)', async () => {
    await enqueueFinalise({ uploadId: 'up-7' });
    await enqueueFinalise({ uploadId: 'up-7' });

    const finaliseQueue = latestQueue('bulk-finalise');
    const calls = finaliseQueue?.add.mock.calls.filter(
      (c: unknown[]) => (c[1] as BulkFinaliseJob).uploadId === 'up-7',
    );
    expect(calls).toHaveLength(2);
    for (const call of calls ?? []) {
      expect(call[2]).toEqual({ jobId: 'up-7__finalise' });
    }
  });
});

describe('closeQueues', () => {
  it('closes both queues once created and resets the singletons so the next enqueue rebuilds them', async () => {
    await enqueueRowProcess(rowJob());
    await enqueueFinalise({ uploadId: 'up-1' });

    const rowBefore = latestQueue('bulk-row-process');
    const finaliseBefore = latestQueue('bulk-finalise');
    const rowCountBefore = countQueues('bulk-row-process');

    await closeQueues();

    expect(rowBefore?.close).toHaveBeenCalledOnce();
    expect(finaliseBefore?.close).toHaveBeenCalledOnce();

    // After close, the next enqueue constructs a brand new Queue instance.
    await enqueueRowProcess(rowJob());
    expect(countQueues('bulk-row-process')).toBe(rowCountBefore + 1);
    expect(latestQueue('bulk-row-process')).not.toBe(rowBefore);
  });

  it('is idempotent — closing again after the queues are already closed does not throw', async () => {
    await closeQueues(); // closes whatever the previous test left open
    await expect(closeQueues()).resolves.toBeUndefined();
  });
});
