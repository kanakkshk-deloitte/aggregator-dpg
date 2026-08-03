/**
 * Process entrypoint. Builds the Fastify app and starts listening.
 */

import './env.js';
import { buildApp } from './app.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { runMigrations } from './db/migrate.js';
import { closeDb } from './db/client.js';
import { closeRateLimiter } from './services/rate-limiter/index.js';
import { closeRedis } from './services/redis/index.js';
import { closeBulkQueue } from './services/bulk-queue/index.js';
import { getNetworkConfig } from './services/network-config.js';
import { setApprovalBrand } from './views/approval-pages.js';
import { setEmailBrand } from './services/email-templates/shared.js';

async function main(): Promise<void> {
  if (config.RUN_MIGRATIONS_ON_BOOT) {
    try {
      await runMigrations();
    } catch (err) {
      logger.error({ err }, 'failed to run migrations on boot');
      process.exit(1);
    }
  }

  const app = await buildApp();

  // Seed the admin-approval HTML pages with the active deployment's
  // brand so the email-triggered approve/reject flow renders the same
  // logo + palette as the portal. Network config is cached, so this is
  // cheap and only runs once.
  try {
    const cfg = await getNetworkConfig();
    setApprovalBrand({
      short_name: cfg.aggregator.brand.short_name,
      long_name: cfg.aggregator.brand.long_name,
      primary_color: cfg.aggregator.brand.primary_color ?? '#4f46e5',
      portal_url: process.env.PUBLIC_PORTAL_URL ?? 'http://localhost:3000',
    });
    setEmailBrand({
      short_name: cfg.aggregator.brand.short_name,
      long_name: cfg.aggregator.brand.long_name,
      primary_color: cfg.aggregator.brand.primary_color ?? '#4f46e5',
    });
  } catch (err) {
    logger.warn({ err }, 'approval brand seed failed — falling back to default');
  }

  const shutdown = (signal: string) => async () => {
    logger.info({ signal }, 'shutting down');
    try {
      // Drain HTTP first, then close every backing connection. The rate-limiter
      // Redis, the shared API Redis, and the BullMQ enqueue queue were all
      // previously leaked on SIGTERM (only Fastify + the PG pool were closed).
      await app.close();
      await closeDb();
      await Promise.allSettled([closeRateLimiter(), closeRedis(), closeBulkQueue()]);
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGINT', shutdown('SIGINT'));
  process.on('SIGTERM', shutdown('SIGTERM'));

  try {
    await app.listen({ host: config.HOST, port: config.PORT });
    logger.info({ host: config.HOST, port: config.PORT }, 'api listening');
  } catch (err) {
    logger.error({ err }, 'failed to start api');
    process.exit(1);
  }
}

void main();
