/**
 * Drizzle Postgres client for the worker process.
 *
 * Singleton pattern. Closes on SIGTERM via the main entrypoint.
 */

import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from '@aggregator-dpg/db-schema/schema';
import { config } from './config.js';

const { Pool } = pg;

let pool: pg.Pool | null = null;
let db: NodePgDatabase<typeof schema> | null = null;

export function getDb(): NodePgDatabase<typeof schema> {
  if (db) return db;
  pool = new Pool({ connectionString: config.DATABASE_URL });
  db = drizzle(pool, { schema });
  return db;
}

export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = null;
  db = null;
}

/**
 * Test helper — inject a fake Drizzle db so unit tests exercise DB-reading
 * code paths without a live Postgres. Pass `null` to reset.
 */
export function _setDb(instance: NodePgDatabase<typeof schema> | null): void {
  db = instance;
}

export { schema };
