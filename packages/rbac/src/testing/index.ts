/**
 * Test fake and builders for the decision engine (`@aggregator-dpg/rbac`).
 *
 * `AuthorizerFake` evaluates the real rules in-process and records every
 * question it was asked, so tests can assert on the inputs. Use
 * `failWith()` to simulate an unreachable engine.
 *
 * @module @aggregator-dpg/rbac/testing
 */

import { err } from '@aggregator-dpg/shared-primitives/result';
import { UpstreamError } from '@aggregator-dpg/shared-primitives/errors';
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import { InMemoryAuthorizer } from '../in-memory/index.js';
import type {
  Actor,
  Capability,
  CapabilityListInput,
  Decision,
  DecisionInput,
  RoleDefinition,
} from '../interface.js';

/** In-process engine that records its inputs and can be made to fail. */
export class AuthorizerFake extends InMemoryAuthorizer {
  /** Every input passed to `decide`, in order. */
  readonly calls: DecisionInput[] = [];
  /** Every input passed to `listCapabilities`, in order. */
  readonly listCalls: CapabilityListInput[] = [];
  private failure: BaseError | null = null;

  /**
   * Makes every following call fail with `error` (default: `OPA_UNAVAILABLE`).
   *
   * @param error - The error to return.
   */
  failWith(error: BaseError = new UpstreamError('fake outage', { code: 'OPA_UNAVAILABLE' })): void {
    this.failure = error;
  }

  /**
   * Records the input, then answers it (or fails, after `failWith`).
   *
   * @param input - The access question.
   * @returns The decision, or the configured failure.
   */
  override async decide(input: DecisionInput): Promise<Result<Decision, BaseError>> {
    this.calls.push(input);
    if (this.failure) return err(this.failure);
    return super.decide(input);
  }

  /**
   * Answers a capability list (or fails, after `failWith`).
   *
   * @param input - The actor, the candidates and the current time.
   * @returns The held capabilities, or the configured failure.
   */
  override async listCapabilities(
    input: CapabilityListInput,
  ): Promise<Result<Capability[], BaseError>> {
    this.listCalls.push(input);
    if (this.failure) return err(this.failure);
    return super.listCapabilities(input);
  }
}

/**
 * Builds an active actor holding a coordinator's base permissions.
 *
 * @param overrides - Fields to change from the defaults.
 * @returns A fully-formed actor.
 */
export function buildActor(overrides: Partial<Actor> = {}): Actor {
  return {
    userId: 'user-coord',
    active: true,
    permissions: ['campaigns.run', 'profiles.onboard', 'profiles.view'],
    ...overrides,
  };
}

/**
 * Builds a role definition (an additional coordinator role by default).
 *
 * @param overrides - Fields to change from the defaults.
 * @returns A role that passes the role rules.
 */
export function buildRole(overrides: Partial<RoleDefinition> = {}): RoleDefinition {
  return {
    key: 'viewer',
    name: 'Viewer',
    description: '',
    isBuiltin: false,
    accountType: 'coordinator',
    baseFor: null,
    assignableOrgTypes: ['aggregator'],
    assignedBy: 'org.manage',
    maxDays: null,
    permissions: ['profiles.view'],
    ...overrides,
  };
}
