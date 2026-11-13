/**
 * Organisation choices for console filters (`apps/web`): the organisations a
 * viewer can reach, in tree order, each labelled with its path and "known as"
 * value, e.g. "Karnataka › Mysuru (District)".
 *
 * @module apps/web/src/lib/console-org-options
 */

import type { OrgSearchResponse } from '@aggregator-dpg/shared-primitives/user-org';

type OrgRow = OrgSearchResponse['orgs'][number];

/** One choice in an organisation filter. */
export interface OrgOption {
  id: string;
  /** The org's own name. */
  name: string;
  /** Path from the topmost listed ancestor, with the "known as" name. */
  label: string;
}

/** One organisation in tree order, with its path and level. */
export interface OrgTreeEntry {
  org: OrgRow;
  /** Names from the topmost listed ancestor down to this org. */
  path: string[];
  /** 0 for a topmost listed org, then 1, 2, … below it. */
  level: number;
  /** The last of its siblings. */
  last: boolean;
  /** For each ancestor level, whether that ancestor has later siblings (its line continues). */
  continues: boolean[];
}

/**
 * Orders orgs as their tree: parents before children, siblings by name.
 *
 * An org whose parent is not in the list starts a path of its own, so every
 * org appears once.
 *
 * @param orgs - The orgs, in any order.
 * @returns Each org with its path and level, in tree order.
 */
export function orgsInTreeOrder(orgs: readonly OrgRow[]): OrgTreeEntry[] {
  const ids = new Set(orgs.map((o) => o.id));
  const byParent = new Map<string | null, OrgRow[]>();
  for (const o of orgs) {
    const parent = o.parent_id && ids.has(o.parent_id) ? o.parent_id : null;
    byParent.set(parent, [...(byParent.get(parent) ?? []), o]);
  }
  const out: OrgTreeEntry[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, path: string[], continues: boolean[]) => {
    const kids = [...(byParent.get(parent) ?? [])]
      .filter((o) => !seen.has(o.id))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    kids.forEach((o, i) => {
      if (seen.has(o.id)) return;
      seen.add(o.id);
      const last = i === kids.length - 1;
      const names = [...path, o.name];
      out.push({ org: o, path: names, level: path.length, last, continues });
      walk(o.id, names, [...continues, !last]);
    });
  };
  walk(null, [], []);
  return out;
}

/**
 * Orders orgs as their tree (parents before children, siblings by name) and
 * labels each with its path.
 *
 * @param orgs - The reachable orgs, in any order.
 * @returns The options in tree order.
 */
export function orgOptionsInTreeOrder(orgs: readonly OrgRow[]): OrgOption[] {
  return orgsInTreeOrder(orgs).map(({ org, path }) => {
    const knownAs = org.known_as_name ?? org.known_as;
    const suffix = knownAs ? ` (${knownAs})` : '';
    return {
      id: org.id,
      name: org.name,
      label: `${path.join(' › ')}${suffix}`,
    };
  });
}

/**
 * The orgs below one org, at any depth, from a flat list.
 *
 * @param rootId - The org to look below.
 * @param orgs - Orgs with their `parent_id`, in any order.
 * @returns The descendants, the root itself excluded.
 */
export function orgsBelow(rootId: string, orgs: readonly OrgRow[]): OrgRow[] {
  const below = new Set<string>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const o of orgs) {
      if (o.parent_id && below.has(o.parent_id) && !below.has(o.id)) {
        below.add(o.id);
        grew = true;
      }
    }
  }
  return orgs.filter((o) => o.id !== rootId && below.has(o.id));
}

/**
 * The owned orgs that sit under no other owned org: the roots of an owner's trees.
 *
 * @param ownedIds - The orgs the viewer owns.
 * @param orgs - The orgs the viewer reaches, with their `parent_id`.
 * @returns The topmost owned orgs, by name.
 */
export function topmostOwned(ownedIds: readonly string[], orgs: readonly OrgRow[]): OrgRow[] {
  const owned = orgs.filter((o) => ownedIds.includes(o.id));
  const nested = new Set(owned.flatMap((o) => orgsBelow(o.id, orgs).map((d) => d.id)));
  return owned
    .filter((o) => !nested.has(o.id))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}
