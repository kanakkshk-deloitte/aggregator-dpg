'use client';

/**
 * The organisation console's sidebar (user & org Phase 5), in the same shell
 * as the coordinator portal's ({@link AppSidebar}). The organisations list is
 * the network admin's only; coordinators need `org.manage`, and the
 * read-only roles and permissions view `network.administer` (RBAC; the API
 * also checks them). Inviting coordinators is offered from the Coordinators
 * page itself (next to the status filter), not as its own sidebar entry.
 * "My account" has no nav entry either — its details open from the account
 * card at the foot of the sidebar (`SidebarAccount.details`).
 */

import { useTranslations } from 'next-intl';
import { AppSidebar, type NavItem, type SidebarAccount } from '../shell/Sidebar';

/**
 * Builds the console links for the actor and renders the shared sidebar.
 *
 * @param props.canManage - Holds `org.manage` (coordinators).
 * @param props.canViewAccess - May open the roles and permissions view.
 * @param props.account - The account card: the admin's name and role.
 */
export function ConsoleSidebar({
  canManage = true,
  homeIsCoordinators = false,
  canViewAccess = false,
  account,
}: Readonly<{
  canManage?: boolean;
  /** The home page lists the caller's coordinators, so its link is named for them. */
  homeIsCoordinators?: boolean;
  canViewAccess?: boolean;
  account: SidebarAccount;
}>) {
  const t = useTranslations('console');
  // Organisations first, then users.
  const nav: NavItem[] = [
    { to: '/console/orgs', label: t('nav.organisations'), icon: 'briefcase' as const },
    ...(homeIsCoordinators
      ? [{ to: '/console', label: t('nav.coordinators'), icon: 'users' as const, exact: true }]
      : []),
    ...(canManage
      ? [{ to: '/console/coordinators', label: t('nav.coordinators'), icon: 'users' as const }]
      : []),
    ...(canViewAccess
      ? [
          {
            to: '/console/access/roles',
            match: '/console/access',
            label: t('nav.access'),
            icon: 'shield' as const,
          },
        ]
      : []),
  ];
  return <AppSidebar nav={nav} portalLabel={t('nav.portal_label')} account={account} />;
}
