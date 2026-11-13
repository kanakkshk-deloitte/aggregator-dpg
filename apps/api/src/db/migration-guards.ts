/**
 * Pre-migration guards for `runMigrations()` (`@aggregator-dpg/api`).
 *
 * 1. **Foreign migrations.** An applied row whose `created_at` matches no
 *    journal `when` came from a file this release does not ship. Drizzle skips
 *    by the `when` high-water mark, so this is refused (only a warning under
 *    `ALLOW_TRAIN_ON_BOOT=true`). A hash mismatch on a known `when` only warns:
 *    some shipped migrations were edited after their first commit, so real
 *    instances hold older hashes.
 *
 * 2. **The user & org instance upgrade.** Migrations 0023 to
 *    {@link UPGRADE_LAST_WHEN} restructure data; existing instances apply them
 *    with the instance-upgrade tool, with pods at zero, after its pre-flight
 *    and dry-run. At boot or `pnpm db:migrate`, a pending
 *    one on a non-empty database is refused unless `ALLOW_TRAIN_ON_BOOT=true`
 *    (dev / e2e only). An empty database migrates normally.
 *
 * The tool does not go through guard 2.
 */

import type { Pool } from 'pg';
import { logger } from '../logger.js';
import {
  checkForeign,
  readApplied,
  readJournal,
  shippedFileHashes,
  UPGRADE_FIRST_WHEN,
  UPGRADE_LAST_WHEN,
  type AppliedMigration,
  type ForeignVerdict,
  type JournalEntry,
} from './migrate-core.js';

export { checkForeign, UPGRADE_FIRST_WHEN, UPGRADE_LAST_WHEN };
export type { AppliedMigration, ForeignVerdict, JournalEntry };

/**
 * Whether the train guard refuses this migration run.
 *
 * @param journal - Shipped entries.
 * @param appliedWhens - `created_at` of every applied row.
 * @param nonEmpty - Whether the database holds any registration data.
 * @param allowOverride - `ALLOW_TRAIN_ON_BOOT=true`.
 * @returns The pending train tags when refused, else an empty list.
 */
export function upgradeRefusal(
  journal: JournalEntry[],
  appliedWhens: number[],
  nonEmpty: boolean,
  allowOverride: boolean,
): string[] {
  if (!nonEmpty || allowOverride) return [];
  const highWater = appliedWhens.length > 0 ? Math.max(...appliedWhens) : -Infinity;
  return journal
    .filter(
      (e) => e.when > highWater && e.when >= UPGRADE_FIRST_WHEN && e.when <= UPGRADE_LAST_WHEN,
    )
    .map((e) => e.tag);
}

/**
 * Runs both guards against the live database. Throws to stop the migration;
 * logs warnings for hash mismatches and for an override in use.
 *
 * @param pool - Postgres pool.
 * @param migrationsFolder - Folder holding the `.sql` files and `meta/_journal.json`.
 * @param allowTrainOnBoot - Value of `ALLOW_TRAIN_ON_BOOT`.
 * @throws Error when a foreign migration is applied, or the train is pending
 *   on a non-empty database without the override.
 */
export async function runMigrationGuards(
  pool: Pool,
  migrationsFolder: string,
  allowTrainOnBoot: boolean,
): Promise<void> {
  const entries = await readJournal(migrationsFolder);
  const applied = await readApplied(pool);
  if (!applied) return; // brand-new database: nothing applied yet
  const fileHashes = await shippedFileHashes(migrationsFolder, entries);

  const foreign = checkForeign(entries, applied, fileHashes);
  if (foreign.hashMismatches.length > 0) {
    logger.warn(
      { operation: 'migrate.guard', status: 'skipped', tags: foreign.hashMismatches },
      'applied migration differs from the shipped file (edited after release) — continuing',
    );
  }
  // A foreign row above an unrecorded migration makes drizzle skip it.
  // With the override, the warning names the skipped migrations.
  const appliedWhens = new Set(applied.map((a) => a.createdAt));
  const unrecorded = entries.filter((e) => !appliedWhens.has(e.when));
  const highestForeign = Math.max(...foreign.unknown.map((u) => u.createdAt), -Infinity);
  const masked = unrecorded.filter((e) => e.when < highestForeign).map((e) => e.tag);
  if (foreign.unknown.length > 0 && allowTrainOnBoot) {
    logger.warn(
      {
        operation: 'migrate.guard',
        status: 'skipped',
        unknown_created_at: foreign.unknown.map((u) => u.createdAt),
        skipped_by_drizzle: masked,
      },
      'applied migrations not in this release — tolerated because ALLOW_TRAIN_ON_BOOT=true (dev / e2e only)',
    );
  } else if (foreign.unknown.length > 0) {
    throw new Error(
      `refusing to migrate: ${foreign.unknown.length} applied migration(s) are not in this release ` +
        `(created_at ${foreign.unknown.map((u) => u.createdAt).join(', ')}). ` +
        'A dev database that ran abandoned migrations must be recreated.',
    );
  }

  const nonEmpty = await hasRegistrationData(pool);
  const refused = upgradeRefusal(
    entries,
    applied.map((a) => a.createdAt),
    nonEmpty,
    allowTrainOnBoot,
  );
  if (refused.length > 0) {
    throw new Error(
      `refusing to apply the user & org instance upgrade at boot (${refused.join(', ')}) on a ` +
        'database that holds data. Existing instances apply it with the instance-upgrade tool ' +
        '(`node dist/tools/instance-upgrade.js run` from the API image) with pods at zero — see ' +
        'docs/user-org-migration-runbook.md. ' +
        'Dev / e2e only: ALLOW_TRAIN_ON_BOOT=true.',
    );
  }
  if (allowTrainOnBoot && nonEmpty) {
    logger.warn(
      { operation: 'migrate.guard', status: 'skipped' },
      'ALLOW_TRAIN_ON_BOOT=true — the train guard is bypassed (dev / e2e only)',
    );
  }
}

/**
 * Whether the database holds any registration data: a coordinator, an
 * aggregator org other than Default, or an invite. Probes old and new table names.
 *
 * Rows seeded by migrations or boot (root, Default org, their owners) do not count.
 *
 * @param pool - Postgres pool.
 * @returns `true` when any such row exists.
 */
export async function hasRegistrationData(pool: Pool): Promise<boolean> {
  for (const [table, probe] of DATA_PROBES) {
    const exists = await pool.query<{ t: string | null }>('SELECT to_regclass($1)::text AS t', [
      `public.${table}`,
    ]);
    if (!exists.rows[0]?.t) continue;
    const any = await pool.query(probe);
    if (any.rowCount && any.rowCount > 0) return true;
  }
  return false;
}

/** Fixed probe per table (no dynamic SQL). */
const DATA_PROBES: ReadonlyArray<readonly [string, string]> = [
  ['users', "SELECT 1 FROM users WHERE user_type = 'coordinator' LIMIT 1"],
  ['aggregators', 'SELECT 1 FROM aggregators LIMIT 1'],
  ['aggregator_orgs', 'SELECT 1 FROM aggregator_orgs LIMIT 1'],
  [
    'organisations',
    "SELECT 1 FROM organisations WHERE org_type = 'aggregator' AND slug <> 'default' LIMIT 1",
  ],
  ['registration_invites', 'SELECT 1 FROM registration_invites LIMIT 1'],
];
