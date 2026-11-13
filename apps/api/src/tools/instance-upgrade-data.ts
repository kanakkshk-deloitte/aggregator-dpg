/**
 * Standalone data migrations for the instance-upgrade tool (`@aggregator-dpg/api`).
 *
 * The upgrade has three layers:
 *
 *   1. Schema: DDL and the DML coupled to it. Lives in the drizzle migrations;
 *      `run` applies it in one transaction.
 *   2. Standalone data: data moves with no ordering dependency on a DDL step.
 *      Lives here; `instance-upgrade data` applies it after `run`.
 *   3. External dependencies (Keycloak): the online step (`enrich` / `enable-owners`).
 *
 * A step must be idempotent and config-free (database only). Register new
 * steps in {@link DATA_STEPS}.
 */

import type pg from 'pg';

/** One standalone, idempotent, DB-only data migration. */
export interface DataStep {
  /** Stable id for the log and the runbook. */
  name: string;
  /** Applies the data change inside the shared transaction. Must be idempotent. */
  apply(client: pg.PoolClient): Promise<void>;
  /**
   * Optional post-apply check that returns the count of rows still wrong.
   * Non-zero rolls the whole `data` run back.
   */
  verify?(client: pg.PoolClient): Promise<number>;
}

/** The standalone data migrations for this release. Currently empty. */
export const DATA_STEPS: DataStep[] = [];

/** Line printer (matches the tool's `out`). */
type Out = (line: string) => void;

/**
 * Applies every standalone data step in one transaction and commits only when all verify.
 *
 * `--dry-run` always rolls back. An empty list is a no-op. Never throws.
 *
 * @param pool - A database pool (config-free; only `DATABASE_URL`).
 * @param steps - The steps to run (defaults to {@link DATA_STEPS}).
 * @param opts - `dryRun` rolls back at the end.
 * @param out - Line printer; counts and step names only, never row data.
 * @returns Exit code: 0 on success / no-op, 1 on a failed step or verify.
 */
export async function runDataSteps(
  pool: pg.Pool,
  steps: DataStep[],
  opts: { dryRun: boolean },
  out: Out,
): Promise<number> {
  if (steps.length === 0) {
    out('data: no standalone data steps in this release');
    return 0;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const step of steps) {
      await step.apply(client);
      const bad = step.verify ? await step.verify(client) : 0;
      const verifyNote = step.verify ? `, verify_bad=${bad}` : '';
      out(`data: ${step.name} applied${verifyNote}`);
      if (bad > 0) {
        await client.query('ROLLBACK');
        out(`data: ${step.name} verify failed (${bad}) — rolled back, nothing applied`);
        return 1;
      }
    }
    if (opts.dryRun) {
      await client.query('ROLLBACK');
      out('data: DRY RUN — all steps applied and verified, then rolled back');
    } else {
      await client.query('COMMIT');
      out(`data: COMMITTED ${steps.length} step(s)`);
    }
    return 0;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    const code = (err as { code?: string }).code;
    const codeNote = code ? ` (${code})` : '';
    out(`data: FAILED — rolled back${codeNote}`);
    return 1;
  } finally {
    client.release();
  }
}
