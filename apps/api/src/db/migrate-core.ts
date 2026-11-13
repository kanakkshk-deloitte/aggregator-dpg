/**
 * Config-free migration core (`@aggregator-dpg/api`): the locked migration
 * runner and the journal and applied-row readers.
 *
 * Used by the boot path and by the instance-upgrade tool, which applies pending
 * migrations in its own transaction with {@link applyPending}.
 *
 * Imports no config, `.env` or app logger, because the tool runs with only
 * `DATABASE_URL`. The caller passes a logger.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool, PoolClient } from 'pg';

/** Anything that runs a query: a pool or one checked-out connection. */
export type Queryable = Pick<Pool | PoolClient, 'query'>;

/** Journal `when` of the first train migration (0023). */
export const UPGRADE_FIRST_WHEN = 1790600000000;
/** Journal `when` of the last train migration (0029). */
export const UPGRADE_LAST_WHEN = 1791400000000;
/** Journal `when` of 0022, the level every existing instance is at. */
export const PRE_TRAIN_WHEN = 1788400000000;

/** Advisory-lock key shared by every migration runner of this app. */
export const MIGRATION_LOCK_SQL_KEY = "hashtext('aggregator-dpg:migrations')";

/** The two log levels the core uses (pino-compatible). */
export interface MigrationLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
}

/** One journal entry (the fields the guards and the tool need). */
export interface JournalEntry {
  idx?: number;
  when: number;
  tag: string;
}

/** One applied row of `drizzle.__drizzle_migrations`. */
export interface AppliedMigration {
  createdAt: number;
  hash: string;
}

/** Verdict of the foreign-migration check. */
export interface ForeignVerdict {
  /** Applied rows whose `created_at` matches no journal entry. */
  unknown: AppliedMigration[];
  /** Tags whose applied hash differs from the shipped file. */
  hashMismatches: string[];
}

/**
 * Classifies the applied migrations against the shipped journal.
 *
 * @param journal - Shipped entries.
 * @param applied - Rows recorded by drizzle.
 * @param fileHashes - sha256 of each shipped file, keyed by `when`.
 * @returns Unknown rows and hash mismatches.
 */
export function checkForeign(
  journal: JournalEntry[],
  applied: AppliedMigration[],
  fileHashes: Map<number, string>,
): ForeignVerdict {
  const byWhen = new Map(journal.map((e) => [e.when, e]));
  const unknown: AppliedMigration[] = [];
  const hashMismatches: string[] = [];
  for (const row of applied) {
    const entry = byWhen.get(row.createdAt);
    if (!entry) {
      unknown.push(row);
      continue;
    }
    const shipped = fileHashes.get(row.createdAt);
    if (shipped && shipped !== row.hash) hashMismatches.push(entry.tag);
  }
  return { unknown, hashMismatches };
}

/**
 * Reads the shipped journal.
 *
 * @param migrationsFolder - Folder holding the `.sql` files and `meta/_journal.json`.
 * @returns The journal entries, in order.
 */
export async function readJournal(migrationsFolder: string): Promise<JournalEntry[]> {
  const journal = JSON.parse(
    await readFile(path.join(migrationsFolder, 'meta/_journal.json'), 'utf8'),
  ) as { entries: JournalEntry[] };
  return journal.entries;
}

/**
 * Hashes every shipped migration file the way drizzle does (sha256 of the raw
 * file content), keyed by its journal `when`.
 *
 * @param migrationsFolder - Folder holding the `.sql` files.
 * @param entries - The journal entries to hash.
 * @returns `when` → sha256 hex.
 */
export async function shippedFileHashes(
  migrationsFolder: string,
  entries: JournalEntry[],
): Promise<Map<number, string>> {
  return new Map(
    await Promise.all(
      entries.map(async (e): Promise<[number, string]> => {
        const sql = await readFile(path.join(migrationsFolder, `${e.tag}.sql`), 'utf8');
        return [e.when, createHash('sha256').update(sql).digest('hex')];
      }),
    ),
  );
}

