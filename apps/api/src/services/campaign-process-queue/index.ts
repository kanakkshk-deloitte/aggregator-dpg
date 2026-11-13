/**
 * BullMQ enqueue surface for the campaign-process pipeline.
 *
 * The API saves the `campaign_job` row, then enqueues a job carrying only its
 * id; the worker's `campaign` role loads the rest and runs the channel
 * handler. Connection and queue are lazy singletons. Belongs to `@aggregator-dpg/api`.
 */

import { Queue } from 'bullmq';
import {
  QueueName,
  CAMPAIGN_PROCESS_JOB_OPTS,
  createRedisConnection,
  type CampaignProcessJob,
} from '@aggregator-dpg/queue';
import type { Redis } from 'ioredis';
import { config } from '../../config.js';
import { logger } from '../../logger.js';

let connection: Redis | null = null;
let processQueue: Queue<CampaignProcessJob> | null = null;

function getConnection(): Redis {
  if (connection) return connection;
  connection = createRedisConnection({ url: config.REDIS_URL });
  connection.on('error', (err) => {
    logger.warn({ operation: 'campaignProcessQueue.redis.error', error: err.message });
  });
  return connection;
}

function getProcessQueue(): Queue<CampaignProcessJob> {
  if (processQueue) return processQueue;
  // No `attempts` here: the queue serves every channel, so callers pass
  // CAMPAIGN_<CHANNEL>_ATTEMPTS per enqueue.
  processQueue = new Queue<CampaignProcessJob>(QueueName.CampaignProcess, {
    connection: getConnection(),
    defaultJobOptions: CAMPAIGN_PROCESS_JOB_OPTS,
  });
  return processQueue;
}

/**
 * Enqueues a `campaign-process` job.
 *
 * Uses `campaign_job.id` as the BullMQ jobId, so a re-enqueue of the same job
 * is de-duplicated. Throws on failure so the route can answer 503.
 *
 * @param payload - `{ jobId }` — the campaign_job row to process.
 * @param opts.attempts - Retry count for this channel
 *   (`CAMPAIGN_<CHANNEL>_ATTEMPTS`). Falls back to the shared default.
 */
export async function enqueueCampaignProcess(
  payload: CampaignProcessJob,
  opts: { attempts?: number } = {},
): Promise<void> {
  const start = Date.now();
  try {
    await getProcessQueue().add(QueueName.CampaignProcess, payload, {
      jobId: payload.jobId,
      ...(opts.attempts !== undefined ? { attempts: opts.attempts } : {}),
    });
    logger.info({
      operation: 'campaignProcessQueue.enqueue',
      status: 'success',
      latency_ms: Date.now() - start,
      job_id: payload.jobId,
    });
  } catch (err) {
    logger.error({
      operation: 'campaignProcessQueue.enqueue',
      status: 'failure',
      error: (err as Error).message,
      latency_ms: Date.now() - start,
      job_id: payload.jobId,
    });
    throw err;
  }
}

/**
 * Closes the queue and its Redis connection. Idempotent; call on process shutdown.
 */
export async function closeCampaignProcessQueue(): Promise<void> {
  await processQueue?.close();
  await connection?.quit().catch(() => undefined);
  processQueue = null;
  connection = null;
}

/** Test-only — disconnect and clear cached singletons. */
export async function _resetCampaignProcessQueue(): Promise<void> {
  await closeCampaignProcessQueue();
}
