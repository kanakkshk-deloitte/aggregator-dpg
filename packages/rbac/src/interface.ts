/**
 * Public contract for access decisions in aggregator-dpg (`@aggregator-dpg/rbac`).
 *
 * Defines the fixed permission catalogue (`CAPABILITIES`; a capability is a
 * permission), the role model, the shape of an access question
 * ({@link DecisionInput}) and the {@link AuthorizerBase} every decision
 * engine implements. The question is "does the actor hold this permission in
 * this organisation"; which targets the actor reaches is answered outside the
 * policy. The OPA-backed engine and the in-memory fake both extend it.
 *
 * Design: `docs/rbac/rbac-design-aggregator.md`; catalogue:
 * `docs/rbac/rbac-permissions-and-roles.md`.
 *
 * @module @aggregator-dpg/rbac/interface
 */

import { z } from 'zod';
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';

/** Every permission in the catalogue. Stable IDs: never renamed, only deprecated. */
export const CAPABILITIES = [
  'profiles.view',
  'profiles.export',
  'profiles.view_pii',
  'profiles.onboard',
  'profiles.verify',
  'profiles.retire',
  'profiles.move',
  'profiles.act_on_behalf',
  'campaigns.run',
  'orgs.onboard',
  'orgs.block',
  'org.manage',
  'contact.unmask',
  'agreement.manage',
  'network.administer',
] as const;

/** Zod schema for one permission ID. */
export const CapabilitySchema = z.enum(CAPABILITIES);

/** One permission ID, e.g. `profiles.view_pii`. */
export type Capability = z.infer<typeof CapabilitySchema>;

/** Account types of the user-org model (`users.user_type`). */
export const UserTypeSchema = z.enum(['admin', 'coordinator']);

/** Account type: `admin` (organisation owner) or `coordinator`. */
export type UserType = z.infer<typeof UserTypeSchema>;

/** Organisation types of the user-org model (`organisations.org_type`). */
export const OrgTypeSchema = z.enum(['network_facilitator', 'aggregator']);

/** Organisation type: the single `network_facilitator` root, or an `aggregator`. */
export type OrgType = z.infer<typeof OrgTypeSchema>;

/** How a user relates to an organisation in the user-org model. */
export const OrgRelationSchema = z.enum(['owner', 'member']);

/** `owner` = `organisations.org_owner`; `member` = the coordinator's `users.org_id`. */
export type OrgRelation = z.infer<typeof OrgRelationSchema>;

// ─── Roles ───────────────────────────────────────────────────────────────────

/** Which membership a base role follows. */
export const BaseForSchema = z.enum(['org_member', 'org_owner', 'root_owner']);

/** `org_member` = a coordinator in `users.org_id`; `org_owner` = owner of an aggregator organisation; `root_owner` = owner of the root. */
export type BaseFor = z.infer<typeof BaseForSchema>;

/** A role: a named set of permissions, with the rules for holding it. */
export const RoleDefinitionSchema = z.object({
  key: z
    .string()
    .min(1)
    .regex(/^[a-z][a-z0-9_]*$/),
  name: z.string().min(1),
  description: z.string(),
  isBuiltin: z.boolean(),
  /** Only users of this account type hold the role. */
  accountType: UserTypeSchema,
  /** Set for a base role (derived from membership); null for an additional role. */
  baseFor: BaseForSchema.nullable(),
  /** Organisation types the role may be held in. */
  assignableOrgTypes: z.array(OrgTypeSchema).min(1),
  /** The permission an assigner needs; null for a base role. */
  assignedBy: CapabilitySchema.nullable(),
  /** Longest validity of an assignment, in days; null = no expiry. */
  maxDays: z.number().int().positive().nullable(),
  permissions: z.array(CapabilitySchema),
});

/** A role definition. */
export type RoleDefinition = z.infer<typeof RoleDefinitionSchema>;

/** One permission's descriptive fields (the `permission` table). */
export interface PermissionDefinition {
  key: Capability;
  resource: string;
  action: string;
  description: string;
  /** Exposes or processes decrypted personal data; every use is audited. */
  sensitive: boolean;
}

/** A user's relation to one organisation (from the user-org model). */
export interface Membership {
  orgId: string;
  orgType: OrgType;
  relation: OrgRelation;
}

/** One additional role the user holds (a `user_role` row). */
export interface HeldRole {
  roleKey: string;
  orgId: string;
  /** Epoch milliseconds; null = no expiry. */
  expiresAt: number | null;
}

// ─── Access questions ────────────────────────────────────────────────────────

/** The organisation a question is asked about. */
export const DecisionOrgSchema = z.object({
  id: z.string().min(1),
  orgType: OrgTypeSchema,
});

/** The organisation acted on. */
export type DecisionOrg = z.infer<typeof DecisionOrgSchema>;

/** The caller, as the guard prepared it for one question. */
export const ActorSchema = z.object({
  userId: z.string().min(1),
  /** False for pending, rejected or disabled accounts: they hold nothing. */
  active: z.boolean(),
  /** The union of the permissions of the actor's base and live additional roles where the question applies. */
  permissions: z.array(CapabilitySchema),
});

/** The caller of one question. */
export type Actor = z.infer<typeof ActorSchema>;

/** One access question. */
export const DecisionInputSchema = z.object({
  capability: CapabilitySchema,
  actor: ActorSchema,
  /** The organisation acted on; null when the route has no single target. */
  org: DecisionOrgSchema.nullable(),
});

/** One access question. */
export type DecisionInput = z.infer<typeof DecisionInputSchema>;

/** Which of the candidate permissions an actor holds (for the portal). */
export const CapabilityListInputSchema = z.object({
  actor: ActorSchema,
  org: DecisionOrgSchema.nullable(),
  /** Permissions to test; normally the whole catalogue. */
  candidates: z.array(CapabilitySchema),
});

/** A permission-list question. */
export type CapabilityListInput = z.infer<typeof CapabilityListInputSchema>;

/** The answer: allowed or not, with machine-readable reasons for a deny. */
export const DecisionSchema = z.object({
  allow: z.boolean(),
  reasons: z.array(z.string()),
});

/** The answer to one access question. */
export type Decision = z.infer<typeof DecisionSchema>;

/**
 * Abstract decision engine.
 *
 * Concrete engines (OPA over HTTP, the in-memory fake) extend this class and
 * implement both methods with the exact signatures.
 */
export abstract class AuthorizerBase {
  /**
   * Answers one access question.
   *
   * @param input - The permission, the actor and the organisation acted on.
   * @returns Ok with the decision, or Err when the engine cannot answer
   *   (unreachable, timed out, malformed reply). Callers treat Err as a deny.
   */
  abstract decide(input: DecisionInput): Promise<Result<Decision, BaseError>>;

  /**
   * Lists the candidate permissions the actor holds, in one question. Each
   * listed permission is one `decide` would allow.
   *
   * @param input - The actor, the organisation and the candidates.
   * @returns Ok with the held permissions (sorted), or Err when the engine
   *   cannot answer.
   */
  abstract listCapabilities(input: CapabilityListInput): Promise<Result<Capability[], BaseError>>;
}
