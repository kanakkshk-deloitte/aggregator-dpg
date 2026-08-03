/**
 * BullMQ enqueue surface for the bulk-upload pipeline.
 *
 * The API only enqueues; consumption lives in `apps/worker`. Connection is
 * a singleton ioredis client; queues are constructed lazily and reused.
 */

import { Queue } from 'bullmq';
import {
  QueueName,
  DEFAULT_JOB_OPTS,
  createRedisConnection,
  type BulkFileProcessJob,
} from '@aggregator-dpg/queue';
import type { Redis } from 'ioredis';
import { config } from '../../config.js';
import { logger } from '../../logger.js';

let connection: Redis | null = null;
let fileProcessQueue: Queue<BulkFileProcessJob> | null = null;

function getConnection(): Redis {
  if (connection) return connection;
  connection = createRedisConnection({ url: config.REDIS_URL });
  connection.on('error', (err) => {
    logger.warn({
      operation: 'bulkQueue.redis.error',
      error: err.message,
    });
  });
  return connection;
}

function getFileProcessQueue(): Queue<BulkFileProcessJob> {
  if (fileProcessQueue) return fileProcessQueue;
  fileProcessQueue = new Queue<BulkFileProcessJob>(QueueName.BulkFileProcess, {
    connection: getConnection(),
    defaultJobOptions: DEFAULT_JOB_OPTS,
  });
  return fileProcessQueue;
}

/**
 * Enqueues a `bulk-file-process` job. Idempotent via `jobId = uploadId` —
 * a duplicate enqueue for the same upload is silently no-op.
 */
export async function enqueueBulkFileProcess(payload: BulkFileProcessJob): Promise<void> {
  const start = Date.now();
  try {
    await getFileProcessQueue().add(QueueName.BulkFileProcess, payload, {
      jobId: payload.uploadId,
    });
    logger.info({
      operation: 'bulkQueue.enqueueBulkFileProcess',
      status: 'success',
      latency_ms: Date.now() - start,
      upload_id: payload.uploadId,
    });
  } catch (err) {
    logger.error({
      operation: 'bulkQueue.enqueueBulkFileProcess',
      status: 'failure',
      error: (err as Error).message,
      latency_ms: Date.now() - start,
      upload_id: payload.uploadId,
    });
    throw err;
  }
}

/**
 * Closes the BullMQ enqueue queue and its Redis connection. Idempotent; call
 * from process shutdown so the queue + connection are not leaked on SIGTERM.
 */
export async function closeBulkQueue(): Promise<void> {
  await fileProcessQueue?.close();
  await connection?.quit().catch(() => undefined);
  fileProcessQueue = null;
  connection = null;
}

/** Test-only — disconnect and clear cached singletons. */
export async function _resetBulkQueue(): Promise<void> {
  await closeBulkQueue();
}
