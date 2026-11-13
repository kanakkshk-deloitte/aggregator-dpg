/**
 * "Known as" values and tree rules (`@aggregator-dpg/api`).
 *
 * Each org defines the "known as" values of its direct children
 * (`known_as_values`). A child stores the key of one entry, or the built-in
 * `aggregator`. Both organisation stores and the console routes use these
 * helpers, so they resolve names and defaults the same way. The choices for a
 * child come from `knownAsChoices` in `@aggregator-dpg/shared-primitives/user-org`,
 * which the console uses too.
 */

import anyAscii from 'any-ascii';
import type { OrganisationConfig } from '@aggregator-dpg/network-config/interface';
import {
  SYSTEM_KNOWN_AS,
  type KnownAsValues,
  type KnownAsValuesRequest,
  type KnownAsEntry,
} from '@aggregator-dpg/shared-primitives/user-org';
import type { TreeRules } from './organisation-store/interface.js';

/** Longest generated key; matches `KnownAsKeySchema`. */
const KEY_MAX = 64;

/**
 * The store's tree limits for the instance.
 *
 * @param org - The instance's `organisation` config.
 * @returns The limits; `maxChildren` is `null` when unset.
 */
export function treeRules(org: OrganisationConfig): TreeRules {
  return {
    maxDepth: org.hierarchy.max_depth,
    maxChildren: org.hierarchy.max_children ?? null,
    maxTotalOrgs: org.hierarchy.max_total_orgs,
  };
}

/**
 * The key a new child of an org gets, and the key a child falls back to when
 * its value leaves the parent's list.
 *
 * @param list - The parent's `known_as_values` list.
 * @returns The key of the default entry, else `aggregator`.
 */
export function defaultKnownAsKey(list: readonly KnownAsEntry[]): string {
  return list.find((e) => e.default)?.key ?? SYSTEM_KNOWN_AS.key;
}

/**
 * The name of a child's "known as" value.
 *
 * The parent's entry for the key wins, `aggregator` included. A key the list
 * does not have reads as "Aggregator", so a read never fails.
 *
 * @param parentList - The parent's `known_as_values` list.
 * @param key - The child's stored key.
 * @returns The name.
 */
export function knownAsNameOf(parentList: readonly KnownAsEntry[], key: string): string {
  return parentList.find((e) => e.key === key)?.name ?? SYSTEM_KNOWN_AS.name;
}

/**
 * Whether a child may keep `key` under a parent with `list`: the key is in
 * the list, or it is `aggregator`.
 *
 * @param list - The parent's `known_as_values` list.
 * @param key - The child's stored key.
 * @returns True when the key needs no reset.
 */
export function knownAsKeyValid(list: readonly KnownAsEntry[], key: string): boolean {
  return key === SYSTEM_KNOWN_AS.key || list.some((e) => e.key === key);
}

/**
 * Makes a key from a name.
 *
 * The name is transliterated to Latin and lower-cased. Apostrophes from the
 * transliteration are dropped, and every run of other characters becomes `_`.
 * A key that starts with a digit gets `v_` in front. The key is cut to 64
 * characters. An empty result becomes `value_<n>`. A key already taken gets
 * `_2`, `_3`, and so on.
 *
 * @param name - The entry's name.
 * @param taken - Keys already used in the list.
 * @returns A key that matches `KnownAsKeySchema` and is not in `taken`.
 */
export function knownAsKeyFrom(name: string, taken: ReadonlySet<string>): string {
  let base = anyAscii(name)
    .toLowerCase()
    .replace(/['`]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (/^\d/.test(base)) base = `v_${base}`;
  base = cut(base, KEY_MAX);
  if (base === '') {
    let n = 1;
    while (taken.has(`value_${n}`)) n += 1;
    return `value_${n}`;
  }
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `_${n}`;
    const key = `${cut(base, KEY_MAX - suffix.length)}${suffix}`;
    if (!taken.has(key)) return key;
  }
}

/** Cuts a key to `max` characters and drops trailing underscores. */
function cut(key: string, max: number): string {
  return key.slice(0, max).replace(/_+$/, '');
}

/** Outcome of {@link fillKnownAsKeys}. */
export type FillKnownAsKeysResult =
  { ok: true; value: KnownAsValues } | { ok: false; error: { code: 'UNKNOWN_KEY'; index: number } };

/**
 * Turns a requested `known_as_values` list into the list to store.
 *
 * An entry that sends a key keeps it; the key must already be in the org's
 * list, so a client cannot choose keys. An entry with no key gets one made
 * from its name ({@link knownAsKeyFrom}). A made key is never one of the
 * current keys, even one this save drops, so children that held a dropped key
 * are reset rather than matched to a new entry. A made key is never
 * `aggregator`, because every child may hold that key.
 *
 * @param values - The requested list. Given keys are unique (checked by the schema).
 * @param current - The org's stored `known_as_values` list.
 * @returns The list with every key set; `UNKNOWN_KEY` names the first entry
 *   whose key is not in `current`.
 */
export function fillKnownAsKeys(
  values: KnownAsValuesRequest,
  current: readonly KnownAsEntry[],
): FillKnownAsKeysResult {
  const known = new Set(current.map((e) => e.key));
  for (const [index, entry] of values.entries()) {
    if (entry.key !== undefined && !known.has(entry.key)) {
      return { ok: false, error: { code: 'UNKNOWN_KEY', index } };
    }
  }
  const taken = new Set([...known, SYSTEM_KNOWN_AS.key]);
  const out: KnownAsValues = values.map((entry) => {
    const key = entry.key ?? knownAsKeyFrom(entry.name, taken);
    taken.add(key);
    return entry.default ? { key, name: entry.name, default: true } : { key, name: entry.name };
  });
  return { ok: true, value: out };
}
