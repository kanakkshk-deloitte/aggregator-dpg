/**
 * Worker entrypoint.
 *
 * Wires BullMQ workers for the onboarding pipeline. At slice 9 this
 * exposes only the File Processor (`bulk-file-process` queue). Subsequent
 * slices add the Row Processor, Finaliser, and Metrics Aggregator workers
 * alongside.
 */

// Load apps/worker/.env into process.env before config.js parses it (dev only;
// no-op when the file is absent, e.g. Docker/prod inject env directly).
import './env.js';

import { Queue, Worker } from 'bullmq';
import {
  QueueName,
  DEFAULT_JOB_OPTS,
  type BulkFileProcessJob,
  type BulkFinaliseJob,
  type BulkRowProcessJob,
  type CronWatchdogJob,
  type LinkMetricsRollupJob,
} from '@aggregator-dpg/queue';
import { config } from './config.js';
import { logger } from './logger.js';
import { closeDb } from './db.js';
import { processBulkFile } from './jobs/bulk-file-process.js';
import { processBulkRow } from './jobs/bulk-row-process.js';
import { finaliseBulk } from './jobs/bulk-finalise.js';
import { rollupLinkMetrics } from './jobs/link-metrics-rollup.js';
import { runWatchdog } from './jobs/cron-watchdog.js';
import { getRedis, closeRedis } from './services/redis.js';
import { closeQueues } from './services/bulk-queue.js';
import { parseWorkerRoles, missingRoles } from './worker-roles.js';

async function main(): Promise<void> {
  const connection = getRedis();
  // Which consumers this process runs. Default (unset) = all, preserving the
  // single-process deployment; `WORKER_ROLES=file` isolates the parser.
  const roles = parseWorkerRoles(config.WORKER_ROLES);

  const workers: Array<readonly [string, Worker]> = [];
  const queues: Queue[] = [];

  if (roles.has('file')) {
    workers.push([
      'bulkFileProcess',
      new Worker<BulkFileProcessJob>(
        QueueName.BulkFileProcess,
        async (job) => processBulkFile(job.data),
        { connection, concurrency: config.BULK_FILE_PROCESS_CONCURRENCY },
      ),
    ]);
  }

  if (roles.has('row')) {
    workers.push([
      'bulkRowProcess',
      new Worker<BulkRowProcessJob>(
        QueueName.BulkRowProcess,
        async (job) => processBulkRow(job.data),
        { connection, concurrency: config.BULK_ROW_PROCESS_CONCURRENCY },
      ),
    ]);
  }

  if (roles.has('finalise')) {
    workers.push([
      'bulkFinalise',
      new Worker<BulkFinaliseJob>(QueueName.BulkFinalise, async (job) => finaliseBulk(job.data), {
        connection,
        concurrency: config.BULK_FINALISE_CONCURRENCY,
      }),
    ]);
  }

  if (roles.has('cron')) {
    workers.push([
      'linkMetricsRollup',
      new Worker<LinkMetricsRollupJob>(
        QueueName.LinkMetricsRollup,
        async (job) => rollupLinkMetrics(job.data),
        { connection, concurrency: 1 },
      ),
    ]);
    workers.push([
      'cronWatchdog',
      new Worker<CronWatchdogJob>(QueueName.CronWatchdog, async () => runWatchdog(), {
        connection,
        concurrency: 1,
      }),
    ]);

    // Repeatable cron ticks. Threshold-triggered fan-in for metrics rollup
    // can be added later — cron-only is sufficient for MVP.
    const linkMetricsQueue = new Queue<LinkMetricsRollupJob>(QueueName.LinkMetricsRollup, {
      connection,
      defaultJobOptions: DEFAULT_JOB_OPTS,
    });
    await linkMetricsQueue.add(
      'tick',
      { tick: Date.now() },
      {
        repeat: { every: config.LINK_METRICS_ROLLUP_INTERVAL_MS },
        jobId: 'link-metrics-rollup-tick',
      },
    );
    queues.push(linkMetricsQueue);

    const watchdogQueue = new Queue<CronWatchdogJob>(QueueName.CronWatchdog, {
      connection,
      defaultJobOptions: DEFAULT_JOB_OPTS,
    });
    await watchdogQueue.add(
      'tick',
      { tick: Date.now() },
      { repeat: { every: config.WATCHDOG_INTERVAL_MS }, jobId: 'cron-watchdog-tick' },
    );
    queues.push(watchdogQueue);

    // One-shot cleanup: removed cron-driven keycloak-sync. If a previous worker
    // run registered the repeatable, drop it from Redis so it does not keep
    // firing without a consumer.
    const legacyKeycloakSyncQueue = new Queue('keycloak-sync', { connection });
    try {
      const repeatables = await legacyKeycloakSyncQueue.getRepeatableJobs();
      for (const r of repeatables) {
        await legacyKeycloakSyncQueue.removeRepeatableByKey(r.key);
      }
    } finally {
      await legacyKeycloakSyncQueue.close();
    }
  }

  for (const [name, w] of workers) {
    w.on('completed', (job, result) => {
      logger.debug({ operation: `worker.${name}.completed`, job_id: job.id, result });
    });
    w.on('failed', (job, err) => {
      logger.error({ operation: `worker.${name}.failed`, job_id: job?.id, error: err.message });
    });
  }

  // Fleet-completeness sanity check: a process running a strict subset of roles
  // is valid only if the complement runs in another deployment. Warn so a
  // single-pod misconfiguration doesn't silently strand uploads (no consumer
  // for finalise, or no cron watchdog to fail stuck uploads out).
  const uncovered = missingRoles(roles);
  if (uncovered.length > 0) {
    logger.warn({
      operation: 'worker.boot',
      status: 'partial_roles',
      roles: [...roles],
      not_running_here: uncovered,
      message:
        'This process runs a subset of worker roles. Ensure another deployment runs the rest — the union across the fleet MUST cover file+row+finalise+cron, and cron must run in exactly one place.',
    });
  }

  logger.info({
    operation: 'worker.boot',
    status: 'ready',
    roles: [...roles],
    queues: workers.map(([name]) => name),
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ operation: 'worker.shutdown', signal });
    await Promise.all(workers.map(([, w]) => w.close()));
    await Promise.all(queues.map((q) => q.close()));
    await closeQueues();
    await closeRedis();
    await closeDb();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error({
    operation: 'worker.boot',
    status: 'failure',
    error: (err as Error).message,
    stack: (err as Error).stack,
  });
  process.exit(1);
});
