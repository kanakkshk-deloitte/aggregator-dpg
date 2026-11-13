/**
 * The built-in roles of the catalogue (`@aggregator-dpg/rbac`).
 *
 * The source of the six built-in roles. Migration `0031_rbac_seed.sql` seeds
 * them into the database, and an integration test checks the seed matches this
 * const. Changing a built-in role needs an edit here and a new migration.
 * Custom roles live only in the database. Rules:
 * `docs/rbac/rbac-permissions-and-roles.md` §3–§4.
 *
 * @module @aggregator-dpg/rbac/builtin-roles
 */

import type { RoleDefinition } from './interface.js';

/**
 * The six built-in roles, sorted by key. The three base roles (`baseFor` set)
 * follow membership. The three additional roles (`assignedBy` set) are granted
 * by a permission holder.
 */
export const BUILTIN_ROLES: readonly RoleDefinition[] = [
  {
    key: 'coordinator',
    name: 'Coordinator',
    description: 'An approved coordinator of an aggregator organisation.',
    isBuiltin: true,
    accountType: 'coordinator',
    baseFor: 'org_member',
    assignableOrgTypes: ['aggregator'],
    assignedBy: null,
    maxDays: null,
    permissions: ['profiles.view', 'profiles.onboard', 'campaigns.run'],
  },
  {
    key: 'data_export',
    name: 'Data Export',
    description: 'Downloads masked profile lists.',
    isBuiltin: true,
    accountType: 'coordinator',
    baseFor: null,
    assignableOrgTypes: ['aggregator'],
    assignedBy: 'org.manage',
    maxDays: null,
    permissions: ['profiles.export'],
  },
  {
    key: 'network_admin',
    name: 'Network Admin',
    description: "The root organisation's owner; administers the network.",
    isBuiltin: true,
    accountType: 'admin',
    baseFor: 'root_owner',
    assignableOrgTypes: ['network_facilitator'],
    assignedBy: null,
    maxDays: null,
    permissions: [
      'profiles.view',
      'profiles.export',
      'profiles.onboard',
      'profiles.verify',
      'profiles.retire',
      'profiles.move',
      'campaigns.run',
      'orgs.onboard',
      'orgs.block',
      'contact.unmask',
      'agreement.manage',
      'network.administer',
    ],
  },
  {
    key: 'org_admin',
    name: 'Org Admin',
    description: "An aggregator organisation's owner.",
    isBuiltin: true,
    accountType: 'admin',
    baseFor: 'org_owner',
    assignableOrgTypes: ['aggregator'],
    assignedBy: null,
    maxDays: null,
    permissions: [
      'profiles.view',
      'profiles.export',
      'profiles.onboard',
      'profiles.retire',
      'campaigns.run',
      'org.manage',
      'contact.unmask',
      'orgs.onboard',
    ],
  },
  {
    key: 'org_onboarder',
    name: 'Org Onboarder',
    description: 'Onboards other organisations (Super Aggregator).',
    isBuiltin: true,
    accountType: 'admin',
    baseFor: null,
    assignableOrgTypes: ['aggregator'],
    assignedBy: 'network.administer',
    maxDays: null,
    permissions: ['profiles.verify', 'profiles.move', 'orgs.onboard'],
  },
  {
    key: 'pii_access',
    name: 'PII Access',
    description: 'Sees and exports decrypted profile details.',
    isBuiltin: true,
    accountType: 'coordinator',
    baseFor: null,
    assignableOrgTypes: ['aggregator'],
    assignedBy: 'org.manage',
    maxDays: 90,
    permissions: ['profiles.view_pii'],
  },
];
