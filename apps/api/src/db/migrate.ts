/**
 * Migration runner for the api app.
 *
 * `pnpm --filter @aggregator-dpg/api db:migrate` applies the Drizzle migrations
 * in `drizzle/migrations/`. Safe to run repeatedly. Startup also calls
 * `runMigrations()` before `app.listen()`.
 *
 * Concurrent runners are serialised on an advisory lock, so two replicas never
 * apply the same migration.
 */

import '../env.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { closeDb, getDb, getPool } from './client.js';
import { logger } from '../logger.js';
import { runMigrationGuards } from './migration-guards.js';
import { MIGRATION_LOCK_SQL_KEY, migrateWithLock as migrateWithLockCore } from './migrate-core.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export { MIGRATION_LOCK_SQL_KEY };

/**
 * Applies all pending migrations in `migrationsFolder` under the migration
 * advisory lock (`migrate-core.ts`), logging through the app logger.
 *
 * @param db - Drizzle client the migrations run through.
 * @param pool - Pool the lock connection is taken from (normally the one `db` wraps).
 * @param migrationsFolder - Folder holding the `.sql` files and `meta/_journal.json`.
 */
export async function migrateWithLock<TSchema extends Record<string, unknown>>(
  db: NodePgDatabase<TSchema>,
  pool: Pool,
  migrationsFolder: string,
): Promise<void> {
  await migrateWithLockCore(db, pool, migrationsFolder, logger);
}

/**
 * Applies all pending migrations under the migration advisory lock, after the
 * pre-migration guards (`migration-guards.ts`).
 */
export async function runMigrations(): Promise<void> {
  const migrationsFolder = path.resolve(__dirname, '../../drizzle/migrations');
  logger.info({ migrationsFolder }, 'running database migrations');
  // Refuse foreign migrations, and the instance upgrade on a database with data.
  await runMigrationGuards(getPool(), migrationsFolder, process.env.ALLOW_TRAIN_ON_BOOT === 'true');
  await migrateWithLock(getDb(), getPool(), migrationsFolder);
  logger.info('database migrations applied');
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  try {
    await runMigrations();
    await closeDb();
    process.exit(0);
  } catch (err: unknown) {
    logger.error({ err }, 'migration failed');
    await closeDb().catch(() => undefined);
    process.exit(1);
  }
}
