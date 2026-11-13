/**
 * Entry point of `@aggregator-dpg/rbac` for apps that wire concrete engines.
 *
 * Packages must import from `./interface` or `./testing` instead
 * (dependency-cruiser enforces it).
 *
 * @module @aggregator-dpg/rbac
 */

export * from './interface.js';
export { SENSITIVE, NOT_THROUGH_ROOT, permissionDefinitions } from './catalogue.js';
export { BUILTIN_ROLES } from './builtin-roles.js';
export { evaluate, listCapabilities } from './evaluate.js';
export { compareCodeUnits } from './order.js';
export { OpaAuthorizer } from './opa/index.js';
export type { OpaAuthorizerOptions } from './opa/index.js';
export { InMemoryAuthorizer } from './in-memory/index.js';
export { roleCatalogueIssues, assertRoleCatalogue } from './roles.js';
export { indexRoles, baseRoleOf, effectivePermissions, effectiveRoleKeys } from './permissions.js';
export type { PermissionSubject, RoleIndex } from './permissions.js';
