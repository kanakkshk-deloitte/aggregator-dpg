/**
 * Roles page for the network admin: built-in and custom roles.
 *
 * Other actors get "not found".
 */

import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { RolesResponse } from '@aggregator-dpg/shared-primitives/user-org';
import { getConsoleActor } from '@/lib/console-actor';
import { consoleReadOptional } from '@/lib/console-api.server';
import { can } from '@/lib/capabilities';
import { customRolesEnabled } from '@/lib/features.server';
import { Card } from '@/components/ui/Card';
import { RolesAdmin } from '@/components/console/RolesAdmin';

export default async function ConsoleRolesPage() {
  const t = await getTranslations('console');
  const actor = await getConsoleActor();
  if (!actor.ok) return null;
  if (!actor.me.is_network_admin || !can(actor.me.capabilities, 'network.administer')) notFound();
  // With custom roles off, the api has no roles routes, so answer "not found".
  if (!(await customRolesEnabled())) notFound();
  const data = await consoleReadOptional<RolesResponse>('/v1/roles');
  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-display text-[22px] font-bold text-ink-900">{t('roles_admin.title')}</h1>
      {data ? (
        <RolesAdmin initial={data.roles} permissions={data.permissions} />
      ) : (
        <Card className="p-4 text-[13.5px]">{t('roles_admin.off')}</Card>
      )}
    </div>
  );
}
