/**
 * Shared Postgres pool and Drizzle client for the api app.
 *
 * One `pg.Pool` per process, created on first use. `closeDb()` closes it on shutdown.
 */

import { createRequire } from 'node:module';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as PgModule from 'pg';
import { ConfigError } from '@aggregator-dpg/shared-primitives/errors';
import * as schema from './schema.js';

const require = createRequire(import.meta.url);
// pg is CommonJS; load it with createRequire to avoid ESM interop issues.
const { Pool } = require('pg') as typeof PgModule;

type Pool = InstanceType<typeof Pool>;

let pool: Pool | null = null;
let db: NodePgDatabase<typeof schema> | null = null;
let closing = false;

interface PoolOptions {
  /** Override the connection string. Falls back to the `DATABASE_URL` env var. */
  url?: string;
  /** Maximum pool size. Default 10. */
  max?: number;
  /** Idle timeout in ms before a connection is closed. Default 10_000. */
  idleTimeoutMs?: number;
  /** Connection timeout in ms. Default 5_000. */
  connectionTimeoutMs?: number;
}

/**
 * Returns the shared `pg.Pool`. Creates it on first call.
 *
 * The connection string has no default, since it carries credentials.
 *
 * @param opts - Pool overrides; `url` takes precedence over `DATABASE_URL`.
 * @returns Shared connection pool.
 * @throws {ConfigError} If neither `opts.url` nor `DATABASE_URL` is set.
 */
export function getPool(opts: PoolOptions = {}): Pool {
  if (pool && !closing) return pool;
  if (closing) throw new Error('Postgres pool is shutting down');
  const connectionString = opts.url ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new ConfigError('DATABASE_URL is not set; refusing to start without a database URL.', {
      code: 'DATABASE_URL_MISSING',
    });
  }
  pool = new Pool({
    connectionString,
    max: opts.max ?? 10,
    idleTimeoutMillis: opts.idleTimeoutMs ?? 10_000,
    connectionTimeoutMillis: opts.connectionTimeoutMs ?? 5_000,
  });
  return pool;
}

/**
 * Returns the shared Drizzle ORM client.
 *
 * @returns Drizzle client bound to the shared pool, with full schema typing.
 */
export function getDb(): NodePgDatabase<typeof schema> {
  if (db) return db;
  db = drizzle(getPool(), { schema });
  return db;
}

/**
 * Closes the shared pool. Idempotent. Call from process shutdown handlers.
 */
export async function closeDb(): Promise<void> {
  if (!pool) return;
  closing = true;
  try {
    await pool.end();
  } finally {
    pool = null;
    db = null;
    closing = false;
  }
}

/**
 * Test-only — replace the singleton clients with custom instances.
 */
export function _setDbClients(
  customPool: Pool | null,
  customDb: NodePgDatabase<typeof schema> | null,
): void {
  pool = customPool;
  db = customDb;
}

export { schema };
