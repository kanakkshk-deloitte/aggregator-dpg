/**
 * Roles (network admin, read-only, #871): every role the API enforces,
 * built-in and custom, with who holds it and the permissions it grants.
 * Reads the permissions too, for the summary and the personal-data flags.
 * Other actors get "not found", as for anything out of reach.
 */

import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type {
  CataloguePermissionsResponse,
  CatalogueRolesResponse,
} from '@aggregator-dpg/shared-primitives/user-org';
import { getConsoleActor } from '@/lib/console-actor';
import { consoleReadOptional } from '@/lib/console-api.server';
import { can } from '@/lib/capabilities';
import { Topbar } from '@/components/shell/Topbar';
import { ConsoleSection } from '@/components/console/ConsoleUi';
import { AccessCatalogue } from '@/components/console/AccessCatalogue';

export default async function ConsoleAccessRolesPage() {
  const t = await getTranslations('console.access');
  const actor = await getConsoleActor();
  if (!actor.ok) return null;
  if (!actor.me.is_network_admin || !can(actor.me.capabilities, 'network.administer')) notFound();
  const [roles, permissions] = await Promise.all([
    consoleReadOptional<CatalogueRolesResponse>('/v1/rbac/roles'),
    consoleReadOptional<CataloguePermissionsResponse>('/v1/rbac/permissions'),
  ]);
  return (
    <>
      <Topbar title={t('title')} />
      {roles && permissions ? (
        <AccessCatalogue tab="roles" roles={roles.roles} permissions={permissions.permissions} />
      ) : (
        <ConsoleSection>
          <p className="text-[13.5px] text-ink-500">{t('off')}</p>
        </ConsoleSection>
      )}
    </>
  );
}
