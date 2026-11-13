/**
 * Test fake for the actor resolver (`@aggregator-dpg/api`).
 *
 * Use it to pin an actor without seeding stores. Most route tests use the real
 * {@link StoreActorResolver} over the in-memory stores.
 */

import {
  ActorResolverBase,
  type Actor,
  type ActorResult,
  type ResolveActorInput,
} from './interface.js';

/** In-memory resolver keyed by `aggregator_id` claim or subject. */
export class ActorResolverFake extends ActorResolverBase {
  private readonly byKey = new Map<string, Actor>();
  /** When set, every resolve fails with `UNAVAILABLE`. */
  failWith: string | null = null;

  /**
   * Seeds an actor for a subject (or an `aggregator_id` claim).
   *
   * @param key - The subject or the `aggregator_id` claim.
   * @param actor - The actor it resolves to.
   */
  seed(key: string, actor: Actor): void {
    this.byKey.set(key, actor);
  }

  /** {@inheritDoc ActorResolverBase.resolve} */
  async resolve(/* NOSONAR typescript:S7503 */ input: ResolveActorInput): Promise<ActorResult> {
    if (this.failWith) return { ok: false, error: { code: 'UNAVAILABLE', message: this.failWith } };
    const actor = this.byKey.get(input.aggregatorId ?? input.subject) ?? null;
    return { ok: true, value: actor };
  }
}

/**
 * Builds an admin actor owning the given aggregator orgs.
 *
 * @param overrides - Fields to replace.
 * @returns A valid actor.
 */
export function buildAdminActor(overrides: Partial<Actor> = {}): Actor {
  return {
    userId: '00000000-0000-4000-8000-0000000000a1',
    userType: 'admin',
    active: true,
    orgs: [
      {
        id: '00000000-0000-4000-8000-0000000000f1',
        orgType: 'aggregator',
        relation: 'owner',
        isDefault: false,
      },
    ],
    ...overrides,
  };
}
