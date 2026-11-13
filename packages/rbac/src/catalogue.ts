/**
 * The permission catalogue's descriptive fields (`@aggregator-dpg/rbac`).
 *
 * The keys are `CAPABILITIES` in `interface.ts`; this adds the resource,
 * action and meaning of each, as listed in
 * `docs/rbac/rbac-permissions-and-roles.md` §2. The API syncs these rows into
 * the `permission` table at start.
 *
 * @module @aggregator-dpg/rbac/catalogue
 */

import type { Capability, PermissionDefinition } from './interface.js';

/** Permissions that expose or process decrypted personal data; every use is audited. */
export const SENSITIVE: readonly Capability[] = [
  'profiles.view_pii',
  'campaigns.run',
  'contact.unmask',
];

/** Permissions never reachable through the root organisation. */
export const NOT_THROUGH_ROOT: readonly Capability[] = ['profiles.view_pii'];

const MEANINGS: Record<Capability, string> = {
  'profiles.view': 'See masked profiles, dashboards, metrics',
  'profiles.export': 'Download masked lists',
  'profiles.view_pii': 'See and export decrypted details',
  'profiles.onboard': 'Links, bulk uploads, forms; edit and pause profiles',
  'profiles.verify': 'Mark profiles verified',
  'profiles.retire': 'Retire a profile (irreversible)',
  'profiles.move': 'Move profiles to another aggregator',
  'profiles.act_on_behalf': "Connect or apply for a profile's owner",
  'campaigns.run': 'Email and voice campaigns',
  'orgs.onboard': 'Invite and approve child organisations',
  'orgs.block': 'Suspend or remove a child organisation',
  'org.manage': 'Organisation profile; invite and approve coordinators; assign their roles',
  'contact.unmask': 'See the full email and phone of users in reach',
  'agreement.manage': 'Create and link agreements (terms, privacy, consent)',
  'network.administer': 'Network configuration, service clients, audit, bans; assign admin roles',
};

/** Resource names differ from the key prefix where the key is singular. */
const RESOURCES: Partial<Record<string, string>> = {
  orgs: 'organisations',
  org: 'organisation',
  contact: 'contacts',
  agreement: 'agreements',
};

/**
 * The descriptive row of every permission, in catalogue order.
 *
 * @param keys - The permission keys (the catalogue).
 * @returns One definition per key.
 */
export function permissionDefinitions(keys: readonly Capability[]): PermissionDefinition[] {
  return keys.map((key) => {
    const [prefix = '', action = ''] = key.split('.');
    return {
      key,
      resource: RESOURCES[prefix] ?? prefix,
      action,
      description: MEANINGS[key],
      sensitive: SENSITIVE.includes(key),
    };
  });
}
