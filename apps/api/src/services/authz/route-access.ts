/**
 * Route access declarations and their enforcement (`@aggregator-dpg/api`, RBAC).
 *
 * Every route declares who may call it in `config.rbac`, so an unguarded route
 * is visible in review (#805) and the app refuses to boot without one
 * ({@link assertRouteDeclared}). The declarations are exported to the edge
 * ({@link exportRouteTable}), which decides every request before it reaches the
 * API; each route file's auth wrapper then calls {@link recordRouteCaller}.
 */

import type { FastifyRequest, RouteOptions } from 'fastify';
import { CapabilitySchema, type Capability } from '@aggregator-dpg/rbac';
import type { AnyAuthContext, AuthContext } from '../auth/access-token.js';
import type { TokenIdentity } from './guard.js';
import { getRbacRuntime } from './runtime.js';
import { recordLoginIdentity } from '../identity-store/record.js';

/**
 * Who may call a route.
 *
 * - `capability`: an end user holding it (organisation set ∩ role, reach).
 *   With `strict`, a deny is refused in `log` mode too.
 * - `anyCapability`: an end user holding at least one of them, for a route an
 *   organisation's owner and the network admin share.
 * - `self`: an active account acting on its own record.
 * - `signed_in`: any known account.
 * - `service`: a Keycloak service-account token (no end user).
 * - `link_token`: a signed approval / grant / invite link; checked by the route.
 * - `public`: anyone; rate limits apply.
 */
export type RouteAccess =
  | { capability: Capability; strict?: true }
  | { anyCapability: readonly Capability[] }
  | { access: 'self' | 'signed_in' | 'service' | 'link_token' | 'public' };

declare module 'fastify' {
  interface FastifyContextConfig {
    /** The route's access declaration (RBAC). */
    rbac?: RouteAccess;
  }
}

/** Token facts the checks need. */
export interface RouteCaller extends TokenIdentity {
  /** `preferred_username`; `service-account-<client>` for a service account. */
  preferredUsername?: string | undefined;
}

/**
 * Caller facts from an end-user token ({@link AuthContext}).
 *
 * @param ctx - The verified context.
 * @returns The caller for {@link recordRouteCaller}.
 */
export function callerFromAuth(ctx: AuthContext): RouteCaller {
  return {
    ...(ctx.aggregatorId ? { aggregatorId: ctx.aggregatorId } : {}),
    subject: ctx.userId,
    preferredUsername: ctx.preferredUsername,
  };
}

/**
 * Caller facts from a user-or-service token ({@link AnyAuthContext}).
 *
 * @param ctx - The verified context.
 * @returns The caller for {@link recordRouteCaller}.
 */
export function callerFromAny(ctx: AnyAuthContext): RouteCaller {
  return {
    ...(ctx.aggregatorId ? { aggregatorId: ctx.aggregatorId } : {}),
    subject: ctx.subject,
    preferredUsername: ctx.preferredUsername,
  };
}

/** Prefix Keycloak gives a service account's `preferred_username`. */
const SERVICE_ACCOUNT_PREFIX = 'service-account-';

/** Routes registered by plugins, not by this app's route files. */
const PLUGIN_ROUTE_PREFIXES: readonly string[] = ['/api/reference', '/documentation'];

/**
 * Whether a `preferred_username` belongs to a Keycloak service account.
 *
 * `sub` cannot tell: it is a UUID for service accounts too.
 *
 * @param preferredUsername - The token's `preferred_username` claim.
 * @returns True for `service-account-<client>`.
 */
export function isServiceAccount(preferredUsername: string | undefined): boolean {
  return (preferredUsername ?? '').startsWith(SERVICE_ACCOUNT_PREFIX);
}

/** Declarations seen by {@link assertRouteDeclared}, keyed `METHOD url`. */
const declared = new Map<string, RouteAccess>();

/**
 * Returns every route declaration registered so far, sorted by `METHOD url`.
 *
 * @returns `[key, declaration]` pairs.
 */
