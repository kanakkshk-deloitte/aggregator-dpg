/**
 * Bulk upload queue producers for the worker app.
 *
 * The file processor enqueues row jobs; the row processor enqueues the finaliser.
 */

import { Queue } from 'bullmq';
import {
  QueueName,
  DEFAULT_JOB_OPTS,
  type BulkRowProcessJob,
  type BulkFinaliseJob,
} from '@aggregator-dpg/queue';
import { getRedis } from './redis.js';
import { logger } from '../logger.js';

let rowQueue: Queue<BulkRowProcessJob> | null = null;
let finaliseQueue: Queue<BulkFinaliseJob> | null = null;

function getRowQueue(): Queue<BulkRowProcessJob> {
  if (rowQueue) return rowQueue;
  rowQueue = new Queue<BulkRowProcessJob>(QueueName.BulkRowProcess, {
    connection: getRedis(),
    defaultJobOptions: DEFAULT_JOB_OPTS,
  });
  return rowQueue;
}

function getFinaliseQueue(): Queue<BulkFinaliseJob> {
  if (finaliseQueue) return finaliseQueue;
  finaliseQueue = new Queue<BulkFinaliseJob>(QueueName.BulkFinalise, {
    connection: getRedis(),
    defaultJobOptions: DEFAULT_JOB_OPTS,
  });
  return finaliseQueue;
}

/**
 * Enqueues one row job, deduped by uploadId and rowIndex.
 *
 * BullMQ rejects ':' in custom jobIds, so '__' is the separator.
 */
export async function enqueueRowProcess(payload: BulkRowProcessJob): Promise<void> {
  await getRowQueue().add(QueueName.BulkRowProcess, payload, {
    jobId: `${payload.uploadId}__${payload.rowIndex}`,
  });
}

/**
 * Enqueues many row jobs in one call, with the same jobIds as `enqueueRowProcess`.
 */
export async function enqueueRowProcessBulk(payloads: BulkRowProcessJob[]): Promise<void> {
  if (payloads.length === 0) return;
  const queue = getRowQueue();
  await queue.addBulk(
    payloads.map((p) => ({
      name: QueueName.BulkRowProcess,
      data: p,
      opts: { jobId: `${p.uploadId}__${p.rowIndex}` },
    })),
  );
}

/**
 * Enqueues the finaliser for an upload.
 *
 * The jobId `${uploadId}__finalise` makes BullMQ dedup concurrent triggers.
 */
export async function enqueueFinalise(payload: BulkFinaliseJob): Promise<void> {
  await getFinaliseQueue().add(QueueName.BulkFinalise, payload, {
    jobId: `${payload.uploadId}__finalise`,
  });
  logger.info({
    operation: 'bulkQueue.enqueueFinalise',
    upload_id: payload.uploadId,
  });
}

export async function closeQueues(): Promise<void> {
  await rowQueue?.close();
  await finaliseQueue?.close();
  rowQueue = null;
  finaliseQueue = null;
}
