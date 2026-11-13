/**
 * Permission checks for the API (`@aggregator-dpg/api`, RBAC).
 *
 * Expands an actor's base and additional roles into permissions for the target
 * organisation and its ancestors (or every organisation the actor relates to,
 * when there is no single target), asks the decision engine, and logs the
 * outcome. In `log` mode a deny is only logged; in `enforce` mode the caller
 * turns `allowed: false` into a 403. Reach is decided in `scope.ts` (404).
 */

import type { FastifyBaseLogger } from 'fastify';
import {
  CAPABILITIES,
  effectivePermissions,
  type AuthorizerBase,
  type Capability,
  type Decision,
  type DecisionInput,
  type OrgType,
  type RoleIndex,
} from '@aggregator-dpg/rbac';
import type { Actor } from '../auth/actor/index.js';
import { getRbacRuntime, type RbacMode } from './runtime.js';

/** What the caller should do with the request. */
export interface GuardOutcome {
  /** False only in `enforce` mode, for a deny. */
  allowed: boolean;
  mode: RbacMode;
  /** The decision, when a check ran. */
  decision?: Decision;
}

/** The request facts the guard needs. */
export interface GuardRequest {
  log: FastifyBaseLogger;
  routeOptions?: { url?: string | undefined };
  method?: string | undefined;
}

/** The organisation a request acts on. */
export interface TargetOrg {
  id: string;
  orgType: OrgType;
  /** Its ancestors, nearest first (the root for an aggregator organisation). */
  ancestorIds: string[];
}

/** Optional inputs of a check. */
export interface CheckOptions {
  /** The organisation acted on; omitted = every organisation the actor relates to. */
  target?: TargetOrg | undefined;
  /** Clock, for role expiry. Injectable for tests. */
  now?: number | undefined;
  /**
   * Deny in `log` mode too. Used for role and custom-role writes, so they are
   * never open while RBAC is on.
   */
  strict?: boolean | undefined;
}

/** Who the token says the caller is. */
export interface TokenIdentity {
  /** `aggregator_id` claim, when present. */
  aggregatorId?: string | undefined;
  /** Keycloak `sub`. */
  subject: string;
}

/**
 * Returns the permissions an actor holds where a request applies.
 *
 * Expands its base roles and live additional roles through the role snapshot.
 *
 * @param roles - The role snapshot.
 * @param actor - The resolved actor.
 * @param target - The organisation acted on, or undefined for every organisation the actor relates to.
 * @param now - Clock, for role expiry.
 * @returns The permissions, sorted.
 */
export function actorPermissions(
  roles: RoleIndex,
  actor: Actor,
  target: TargetOrg | undefined,
  now: number,
): Capability[] {
  return effectivePermissions(
    roles,
    {
      userType: actor.userType,
      memberships: actor.orgs.map((o) => ({
        orgId: o.id,
        orgType: o.orgType,
        relation: o.relation,
      })),
      held: actor.roles ?? [],
    },
    target ? new Set([target.id, ...target.ancestorIds]) : null,
    now,
  );
}

/**
 * Builds the policy input for one question.
 *
 * @param roles - The role snapshot.
 * @param actor - The resolved actor.
 * @param capability - The permission asked for.
 * @param target - The organisation acted on, or undefined.
 * @param now - Clock, for role expiry.
 * @returns The decision input.
 */
export function decisionInput(
  roles: RoleIndex,
  actor: Actor,
  capability: Capability,
  target: TargetOrg | undefined,
  now: number,
): DecisionInput {
  return {
    capability,
    actor: {
      userId: actor.userId,
      active: actor.active,
      permissions: actorPermissions(roles, actor, target, now),
    },
    org: target ? { id: target.id, orgType: target.orgType } : null,
  };
}

/** Asks the engine; an engine failure becomes a deny. */
async function decide(authorizer: AuthorizerBase, input: DecisionInput): Promise<Decision> {
  const result = await authorizer.decide(input);
  return result.success ? result.value : { allow: false, reasons: ['engine_unavailable'] };
}

/** Logs a decision and turns it into an outcome for the mode. */
function outcome(
  req: GuardRequest,
  mode: Exclude<RbacMode, 'off'>,
  capability: Capability | string,
  userId: string | undefined,
  decision: Decision,
  start: number,
): GuardOutcome {
  const entry = {
    operation: 'rbac.decide',
    capability,
    route: req.routeOptions?.url,
    method: req.method,
    user_id: userId,
    mode,
    allow: decision.allow,
    reasons: decision.reasons,
    latency_ms: Date.now() - start,
  };
  if (decision.allow) {
    req.log.debug({ ...entry, status: 'success' });
    return { allowed: true, mode, decision };
  }
  req.log.warn({ ...entry, status: mode === 'enforce' ? 'failure' : 'skipped' });
  return { allowed: mode !== 'enforce', mode, decision };
}