export function listDeclaredRoutes(): Array<[string, RouteAccess]> {
  return [...declared.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/** Test helper — forget every recorded declaration. */
export function _resetDeclaredRoutes(): void {
  declared.clear();
}

/** One route of the exported route table. */
export interface RouteTableEntry {
  /** HTTP method, upper case. */
  method: string;
  /** Path template as registered, e.g. `/v1/user/read/:id`. */
  path: string;
  /** The route's `config.rbac` declaration. */
  access: RouteAccess;
}

/** The route table the edge policy reads (`policy/rbac/edge/routes.json`). */
export interface RouteTable {
  /** Format version, bumped on an incompatible change. */
  version: 1;
  /** Path prefixes of plugin routes, which carry no declaration. */
  unchecked_prefixes: readonly string[];
  /** Every declared route, sorted by method then path. */
  routes: RouteTableEntry[];
}

/**
 * Exports every route declaration registered so far, for the edge policy.
 *
 * The edge (Envoy + OPA, docs/rbac/rbac-edge-enforcement.md §3.1) decides each
 * request from this table, so it is generated from the same declarations the
 * boot check records rather than written by hand.
 *
 * @returns The route table; empty until the app's routes are registered.
 */
export function exportRouteTable(): RouteTable {
  return {
    version: 1,
    unchecked_prefixes: PLUGIN_ROUTE_PREFIXES,
    routes: listDeclaredRoutes().map(([key, access]) => {
      const space = key.indexOf(' ');
      return { method: key.slice(0, space), path: key.slice(space + 1), access };
    }),
  };
}

/**
 * Capabilities a handler checks itself rather than declaring on its route.
 *
 * `contact.unmask` decides whether a response shows contact details plain or
 * masked (`showsContact` in `v1-user.ts`); it gates no route.
 */
const HANDLER_CHECKED: readonly Capability[] = ['contact.unmask'];

/**
 * The capabilities this build actually enforces somewhere.
 *
 * A permission can exist in the catalogue with nothing that checks it yet.
 * The console uses this to show which permissions have effect. It is derived
 * from the registered routes.
 *
 * @returns Every capability named by a route declaration or checked in a handler.
 */
export function enforcedCapabilities(): ReadonlySet<Capability> {
  const out = new Set<Capability>(HANDLER_CHECKED);
  for (const decl of declared.values()) {
    if ('capability' in decl) out.add(decl.capability);
  }
  return out;
}

/**
 * `onRoute` hook: refuses to register a route without a valid `config.rbac`.
 *
 * @param route - The route being registered.
 * @throws {Error} When the declaration is missing or names an unknown capability.
 */
export function assertRouteDeclared(route: RouteOptions): void {
  const url = route.url ?? '';
  const methods = [route.method].flat();
  if (methods.every((m) => m === 'HEAD')) return;
  if (PLUGIN_ROUTE_PREFIXES.some((p) => url.startsWith(p))) return;
  const decl = route.config?.rbac;
  if (!decl) {
    throw new Error(`RBAC: route ${methods.join(',')} ${url} has no config.rbac declaration`);
  }
  const named =
    'capability' in decl ? [decl.capability] : 'anyCapability' in decl ? decl.anyCapability : [];
  if ('anyCapability' in decl && named.length === 0) {
    throw new Error(`RBAC: route ${methods.join(',')} ${url} declares an empty anyCapability`);
  }
  if (named.some((c) => !CapabilitySchema.safeParse(c).success)) {
    throw new Error(`RBAC: route ${methods.join(',')} ${url} declares unknown capability`);
  }
  for (const m of methods) if (m !== 'HEAD') declared.set(`${m} ${url}`, decl);
}

/**
 * Records the caller's login after a route file's auth wrapper verified the
 * token. Route permissions are decided at the edge (Envoy + OPA,
 * docs/rbac/rbac-edge-enforcement.md) before the request gets here, so this
 * checks nothing: each check lives in one place (decision E6).
 *
 * The actor resolver accepts a coordinator only through its recorded login
 * (handoff H-11), and the token-roles sync finds a coordinator's Keycloak user
 * through it. Logins are recorded lazily on the first approved request; record
 * it here too, so a coordinator whose first call is a `self` or `signed_in`
 * route is known. Best effort, once per process, never overwrites a different
 * link. A no-op with RBAC off and on service-account routes.
 *
 * @param req - The request; its route's `config.rbac` is read.
 * @param caller - Facts from the verified token.
 */
export async function recordRouteCaller(req: FastifyRequest, caller: RouteCaller): Promise<void> {
  if (!getRbacRuntime()) return;
  const decl = req.routeOptions.config.rbac;
  if (!decl || !caller.aggregatorId) return;
  // The actor resolver accepts a coordinator only through its recorded login.
  // Best effort; never overwrites a different link.
  if ('access' in decl && decl.access === 'service') return;
  await recordLoginIdentity(caller.aggregatorId, caller.subject, 'rbac.recordIdentity');
}
