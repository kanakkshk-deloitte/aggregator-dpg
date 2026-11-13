/**
 * Worker app entrypoint.
 *
 * Starts the health server and the BullMQ consumers for the roles in
 * `WORKER_ROLES`, and registers the cron schedulers when `cron` runs here.
 */

// Load apps/worker/.env before config.js parses env. No-op when the file is absent.
import './env.js';

import { Queue, Worker } from 'bullmq';
import {
  QueueName,
  DEFAULT_JOB_OPTS,
  type BulkFileProcessJob,
  type BulkFinaliseJob,
  type BulkRowProcessJob,
  type CampaignProcessJob,
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
import { processCampaignJob } from './jobs/campaign-process.js';
import { getRedis, closeRedis } from './services/redis.js';
import { closeQueues } from './services/bulk-queue.js';
import { parseWorkerRoles, missingRoles } from './worker-roles.js';
import { startHealthServer } from './health.js';

async function main(): Promise<void> {
  const connection = getRedis();
  const healthServer = startHealthServer(config.HEALTH_PORT, connection);
  // Consumers this process runs. Unset means all.
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

  if (roles.has('campaign')) {
    workers.push([
      'campaignProcess',
      new Worker<CampaignProcessJob>(
        QueueName.CampaignProcess,
        async (job) =>
          processCampaignJob(job.data, {
            attempt: job.attemptsMade + 1,
            maxAttempts: job.opts.attempts ?? 1,
          }),
        { connection, concurrency: config.CAMPAIGN_CONCURRENCY },
      ),
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

    // Repeatable cron ticks.
    const linkMetricsQueue = new Queue<LinkMetricsRollupJob>(QueueName.LinkMetricsRollup, {
      connection,
      defaultJobOptions: DEFAULT_JOB_OPTS,
    });
    await linkMetricsQueue.upsertJobScheduler(
      'link-metrics-rollup-tick',
      { every: config.LINK_METRICS_ROLLUP_INTERVAL_MS },
      { name: 'tick', data: { tick: Date.now() } },
    );
    queues.push(linkMetricsQueue);

    const watchdogQueue = new Queue<CronWatchdogJob>(QueueName.CronWatchdog, {
      connection,
      defaultJobOptions: DEFAULT_JOB_OPTS,
    });
    await watchdogQueue.upsertJobScheduler(
      'cron-watchdog-tick',
      { every: config.WATCHDOG_INTERVAL_MS },
      { name: 'tick', data: { tick: Date.now() } },
    );
    queues.push(watchdogQueue);

    // Remove any `keycloak-sync` scheduler left in Redis; it has no consumer.
    const legacyKeycloakSyncQueue = new Queue('keycloak-sync', { connection });
    try {
      const schedulers = await legacyKeycloakSyncQueue.getJobSchedulers();
      for (const s of schedulers) {
        await legacyKeycloakSyncQueue.removeJobScheduler(s.key);
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

  // Warn when this process runs only some roles. The rest must run elsewhere,
  // or uploads and campaigns stall.
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
    await new Promise<void>((resolve) => healthServer.close(() => resolve()));
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