/**
 * Checks whether a resolved actor holds `capability`, in the target
 * organisation when one is given. Never throws.
 *
 * Use it inside a handler once the target is known, and for checks that do
 * not fail the whole route, such as unmasking contact details.
 *
 * @param req - The request (for its logger and route).
 * @param actor - The resolved actor.
 * @param capability - The permission asked for.
 * @param options - The organisation acted on, and a clock for tests.
 * @returns Whether to continue, the mode, and the decision.
 */
export async function checkCapability(
  req: GuardRequest,
  actor: Actor,
  capability: Capability,
  options: CheckOptions = {},
): Promise<GuardOutcome> {
  const rt = getRbacRuntime();
  if (!rt) return { allowed: true, mode: 'off' };
  const start = Date.now();
  const input = decisionInput(
    rt.roles,
    actor,
    capability,
    options.target,
    options.now ?? Date.now(),
  );
  const decision = await decide(rt.authorizer, input);
  const mode = options.strict ? 'enforce' : rt.mode;
  return outcome(req, mode, capability, actor.userId, decision, start);
}

/**
 * Lists the permissions a resolved actor holds, for the portal. Never throws.
 *
 * @param req - The request (for its logger).
 * @param actor - The resolved actor.
 * @param options - The organisation acted on (default: every organisation the actor relates to), and a clock for tests.
 * @returns The held permissions; `null` when RBAC is off (no restriction);
 *   an empty list when the engine cannot answer (the API still decides).
 */
export async function listActorCapabilities(
  req: GuardRequest,
  actor: Actor,
  options: CheckOptions = {},
): Promise<Capability[] | null> {
  const rt = getRbacRuntime();
  if (!rt) return null;
  const target = options.target;
  const res = await rt.authorizer.listCapabilities({
    actor: {
      userId: actor.userId,
      active: actor.active,
      permissions: actorPermissions(rt.roles, actor, target, options.now ?? Date.now()),
    },
    org: target ? { id: target.id, orgType: target.orgType } : null,
    candidates: [...CAPABILITIES],
  });
  if (res.success) return res.value;
  req.log.warn({
    operation: 'rbac.capabilities',
    status: 'failure',
    user_id: actor.userId,
    error: res.error.message,
    error_type: res.error.code,
  });
  return [];
}

/**
 * Lists the permissions a resolved actor holds in each of several
 * organisations, asking the engine once per distinct question.
 *
 * The answer depends only on the expanded permissions and the organisation
 * type, so targets with the same pair share one engine call.
 *
 * @param req - The request (for its logger).
 * @param actor - The resolved actor.
 * @param targets - The organisations to answer for.
 * @param now - Clock, for role expiry. Injectable for tests.
 * @returns Permissions per organisation id; `null` when RBAC is off.
 */
export async function listCapabilitiesForTargets(
  req: GuardRequest,
  actor: Actor,
  targets: readonly TargetOrg[],
  now: number = Date.now(),
): Promise<Map<string, Capability[]> | null> {
  if (!getRbacRuntime()) return null;
  const out = new Map<string, Capability[]>();
  // Keyed on permissions + org type, which is all the engine sees.
  const answers = new Map<string, Promise<Capability[] | null>>();
  for (const target of targets) {
    const rt = getRbacRuntime();
    if (!rt) return null;
    const permissions = actorPermissions(rt.roles, actor, target, now);
    const key = JSON.stringify([permissions, target.orgType]);
    let answer = answers.get(key);
    if (!answer) {
      answer = listActorCapabilities(req, actor, { target, now });
      answers.set(key, answer);
    }
    out.set(target.id, (await answer) ?? []);
  }
  return out;
}

/**
 * The permissions a resolved actor holds in each organisation it belongs to
 * or owns, for the portal. Never throws.
 *
 * Asks once per *distinct* question rather than once per organisation: the
 * manage-scope checks (#873) call this on every coordinator read, search and
 * decision, and an owner holding the same role in each of its organisations
 * would otherwise pay one sequential engine round-trip per organisation.
 *
 * @param req - The request (for its logger).
 * @param actor - The resolved actor.
 * @param rootId - The root organisation's id (every aggregator organisation's ancestor), when known.
 * @returns Permissions per organisation id; `null` when RBAC is off.
 */
export async function permissionsByOrg(
  req: GuardRequest,
  actor: Actor,
  rootId: string | null,
): Promise<Record<string, Capability[]> | null> {
  const targets: TargetOrg[] = actor.orgs.map((o) => ({
    id: o.id,
    orgType: o.orgType,
    ancestorIds: o.orgType === 'aggregator' && rootId ? [rootId] : [],
  }));
  const byOrg = await listCapabilitiesForTargets(req, actor, targets);
  return byOrg === null ? null : Object.fromEntries(byOrg);
}
