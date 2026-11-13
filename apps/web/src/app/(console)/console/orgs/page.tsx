/**
 * Organisations page.
 *
 * An org owner sees the organisations directly under its own awaiting its
 * decision (approved or rejected in place), then each of its organisations
 * with the ones directly under it and, closed by default, its hierarchy
 * settings.
 *
 * The network admin sees the organisations directly under the network: those
 * awaiting approval, status tiles, a searchable list (each name opens the
 * organisation's page) and, closed by default, the hierarchy settings.
 * `?status=` opens the list with a filter.
 */

import { Fragment } from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type {
  KnownAsValues,
  OrgHierarchyResponse,
  OrgReadResponse,
  OrgSearchResponse,
} from '@aggregator-dpg/shared-primitives/user-org';
import { getConsoleActor } from '@/lib/console-actor';
import { consoleRead } from '@/lib/console-api.server';
import { readNetworkOrgs, readReachableOrgs } from '@/lib/console-hierarchy.server';
import { orgsBelow, topmostOwned } from '@/lib/console-org-options';
import { OrgsTable } from '@/components/console/OrgsTable';
import { HierarchySettings } from '@/components/console/HierarchySettings';
import { ChildOrgsTree } from '@/components/console/ChildOrgsTree';
import { NetworkOrgsView } from '@/components/console/NetworkOrgsView';
import { ORG_FILTERS, type OrgFilter } from '@/lib/org-filters';
import { ConsoleSection, EmptyState } from '@/components/console/ConsoleUi';
import { Topbar } from '@/components/shell/Topbar';
import { buttonClass } from '@/components/ui/button-class';
import { I } from '@/icons';

type OrgRow = OrgSearchResponse['orgs'][number];

export default async function ConsoleOrgsPage({
  searchParams,
}: Readonly<{ searchParams: Promise<{ status?: string }> }>) {
  const t = await getTranslations('console');
  const params = await searchParams;
  const initialFilter: OrgFilter = ORG_FILTERS.find((f) => f === params.status) ?? 'all';
  const actor = await getConsoleActor();
  if (!actor.ok) return null;
  if (!actor.me.is_network_admin) {
    return (
      <OwnerOrgs
        ownedIds={actor.me.orgs.map((o) => o.id)}
        ownerIds={actor.me.orgs.filter((o) => o.role === 'owner').map((o) => o.id)}
      />
    );
  }
  const hierarchy = await consoleRead<OrgHierarchyResponse>(
    '/v1/org/hierarchy?fields=known_as_values',
  );
  const network = await readNetworkOrgs(hierarchy.network.id);
  const pending = network.orgs.filter((o) => o.status === 'pending');
  return (
    <>
      <Topbar title={t('orgs.heading')} subtitle={t('orgs.subtitle')} />
      <div className="flex flex-col gap-6">
        {pendingReview(pending, t)}
        <NetworkOrgsView
          rootName={hierarchy.network.name}
          orgs={network.orgs}
          more={network.more}
          initialFilter={initialFilter}
        />
        <HierarchySettings
          orgId={hierarchy.network.id}
          orgName={hierarchy.network.name}
          values={hierarchy.network.known_as_values ?? []}
        />
      </div>
    </>
  );
}

/**
 * An owner's view: the pending organisations directly under its own, then one
 * section per topmost owned organisation with the organisations directly under
 * it and the "known as" values it defines for them.
 *
 * @param ownedIds - The organisations the viewer belongs to.
 * @param ownerIds - Those it owns, the only ones whose values it can edit.
 */
async function OwnerOrgs({
  ownedIds,
  ownerIds,
}: Readonly<{ ownedIds: string[]; ownerIds: string[] }>) {
  const t = await getTranslations('console');
  const orgs = await readReachableOrgs();
  const roots = topmostOwned(ownedIds, orgs);
  if (roots.length === 0) redirect('/console');
  const valuesById = new Map(
    await Promise.all(
      roots.map(async (root) => [root.id, await knownAsValuesToEdit(root, ownerIds)] as const),
    ),
  );
  const pending = orgs.filter((o) => o.status === 'pending' && !ownedIds.includes(o.id));
  return (
    <>
      <Topbar title={t('orgs.heading')} subtitle={t('orgs.subtitle_owner')} />
      <div className="flex flex-col gap-6">
        {pendingReview(pending, t)}
        {roots.map((root) => (
          <Fragment key={root.id}>
            <ConsoleSection
              title={root.name}
              action={
                <Link className={buttonClass('soft')} href={`/console/orgs/${root.id}`}>
                  {t('orgs.manage')}
                  <I.arrowR size={15} />
                </Link>
              }
            >
              <ChildOrgsTree
                rootId={root.id}
                rootName={root.name}
                rootKnownAs={root.known_as_name ?? root.known_as}
                rootTag={t('orgs.yours')}
                orgs={orgsBelow(root.id, orgs)}
                linkRows
                more={false}
              />
            </ConsoleSection>
            {valuesById.get(root.id) ? (
              <HierarchySettings
                orgId={root.id}
                orgName={root.name}
                values={valuesById.get(root.id) ?? []}
              />
            ) : null}
          </Fragment>
        ))}
      </div>
    </>
  );
}

/**
 * The "known as" values an owned organisation defines for its children, when
 * the viewer can edit them: it owns the org, the org is active, and the org can
 * have child organisations (the API sends null otherwise).
 *
 * @param root - The owned organisation.
 * @param ownerIds - The organisations the viewer owns.
 */
async function knownAsValuesToEdit(
  root: OrgRow,
  ownerIds: readonly string[],
): Promise<KnownAsValues | null> {
  if (!ownerIds.includes(root.id) || root.status !== 'active') return null;
  const read = await consoleRead<OrgReadResponse>(
    `/v1/org/read/${encodeURIComponent(root.id)}?fields=known_as_values`,
  );
  return read.org.known_as_values ?? null;
}

/**
 * The organisations waiting for the viewer's decision. Shown even when empty,
 * so the viewer knows where new registrations under its organisations appear.
 *
 * @param pending - The pending organisations the viewer decides.
 * @param t - The console translator.
 */
function pendingReview(
  pending: OrgRow[],
  t: Awaited<ReturnType<typeof getTranslations<'console'>>>,
) {
  return (
    <div id="pending" className="scroll-mt-6">
      <ConsoleSection title={t('orgs.review_heading', { count: pending.length })} flush>
        {pending.length > 0 ? (
          <OrgsTable orgs={pending} />
        ) : (
          <EmptyState>
            {t('orgs.empty_pending')} {t('orgs.review_hint')}
          </EmptyState>
        )}
      </ConsoleSection>
    </div>
  );
}