/**
 * Reads the applied rows of `drizzle.__drizzle_migrations`.
 *
 * @param pool - Postgres pool or connection.
 * @returns The applied rows, or `null` when the table does not exist yet.
 */
export async function readApplied(pool: Queryable): Promise<AppliedMigration[] | null> {
  const exists = await pool.query<{ t: string | null }>(
    `SELECT to_regclass('drizzle.__drizzle_migrations')::text AS t`,
  );
  if (!exists.rows[0]?.t) return null;
  const rows = await pool.query<{ created_at: string; hash: string }>(
    'SELECT created_at::text AS created_at, hash FROM drizzle.__drizzle_migrations',
  );
  return rows.rows.map((r) => ({ createdAt: Number(r.created_at), hash: r.hash }));
}

/**
 * Applies all pending migrations while holding the migration advisory lock.
 *
 * The lock is always released. Drizzle reads the applied list before its own
 * transaction, so the lock keeps concurrent runners safe. All pending
 * migrations run in one transaction.
 *
 * @param db - Drizzle client the migrations run through.
 * @param pool - Pool the lock connection is taken from (normally the one `db` wraps).
 * @param migrationsFolder - Folder holding the `.sql` files and `meta/_journal.json`.
 * @param log - Logger for the lock milestones.
 */
export async function migrateWithLock<TSchema extends Record<string, unknown>>(
  db: NodePgDatabase<TSchema>,
  pool: Pool,
  migrationsFolder: string,
  log: MigrationLogger,
): Promise<void> {
  const lockClient = await pool.connect();
  let broken: Error | undefined;
  try {
    const started = Date.now();
    try {
      await lockClient.query(`SELECT pg_advisory_lock(${MIGRATION_LOCK_SQL_KEY})`);
    } catch (err) {
      broken = err as Error;
      throw err;
    }
    log.info({ waitedMs: Date.now() - started }, 'migration lock acquired');
    try {
      await migrate(db, { migrationsFolder });
    } finally {
      try {
        await lockClient.query(`SELECT pg_advisory_unlock(${MIGRATION_LOCK_SQL_KEY})`);
      } catch (err) {
        // Discard the connection; the server drops its lock with it.
        broken = err as Error;
        log.warn(
          { error_type: (err as Error).name },
          'migration lock release failed; discarding the connection',
        );
      }
    }
  } finally {
    lockClient.release(broken);
  }
}

/**
 * Applies every migration above the applied high-water mark inside the caller's transaction.
 *
 * Records each in `drizzle.__drizzle_migrations` the same way drizzle does, so
 * a later `migrate()` finds nothing pending. The caller holds the lock and
 * decides commit or rollback.
 *
 * @param client - A connection with an open transaction.
 * @param migrationsFolder - Folder holding the `.sql` files and `meta/_journal.json`.
 * @param onApplied - Called after each migration with its journal `when` and duration.
 * @returns The `when`s applied, in order.
 */
export async function applyPending(
  client: PoolClient,
  migrationsFolder: string,
  onApplied?: (when: number, ms: number) => void,
): Promise<number[]> {
  await client.query('CREATE SCHEMA IF NOT EXISTS drizzle');
  await client.query(
    `CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
       id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`,
  );
  const last = await client.query<{ created_at: string | null }>(
    'SELECT max(created_at)::text AS created_at FROM drizzle.__drizzle_migrations',
  );
  const highWater = Number(last.rows[0]?.created_at ?? 0);
  const applied: number[] = [];
  for (const m of readMigrationFiles({ migrationsFolder })) {
    if (m.folderMillis <= highWater) continue;
    const started = Date.now();
    for (const stmt of m.sql) await client.query(stmt);
    await client.query(
      'INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)',
      [m.hash, m.folderMillis],
    );
    applied.push(m.folderMillis);
    onApplied?.(m.folderMillis, Date.now() - started);
  }
  return applied;
}
