/**
 * Pure logic of the instance-upgrade tool (`@aggregator-dpg/api`): where a
 * database stands relative to the upgrade.
 *
 * The tool takes a database at 0022, or part-way through the upgrade, to the
 * latest shipped migration. Any other level is refused.
 */

import { PRE_TRAIN_WHEN, type AppliedMigration, type JournalEntry } from '../db/migrate-core.js';

/**
 * Where a database stands relative to the upgrade.
 *
 * `start`: exactly 0022. `partial`: a shipped migration after 0022, short of
 * the latest. `done`: the latest. `fresh`: nothing applied. `other`: below
 * 0022 or not shipped; refused.
 */
export type UpgradeState = 'start' | 'partial' | 'done' | 'fresh' | 'other';

/** The applied level and what is pending. */
export interface UpgradeLevel {
  state: UpgradeState;
  /** Tag of the highest applied migration, or `null` (none, or not shipped). */
  appliedTag: string | null;
  /** Tags of the shipped migrations above the applied high-water mark. */
  pending: string[];
}

/**
 * Classifies the applied migrations against the shipped journal.
 *
 * @param journal - Shipped entries, in order.
 * @param applied - Applied rows (`null` / empty when nothing is applied).
 * @returns The state, the applied tag and the pending tags.
 */
export function upgradeLevel(
  journal: readonly JournalEntry[],
  applied: readonly AppliedMigration[] | null,
): UpgradeLevel {
  if (!applied || applied.length === 0) {
    return { state: 'fresh', appliedTag: null, pending: journal.map((e) => e.tag) };
  }
  const highWater = Math.max(...applied.map((a) => a.createdAt));
  const appliedTag = journal.find((e) => e.when === highWater)?.tag ?? null;
  const pending = journal.filter((e) => e.when > highWater).map((e) => e.tag);
  const latest = journal.at(-1)?.when;
  let state: UpgradeState = 'other';
  if (highWater === PRE_TRAIN_WHEN) state = 'start';
  else if (highWater === latest) state = 'done';
  else if (appliedTag !== null && highWater > PRE_TRAIN_WHEN) state = 'partial';
  return { state, appliedTag, pending };
}
