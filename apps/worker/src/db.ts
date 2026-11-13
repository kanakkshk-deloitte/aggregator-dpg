/**
 * Drizzle Postgres client for the worker app.
 *
 * Singleton; closed on shutdown by the entrypoint.
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
 * Replaces the Drizzle db, for tests. Pass `null` to reset.
 */
export function _setDb(instance: NodePgDatabase<typeof schema> | null): void {
  db = instance;
}

export { schema };
