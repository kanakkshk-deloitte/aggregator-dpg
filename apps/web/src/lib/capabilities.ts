/**
 * Capability checks for the portal and the console (`apps/web`).
 *
 * Capabilities come from `GET /v1/user/read/me`. `null` means access control
 * is off, so nothing is hidden. Hiding is for convenience only; the API
 * authorises every request.
 *
 * @module apps/web/src/lib/capabilities
 */

/**
 * Whether the caller may use something that needs `capability`.
 *
 * @param capabilities - The caller's capabilities, or null / undefined when
 *   access control is off.
 * @param capability - The capability the feature needs.
 * @returns True when the feature should be shown.
 */
export function can(
  capabilities: readonly string[] | null | undefined,
  capability: string,
): boolean {
  return capabilities == null || capabilities.includes(capability);
}

/** The parts of `read/me` {@link canManageOrg} reads. */
interface ManageScopeSource {
  capabilities?: readonly string[] | null | undefined;
  orgs: ReadonlyArray<{
    id: string;
    org_type: string;
    is_default?: boolean | undefined;
    capabilities?: readonly string[] | null | undefined;
  }>;
}

/**
 * Whether the caller may manage an organisation's coordinators (invite,
 * decide, edit): `org.manage` in that organisation, or in the root, which
 * applies to every organisation (#873). With access control off: the network
 * admin, or the organisation's owner. An organisation only viewed from above
 * is never managed. Mirrors the API's manage scope.
 *
 * @param me - The caller's `read/me` answer.
 * @param orgId - The organisation.
 * @returns True when the organisation should be offered.
 */
export function canManageOrg(me: ManageScopeSource, orgId: string): boolean {
  const isRootOwner = me.orgs.some((o) => o.org_type === 'network_facilitator');
  if (me.capabilities == null) return isRootOwner || me.orgs.some((o) => o.id === orgId);
  const holds = (o: ManageScopeSource['orgs'][number] | undefined) =>
    o?.capabilities?.includes('org.manage') ?? false;
  if (holds(me.orgs.find((o) => o.org_type === 'network_facilitator'))) return true;
  return holds(me.orgs.find((o) => o.id === orgId));
}

/**
 * Whether the caller can invite coordinators anywhere: it manages an
 * organisation that takes invites (never the Default org), or holds
 * `org.manage` in the root (#873).
 *
 * @param me - The caller's `read/me` answer.
 * @returns True when the console should offer inviting.
 */
export function canInvite(me: ManageScopeSource): boolean {
  if (me.capabilities == null) return true;
  return me.orgs.some(
    (o) =>
      (o.org_type === 'network_facilitator' || (o.org_type === 'aggregator' && !o.is_default)) &&
      (o.capabilities?.includes('org.manage') ?? false),
  );
}

/**
 * Whether the caller can see coordinators: an organisation's admin
 * (`org.manage`). The network admin has no users page, since it sees the
 * users of no organisation it does not own.
 *
 * @param me - The caller's `read/me` answer.
 * @returns True when the console should list coordinators.
 */
export function canViewCoordinators(
  me: ManageScopeSource & { is_network_admin?: boolean | undefined },
): boolean {
  if (me.is_network_admin) return false;
  return can(me.capabilities, 'org.manage');
}

/** The console home page. */
export const CONSOLE_HOME_HREF = '/console';
const COORDINATORS_LIST_HREF = '/console/coordinators';

/**
 * Where the caller's coordinator list lives. An owner of one organisation sees
 * it on the console home; everyone else uses the coordinators page.
 *
 * @param me - The caller's `read/me` answer.
 * @returns The page that lists the caller's coordinators.
 */
export function coordinatorsHref(me: ManageScopeSource & { is_network_admin: boolean }): string {
  if (me.is_network_admin) return COORDINATORS_LIST_HREF;
  const owned = me.orgs.filter((o) => o.org_type === 'aggregator' && !o.is_default);
  return owned.length === 1 ? CONSOLE_HOME_HREF : COORDINATORS_LIST_HREF;
}
