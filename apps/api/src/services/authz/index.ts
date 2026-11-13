/**
 * Public surface of RBAC in `@aggregator-dpg/api`: boot-time init, the
 * capability checks and the route declarations. The actor comes from
 * `services/auth/actor`; reach from `scope.ts`.
 */

export {
  initRbac,
  getRbacRuntime,
  refreshRbacCatalogue,
  stopRbacRefresh,
  _setRbacRuntime,
} from './runtime.js';
export type { RbacMode, RbacRuntime, RefreshOutcome } from './runtime.js';
export {
  actorPermissions,
  checkCapability,
  decisionInput,
  listActorCapabilities,
  listCapabilitiesForTargets,
  permissionsByOrg,
} from './guard.js';
export type {
  CheckOptions,
  GuardOutcome,
  GuardRequest,
  TargetOrg,
  TokenIdentity,
} from './guard.js';
export {
  assertRouteDeclared,
  callerFromAny,
  callerFromAuth,
  enforcedCapabilities,
  exportRouteTable,
  isServiceAccount,
  listDeclaredRoutes,
  recordRouteCaller,
} from './route-access.js';
export type { RouteAccess, RouteCaller, RouteTable, RouteTableEntry } from './route-access.js';
