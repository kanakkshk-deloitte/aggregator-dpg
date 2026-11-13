/**
 * Public surface and factory for the actor resolver, in the aggregator API
 * (`@aggregator-dpg/api`). Returns a process-wide singleton; tests override it
 * with `_setActorResolver`.
 */

import type { ActorResolverBase } from './interface.js';
import { StoreActorResolver } from './store.js';

let instance: ActorResolverBase | null = null;

/** Returns the shared actor resolver (lazy). */
export function getActorResolver(): ActorResolverBase {
  instance ??= new StoreActorResolver();
  return instance;
}

/** Test helper — replace the singleton (`null` restores the default). */
export function _setActorResolver(r: ActorResolverBase | null): void {
  instance = r;
}

export { ActorResolverBase } from './interface.js';
export type {
  Actor,
  ActorOrg,
  ActorOrgRelation,
  ActorResolveError,
  ActorResult,
  ResolveActorInput,
} from './interface.js';
export { StoreActorResolver } from './store.js';
export { isNetworkAdmin, ownedOrgIds } from './facts.js';
export { requireActor, type ResolvedCaller } from './require.js';
export { ActorResolverFake, buildAdminActor } from './testing.js';
