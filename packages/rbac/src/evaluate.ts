/**
 * Pure TypeScript evaluation of an access question (`@aggregator-dpg/rbac`).
 *
 * Mirrors `policy/rbac/rbac.rego` rule for rule. The in-memory authorizer uses
 * it. The vectors in `policy/rbac/vectors.json` run against both this function
 * and the Rego policy.
 *
 * The policy answers whether the actor holds a permission in the organisation
 * acted on. Reach (which targets) is decided by the API's scope checks.
 *
 * @module @aggregator-dpg/rbac/evaluate
 */

import { NOT_THROUGH_ROOT } from './catalogue.js';
import { compareCodeUnits } from './order.js';
import type { Capability, CapabilityListInput, Decision, DecisionInput } from './interface.js';

/** Whether the permission is personal data asked for through the root. */
function throughRoot(input: DecisionInput): boolean {
  return (
    NOT_THROUGH_ROOT.includes(input.capability) && input.org?.orgType === 'network_facilitator'
  );
}

/**
 * Answers one access question without any I/O.
 *
 * Allowed when the actor is active and holds the permission, and it is not
 * personal data asked for through the root organisation.
 *
 * @param input - The permission, the actor and the organisation.
 * @returns `allow` plus sorted deny reasons (empty when allowed).
 */
export function evaluate(input: DecisionInput): Decision {
  const reasons = new Set<string>();
  const held = input.actor.permissions.includes(input.capability);
  if (!input.actor.active) reasons.add('inactive');
  if (!held) reasons.add('not_held');
  if (throughRoot(input)) reasons.add('not_through_root');
  const allow = input.actor.active && held && !throughRoot(input);
  return { allow, reasons: allow ? [] : [...reasons].sort(compareCodeUnits) };
}

/**
 * Lists the candidate permissions the actor holds, without any I/O.
 *
 * @param input - The actor, the organisation and the candidates.
 * @returns The held permissions, sorted and without duplicates.
 */
export function listCapabilities(input: CapabilityListInput): Capability[] {
  const held = input.candidates.filter(
    (capability) => evaluate({ capability, actor: input.actor, org: input.org }).allow,
  );
  return [...new Set(held)].sort(compareCodeUnits);
}
