'use client';

/**
 * Read-only tree of the organisations below an organisation, at any depth.
 *
 * Shown on the organisation page. Rooted at that organisation; each branch can
 * be collapsed. With `linkRows`, names link to each organisation's page; an
 * owner opens an organisation below its own read-only.
 */

import { useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { OrgSearchResponse } from '@aggregator-dpg/shared-primitives/user-org';
import { I } from '../../icons';
import { cn } from '../../lib/cn';
import { ConsoleStatusPill, EmptyState } from './ConsoleUi';

type OrgRow = OrgSearchResponse['orgs'][number];

/** One organisation and the organisations directly below it. */
interface TreeNode {
  org: OrgRow;
  children: TreeNode[];
  /** Organisations below this one, at any depth. */
  below: number;
}

const byName = (a: TreeNode, b: TreeNode) =>
  a.org.name.localeCompare(b.org.name, undefined, { sensitivity: 'base' });

/**
 * Builds the tree under `rootId` from a flat list of descendants.
 *
 * A row whose parent is not in the list is placed directly under the root, so
 * no row is dropped.
 *
 * @param rootId - The organisation the tree hangs from.
 * @param orgs - Its descendants, in any order.
 * @returns The root's direct children, each with its subtree.
 */
export function buildOrgTree(rootId: string, orgs: OrgRow[]): TreeNode[] {
  const ids = new Set(orgs.map((o) => o.id));
  const kids = new Map<string, OrgRow[]>();
  for (const o of orgs) {
    const parent = o.parent_id && ids.has(o.parent_id) ? o.parent_id : rootId;
    kids.set(parent, [...(kids.get(parent) ?? []), o]);
  }
  const seen = new Set<string>();
  const unseen = (o: OrgRow): boolean => {
    if (seen.has(o.id)) return false;
    seen.add(o.id);
    return true;
  };
  const grow = (id: string): TreeNode[] =>
    (kids.get(id) ?? [])
      .filter(unseen)
      .map((org) => {
        const children = grow(org.id);
        const below = children.reduce((n, c) => n + 1 + c.below, 0);
        return { org, children, below };
      })
      .sort(byName);
  return grow(rootId);
}

/** The "known as" name as a small badge; nothing when the org has none. */
function KnownAsBadge({ name }: Readonly<{ name: string | null }>) {
  if (!name) return null;
  return (
    <span className="inline-flex items-center rounded-md bg-[var(--bd-tint-primary)] px-2 py-0.5 text-[12px] font-semibold text-primary-600">
      {name}
    </span>
  );
}

/** One organisation row and, when expanded, its branch. */
function Branch({
  node,
  linkRows,
  last,
}: Readonly<{ node: TreeNode; linkRows: boolean; last: boolean }>) {
  const t = useTranslations('console');
  const [open, setOpen] = useState(true);
  const { org } = node;
  const hasChildren = node.children.length > 0;
  const name = linkRows ? (
    <Link
      className="font-semibold text-primary-600 hover:underline"
      href={`/console/orgs/${org.id}`}
    >
      {org.name}
    </Link>
  ) : (
    <span className="font-semibold text-ink-800">{org.name}</span>
  );
  return (
    <li className={cn('relative pl-7', !last && 'pb-2')}>
      {/* The parent's line down to this row's elbow; it stops at the last sibling. */}
      <span
        aria-hidden
        className={cn(
          'absolute left-0 -top-2 w-px bg-ink-200',
          last ? 'h-[31px]' : 'h-[calc(100%+8px)]',
        )}
      />
      <span aria-hidden className="absolute left-0 top-[22px] h-px w-6 bg-ink-200" />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-ink-100 bg-white px-3 py-2.5 shadow-sm">
        {hasChildren ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={t(open ? 'org.children_collapse' : 'org.children_expand', {
              name: org.name,
            })}
            className="grid h-5 w-5 place-items-center rounded text-ink-400 hover:bg-ink-50 hover:text-ink-700"
          >
            {open ? <I.chevD size={14} /> : <I.chevR size={14} />}
          </button>
        ) : (
          <span aria-hidden className="grid h-5 w-5 place-items-center">
            <span className="h-1.5 w-1.5 rounded-full bg-ink-200" />
          </span>
        )}
        {name}
        <KnownAsBadge name={org.known_as_name ?? org.known_as} />
        {org.depth ? (
          <span className="text-[12px] text-ink-400">{t('org.level', { depth: org.depth })}</span>
        ) : null}
        <ConsoleStatusPill status={org.status} />
        <span className="text-[12.5px] text-ink-500">
          {t('home.coordinators', { count: org.coordinator_count })} ·{' '}
          {t('home.pending', { count: org.pending_count })}
        </span>
        {hasChildren ? (
          <span className="ml-auto text-[12px] text-ink-400">
            {t('org.children_below', { count: node.below })}
          </span>
        ) : null}
      </div>
      {hasChildren && open ? <Level nodes={node.children} linkRows={linkRows} /> : null}
    </li>
  );
}

/** A list of sibling branches, joined by a line on the left. */
function Level({ nodes, linkRows }: Readonly<{ nodes: TreeNode[]; linkRows: boolean }>) {
  return (
    <ul className="relative mt-2 ml-[22px] flex flex-col">
      {nodes.map((n, i) => (
        <Branch key={n.org.id} node={n} linkRows={linkRows} last={i === nodes.length - 1} />
      ))}
    </ul>
  );
}

/**
 * Renders the organisations below an organisation as a tree.
 *
 * @param rootId - The organisation the tree hangs from.
 * @param rootName - Its name.
 * @param rootKnownAs - Its "known as" name, if any.
 * @param rootTag - Note beside the root's name; "This organisation" by default.
 * @param orgs - Its descendants.
 * @param linkRows - Whether names link to each organisation's page.
 * @param more - Whether more organisations exist than are listed.
 */
export function ChildOrgsTree({
  rootId,
  rootName,
  rootKnownAs,
  rootTag,
  orgs,
  linkRows,
  more,
}: Readonly<{
  rootId: string;
  rootName: string;
  rootKnownAs: string | null;
  rootTag?: string;
  orgs: OrgRow[];
  linkRows: boolean;
  more: boolean;
}>): ReactNode {
  const t = useTranslations('console');
  const tree = useMemo(() => buildOrgTree(rootId, orgs), [rootId, orgs]);
  if (tree.length === 0) return <EmptyState>{t('org.children_empty')}</EmptyState>;
  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-ink-100 bg-[var(--bd-tint-primary)] px-3 py-2.5">
        <span className="grid h-5 w-5 place-items-center text-primary-600">
          <I.briefcase size={15} />
        </span>
        <span className="font-semibold text-ink-900">{rootName}</span>
        <KnownAsBadge name={rootKnownAs} />
        <span className="text-[12px] text-ink-500">{rootTag ?? t('org.children_this')}</span>
        <span className="ml-auto text-[12px] text-ink-500">
          {t('org.children_below', { count: orgs.length })}
        </span>
      </div>
      <Level nodes={tree} linkRows={linkRows} />
      {more ? <p className="mt-3 text-[12.5px] text-ink-500">{t('org.children_more')}</p> : null}
    </div>
  );
}
