/**
 * Organisation detail page: owner, place in the tree, counts and the details form.
 *
 * The Default org and the root are read-only. Only the org's owner edits its
 * details, the name included; the network admin sees them read-only. The owner
 * of the parent org sets the org's "known as" value; the org's owner defines
 * the values for the organisations under it. Only the network admin can
 * re-grant an active org's owner access or move it under another parent. An
 * owner approves its child orgs by default, so no role is assigned here. An
 * owner also views, read-only, the organisations directly under its own, and
 * approves or rejects one that is pending; the
 * coordinators of such an organisation stay with its own owner. The
 * organisations directly under an aggregator org are listed read-only.
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { Building2, CalendarDays, Clock, Layers, Network, Users } from 'lucide-react';
import type {
  OrgHierarchyResponse,
  OrgReadResponse,
} from '@aggregator-dpg/shared-primitives/user-org';
import { getConsoleActor } from '@/lib/console-actor';
import { consoleRead } from '@/lib/console-api.server';
import { isUuid } from '@/lib/console-proxy';
import { Topbar } from '@/components/shell/Topbar';
import { buttonClass } from '@/components/ui/button-class';
import { BackLink, ConsoleSection, ConsoleStatusPill } from '@/components/console/ConsoleUi';
import { CountTile } from '@/components/console/CountTile';
import { CopyButton } from '@/components/console/CopyButton';
import { initialsOf } from '@/lib/initials';
import { I } from '@/icons';
import { OrgEditForm } from '@/components/console/OrgEditForm';
import { KnownAsPicker } from '@/components/console/KnownAsPicker';
import { OrgMoveDialog } from '@/components/console/OrgMoveDialog';
import { OrgsTable } from '@/components/console/OrgsTable';
import { OwnerAccessRepair } from '@/components/console/OwnerAccessRepair';
import { can, canViewCoordinators } from '@/lib/capabilities';
import { loadOrgSchema } from '@/lib/org-schema.server';

type Translate = Awaited<ReturnType<typeof getTranslations<'console'>>>;
type Format = Awaited<ReturnType<typeof getFormatter>>;
type Me = Extract<Awaited<ReturnType<typeof getConsoleActor>>, { ok: true }>['me'];
type OrgData = OrgReadResponse;

/**
 * What the viewer may see and do on this organisation's page.
 *
 * @param me - The signed-in viewer.
 * @param data - The org read, with `fields=parent.known_as_values`.
 */
function orgPageAccess(me: Me, data: OrgData) {
  const { org, owner } = data;
  const aggregatorOrg = org.org_type === 'aggregator' && !org.is_default;
  // An owner also views, read-only, the orgs directly under its own.
  const own = me.orgs.some((o) => o.id === org.id);
  // The parent and its list; null when the viewer cannot set this org's value.
  const parent = aggregatorOrg ? (org.parent ?? null) : null;
  return {
    own,
    aggregatorOrg,
    parent,
    // The org's users, for its owner; the network admin has no users page.
    showUsers: own && canViewCoordinators(me),
    editable: aggregatorOrg && own,
    canRename: me.is_network_admin && can(me.capabilities, 'network.administer'),
    isOwner: owner.id === me.user.id,
    // The API sends `parent` only to the parent's owner, the one who repairs access.
    canRepair: parent !== null && org.status === 'active',
    // The Default org and the root never move; only pending and active orgs can.
    movable: aggregatorOrg && (org.status === 'pending' || org.status === 'active'),
    decidable: !own && aggregatorOrg && org.status === 'pending',
  };
}

export default async function ConsoleOrgPage({
  params,
}: Readonly<{ params: Promise<{ id: string }> }>) {
  const t = await getTranslations('console');
  const format = await getFormatter();
  const actor = await getConsoleActor();
  if (!actor.ok) return null;
  const { id } = await params;
  // Ids are UUIDs; anything else cannot exist, so it is a missing page, not an error.
  if (!isUuid(id)) notFound();
  const data = await consoleRead<OrgReadResponse>(
    `/v1/org/read/${encodeURIComponent(id)}?fields=parent.known_as_values`,
  );
  const { org } = data;
  const access = orgPageAccess(actor.me, data);
  const orgSchema = await loadOrgSchema();
  // Tree limits; only the network admin can read them.
  const hierarchy = access.canRename
    ? await consoleRead<OrgHierarchyResponse>('/v1/org/hierarchy')
    : null;
  const canMove = hierarchy !== null && access.movable;
  return (
    <>
      <div>
        <BackLink href="/console/orgs">{t('orgs.heading')}</BackLink>
        <Topbar
          right={topbarActions(data, canMove, access.showUsers, t)}
          leading={
            <span
              aria-hidden="true"
              className="grid h-14 w-14 flex-none place-items-center rounded-[14px] bg-(--bd-primary-50) text-(--bd-primary-600)"
            >
              <Building2 size={26} />
            </span>
          }
          title={
            <span className="flex flex-wrap items-center gap-3">
              {org.name}
              <ConsoleStatusPill status={org.status} />
              {(org.known_as_name ?? org.known_as) ? (
                <span className="rounded-full bg-(--bd-primary-50) px-2.5 py-0.5 text-[12px] font-semibold text-(--bd-primary-600)">
                  {org.known_as_name ?? org.known_as}
                </span>
              ) : null}
            </span>
          }
          subtitle={orgSubtitle(data, t, format)}
        />
      </div>
      <div className="flex flex-col gap-6">
        {access.decidable ? (
          <ConsoleSection title={t('orgs.review_heading', { count: 1 })} flush>
            <OrgsTable
              orgs={[
                {
                  ...org,
                  coordinator_count: data.coordinator_count,
                  child_count: data.child_count,
                  pending_count: data.pending_count,
                },
              ]}
            />
          </ConsoleSection>
        ) : null}
        {ownerCard(data, access.canRepair, t)}
        {orgTiles(data, access, hierarchy?.limits.max_children ?? null, t)}
        {access.parent ? (
          <ConsoleSection title={t('org.known_as_pick_title')}>
            <KnownAsPicker org={org} parentValues={access.parent.known_as_values} />
          </ConsoleSection>
        ) : null}
        <OrgEditForm
          org={org}
          editable={access.editable}
          canEdit={access.isOwner}
          orgSchema={orgSchema}
          knownAsPicked={access.parent !== null}
        />
      </div>
    </>
  );
}

