/**
 * In-memory decision engine (`@aggregator-dpg/rbac`).
 *
 * Evaluates the same rules as the Rego policy in-process (see `evaluate.ts`).
 * For tests and local runs without an OPA sidecar; production uses
 * {@link OpaAuthorizer}.
 *
 * @module @aggregator-dpg/rbac/in-memory
 */

import { ok, err } from '@aggregator-dpg/shared-primitives/result';
import { ValidationError } from '@aggregator-dpg/shared-primitives/errors';
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import { AuthorizerBase, CapabilityListInputSchema, DecisionInputSchema } from '../interface.js';
import type { Capability, CapabilityListInput, Decision, DecisionInput } from '../interface.js';
import { evaluate, listCapabilities } from '../evaluate.js';

/** Decision engine that evaluates the policy in-process. */
export class InMemoryAuthorizer extends AuthorizerBase {
  /**
   * Answers one access question in-process.
   *
   * @param input - The access question.
   * @returns Ok with the decision, or Err `RBAC_INPUT_INVALID` for a malformed input.
   */
  async decide(input: DecisionInput): Promise<Result<Decision, BaseError>> {
    const parsed = DecisionInputSchema.safeParse(input);
    if (!parsed.success) {
      return err(
        new ValidationError('Invalid decision input', {
          code: 'RBAC_INPUT_INVALID',
          details: { issues: parsed.error.issues },
        }),
      );
    }
    return ok(evaluate(parsed.data));
  }

  /**
   * Lists the held candidate capabilities in-process.
   *
   * @param input - The actor, the candidates and the current time.
   * @returns Ok with the held capabilities, or Err `RBAC_INPUT_INVALID`.
   */
  async listCapabilities(input: CapabilityListInput): Promise<Result<Capability[], BaseError>> {
    const parsed = CapabilityListInputSchema.safeParse(input);
    if (!parsed.success) {
      return err(
        new ValidationError('Invalid capability-list input', {
          code: 'RBAC_INPUT_INVALID',
          details: { issues: parsed.error.issues },
        }),
      );
    }
    return ok(listCapabilities(parsed.data));
  }
}