/** The Move button and the link to the org's users, for an aggregator org. */
function topbarActions(data: OrgData, canMove: boolean, showUsers: boolean, t: Translate) {
  const { org } = data;
  if (org.org_type !== 'aggregator') return null;
  return (
    <>
      {canMove ? (
        <OrgMoveDialog orgId={org.id} orgName={org.name} parentId={org.parent_id} />
      ) : null}
      {showUsers ? (
        <Link className={buttonClass('soft')} href={`/console/coordinators?org_id=${org.id}`}>
          <I.users size={15} />
          {t('org.view_coordinators')}
        </Link>
      ) : null}
    </>
  );
}

/** The parent, level and created date under the title. */
function orgSubtitle(data: OrgData, t: Translate, format: Format) {
  const { org } = data;
  return (
    <span className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[13.5px] text-ink-500">
      {org.org_type === 'aggregator' && org.parent_name ? (
        <span className="inline-flex items-center gap-1.5">
          <Network size={15} aria-hidden="true" />
          {t('org.under', { parent: org.parent_name })}
        </span>
      ) : null}
      <span className="inline-flex items-center gap-1.5">
        <Layers size={15} aria-hidden="true" />
        {t('org.level', { depth: org.depth })}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <CalendarDays size={15} aria-hidden="true" />
        {t('org.created', {
          date: format.dateTime(new Date(org.created_at), {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
          }),
        })}
      </span>
    </span>
  );
}

/** The owner's name and email, with access repair for the parent's owner. */
function ownerCard(data: OrgData, canRepair: boolean, t: Translate) {
  const { org, owner } = data;
  const label = owner.contact.name ?? owner.contact.email;
  return (
    <section className="bd-card bd-shadow overflow-hidden">
      <div className="flex flex-wrap items-center gap-3.5 px-[22px] py-5">
        <span
          aria-hidden="true"
          className="grid h-10 w-10 flex-none place-items-center rounded-full bg-(--bd-primary-50) text-[13px] font-bold text-(--bd-primary-600)"
        >
          {initialsOf(label)}
        </span>
        <div className="min-w-0">
          <div className="text-[12px] font-semibold text-ink-500">{t('org.owner')}</div>
          <div className="truncate font-bold text-ink-900">{label}</div>
          <div className="flex items-center gap-1 text-[12.5px] text-ink-500">
            <span className="truncate">{owner.contact.email}</span>
            <CopyButton value={owner.contact.email} label={t('coordinator.copy_email')} />
          </div>
        </div>
        {canRepair ? (
          <div className="w-full sm:ml-auto sm:w-auto">
            <OwnerAccessRepair orgId={org.id} />
          </div>
        ) : null}
      </div>
    </section>
  );
}

/** The users, pending, child and level tiles the viewer may see. */
function orgTiles(
  data: OrgData,
  access: ReturnType<typeof orgPageAccess>,
  maxChildren: number | null,
  t: Translate,
) {
  const { org } = data;
  const childrenSub =
    maxChildren === null
      ? t('org.tile.children_sub')
      : t('org.children_of_max', { count: data.child_count, max: maxChildren });
  const pendingSub = data.pending_count ? t('org.tile.pending_sub') : t('org.tile.pending_none');
  return (
    <div className="grid grid-cols-2 gap-3.5 lg:grid-cols-4">
      {access.showUsers ? (
        <>
          <CountTile
            icon={<Users size={20} strokeWidth={2} />}
            tone="primary"
            label={t('org.tile.coordinators')}
            count={String(data.coordinator_count)}
            sub={t('org.tile.coordinators_sub')}
            muted={data.coordinator_count === 0}
            showLabel={t('org_home.tile_show')}
            href={`/console/coordinators?org_id=${org.id}`}
          />
          <CountTile
            icon={<Clock size={20} strokeWidth={2} />}
            tone="amber"
            label={t('org.tile.pending')}
            count={String(data.pending_count)}
            sub={pendingSub}
            muted={data.pending_count === 0}
            showLabel={t('org_home.tile_show')}
            href={`/console/coordinators?org_id=${org.id}&status=pending`}
          />
        </>
      ) : null}
      {/* The Default org never has child orgs. */}
      {access.own && !org.is_default ? (
        <CountTile
          icon={<Network size={20} strokeWidth={2} />}
          tone="green"
          label={t('org.child_count')}
          count={String(data.child_count)}
          sub={childrenSub}
          muted={data.child_count === 0}
          showLabel={t('org_home.tile_show')}
          href="/console/orgs"
        />
      ) : null}
      <CountTile
        icon={<Layers size={20} strokeWidth={2} />}
        tone="primary"
        label={t('org.tile.level')}
        count={String(org.depth)}
        sub={t('org.tile.level_sub')}
      />
    </div>
  );
}
