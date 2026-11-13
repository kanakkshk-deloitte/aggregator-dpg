/**
 * Wire schemas of the console APIs `/v1/user/*` and `/v1/org/*`. Shared by the
 * API (zod → OpenAPI) and the web BFF / console.
 *
 * Wire style as the rest of the API: snake_case keys, no envelope, `.strict()`
 * request bodies. Paging is keyset with an opaque `cursor` string.
 *
 * @module @aggregator-dpg/shared-primitives/user-org
 */

import { z } from 'zod';

import { BecknLocationSchema } from '../beckn/index.js';
import { fieldsQuerySchema } from '../dto/index.js';

// ─── Shared pieces ──────────────────────────────────────────────────────────

/** Registration / org lifecycle status. */
export const UserOrgStatusSchema = z.enum(['pending', 'active', 'inactive', 'retired']);
export type UserOrgStatus = z.infer<typeof UserOrgStatusSchema>;

/** Organisation type. */
export const OrgTypeSchema = z.enum(['network_facilitator', 'aggregator']);
export type OrgType = z.infer<typeof OrgTypeSchema>;

/** Key of an org's "known as" value. Membership in the parent's list is checked by the API. */
export const KnownAsKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/)
  .max(64);

/** Longest "known as" name. */
export const KNOWN_AS_NAME_MAX = 60;

/** Most entries in one org's `known_as_values` list. */
export const KNOWN_AS_MAX_VALUES = 20;

/**
 * The built-in "known as" value. A valid stored value under every parent, and
 * the value of a new org whose parent's list has no default.
 */
export const SYSTEM_KNOWN_AS = { key: 'aggregator', name: 'Aggregator' } as const;

const KnownAsNameSchema = z.string().trim().min(1).max(KNOWN_AS_NAME_MAX);

/** One entry of an org's `known_as_values` list, as the API returns it. */
export const KnownAsEntrySchema = z.object({
  key: KnownAsKeySchema,
  name: KnownAsNameSchema,
  /** Set on the entry new child orgs get. At most one entry per list. */
  default: z.literal(true).optional(),
});
export type KnownAsEntry = z.infer<typeof KnownAsEntrySchema>;

/**
 * The values a child of an org can be given. The API checks a picked value
 * against them and the console offers them.
 *
 * @param list - The parent's `known_as_values` list.
 * @returns The list, or only the system value when the list is empty.
 */
export function knownAsChoices(list: readonly KnownAsEntry[]): KnownAsEntry[] {
  return list.length > 0 ? [...list] : [{ ...SYSTEM_KNOWN_AS }];
}

/**
 * One entry of a `known_as_values` list in a request. An existing entry sends
 * its key back to keep it; a new entry sends no key and the API makes one
 * from the name.
 */
export const KnownAsEntryRequestSchema = z
  .object({
    key: KnownAsKeySchema.optional(),
    name: KnownAsNameSchema,
    default: z.literal(true).optional(),
  })
  .strict();
export type KnownAsEntryRequest = z.infer<typeof KnownAsEntryRequestSchema>;

/**
 * Adds an issue for a repeated key, a repeated name and more than one
 * `default` entry. Names are compared trimmed and case-insensitively.
 */
function checkKnownAsList(
  list: ReadonlyArray<{ key?: string | undefined; name: string; default?: true | undefined }>,
  ctx: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  const seenNames = new Set<string>();
  let defaults = 0;
  list.forEach((entry, i) => {
    if (entry.key !== undefined) {
      if (seen.has(entry.key)) {
        ctx.addIssue({ code: 'custom', path: [i, 'key'], message: 'known_as keys must be unique' });
      }
      seen.add(entry.key);
    }
    const name = entry.name.trim().toLowerCase();
    if (seenNames.has(name)) {
      ctx.addIssue({ code: 'custom', path: [i, 'name'], message: 'known_as names must be unique' });
    }
    seenNames.add(name);
    if (entry.default) {
      defaults += 1;
      if (defaults > 1) {
        ctx.addIssue({
          code: 'custom',
          path: [i, 'default'],
          message: 'at most one known_as value can be the default',
        });
      }
    }
  });
}

/**
 * The "known as" values an org defines for its direct children. Keys and
 * names are unique, at most one entry is the default, and the list has at most
 * {@link KNOWN_AS_MAX_VALUES} entries.
 */
export const KnownAsValuesSchema = z
  .array(KnownAsEntrySchema)
  .max(KNOWN_AS_MAX_VALUES)
  .superRefine(checkKnownAsList);
export type KnownAsValues = z.infer<typeof KnownAsValuesSchema>;

/**
 * A `known_as_values` list in a request. The keys that are given and all names
 * are unique, at most one entry is the default, and the list has at most
 * {@link KNOWN_AS_MAX_VALUES} entries.
 */
export const KnownAsValuesRequestSchema = z
  .array(KnownAsEntryRequestSchema)
  .max(KNOWN_AS_MAX_VALUES)
  .superRefine(checkKnownAsList);
export type KnownAsValuesRequest = z.infer<typeof KnownAsValuesRequestSchema>;

/** A person's contact as the console shows it, unmasked. */
export const PersonContactSchema = z.object({
  name: z.string().nullable(),
  email: z.string(),
  phone: z.string().nullable(),
});
export type PersonContact = z.infer<typeof PersonContactSchema>;

/** Opaque keyset cursor; the server decodes and validates it. */
export const CursorSchema = z.string().min(1).max(512);

/** Page size of a search, 1..100. */
export const PageLimitSchema = z.number().int().min(1).max(100);

/** A free-text decision reason, mailed to the applicant; never logged. */
export const DecisionReasonSchema = z.string().trim().min(1).max(500);

// ─── Users ──────────────────────────────────────────────────────────────────

/** A coordinator as the console shows it. */
export const UserSchema = z.object({
  id: z.string(),
  user_type: z.literal('coordinator'),
  status: UserOrgStatusSchema,
  /** The coordinator's own organisation name as registered (its Signals org). */
  name: z.string(),
  contact: PersonContactSchema,
  /** Network domain ids served; `[]` = every domain. */
  serves: z.array(z.string()),
  org_id: z.string().nullable(),
  /** Registered through an invite. */
  invited: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
  rejected_at: z.string().nullable(),
  /**
   * Keys of the additional roles the coordinator holds now in its
   * organisation (RBAC), sorted; on search results only. `null` when access
   * control is off.
   */
  roles: z.array(z.string()).nullable().optional(),
});
export type User = z.infer<typeof UserSchema>;

/** One org of the signed-in actor. */
export const MeOrgSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  org_type: OrgTypeSchema,
  role: z.enum(['owner', 'member']),
  is_default: z.boolean(),
  /** The caller's permissions in this organisation (RBAC); `null` when access control is off. */
  capabilities: z.array(z.string()).nullable().optional(),
});
export type MeOrg = z.infer<typeof MeOrgSchema>;

/** `GET /v1/user/read/me`. */
export const MeResponseSchema = z.object({
  kind: z.enum(['admin', 'coordinator']),
  user: z.object({ id: z.string(), contact: PersonContactSchema }),
  orgs: z.array(MeOrgSchema),
  is_network_admin: z.boolean(),
  /**
   * The capabilities the caller holds (RBAC), for hiding what they cannot use.
   * `null` when access control is off for the instance: show everything.
   * The API decision, not this list, is the control.
   */
  capabilities: z.array(z.string()).nullable().optional(),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;

/** `POST /v1/user/search`. */
export const UserSearchRequestSchema = z
  .object({
    filter: z
      .object({
        org_id: z.string().uuid().optional(),
        status: UserOrgStatusSchema.optional(),
        serves: z.string().min(1).optional(),
      })
      .strict()
      .default({}),
    cursor: CursorSchema.optional(),
    limit: PageLimitSchema.optional(),
  })
  .strict();
export type UserSearchRequest = z.infer<typeof UserSearchRequestSchema>;

export const UserSearchResponseSchema = z.object({
  users: z.array(UserSchema),
  next_cursor: z.string().nullable(),
});
export type UserSearchResponse = z.infer<typeof UserSearchResponseSchema>;

/** `POST /v1/user/create`: invite coordinators into an org. */
export const UserInviteRequestSchema = z
  .object({
    org_id: z.string().uuid(),
    recipients: z
      .array(
        z
          .object({ email: z.string().min(3).max(320), name: z.string().max(200).optional() })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export type UserInviteRequest = z.infer<typeof UserInviteRequestSchema>;

export const UserInviteResponseSchema = z.object({
  sent: z.number().int(),
  resent: z.number().int(),
  invalid: z.array(z.object({ email: z.string(), reason: z.string() })),
  /** Addresses already coordinators of this org (nothing mailed). */
  existing: z.array(z.object({ email: z.string(), status: z.string() })),
});
export type UserInviteResponse = z.infer<typeof UserInviteResponseSchema>;

/** `POST /v1/user/decision/:id` and `POST /v1/org/decision/:id`. */
export const DecisionRequestSchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    reason: DecisionReasonSchema.optional(),
  })
  .strict();
export type DecisionRequest = z.infer<typeof DecisionRequestSchema>;

/** `POST /v1/org/decision/:id`: a rejection must give a reason. */
export const OrgDecisionRequestSchema = DecisionRequestSchema.refine(
  (d) => d.decision !== 'reject' || d.reason !== undefined,
  { message: 'Give a reason when rejecting an organisation.', path: ['reason'] },
);
export type OrgDecisionRequest = z.infer<typeof OrgDecisionRequestSchema>;

export const DecisionResponseSchema = z.object({
  id: z.string(),
  status: UserOrgStatusSchema,
  /** The applicant / owner was emailed. */
  notified: z.boolean(),
});
export type DecisionResponse = z.infer<typeof DecisionResponseSchema>;

/** `PATCH /v1/user/metadata/update/:id`. */
export const UserMetadataUpdateRequestSchema = z
  .object({
    /** Network domain ids; `[]` = every domain. */
    serves: z.array(z.string().min(1)).max(50),
  })
  .strict();
export type UserMetadataUpdateRequest = z.infer<typeof UserMetadataUpdateRequestSchema>;

// ─── Organisations ──────────────────────────────────────────────────────────

/** An organisation as the console shows it. */
export const OrgSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  org_type: OrgTypeSchema,
  status: UserOrgStatusSchema,
  is_default: z.boolean(),
  locations: z.array(BecknLocationSchema),
  legal_name: z.string().nullable(),
  /** Key of the org's "known as" value; null for the network facilitator. */
  known_as: z.string().nullable(),
  /**
   * Name of `known_as`: the name in the parent's list, else "Aggregator".
   * Null for the network facilitator.
   */
  known_as_name: z.string().nullable(),
  /** Depth in the tree: 0 for the network facilitator, 1 for a top-level org. */
  depth: z.number().int(),
  /** The parent org's id; null for the network facilitator. */
  parent_id: z.string().nullable(),
  /** The parent org's name; null for the network facilitator. */
  parent_name: z.string().nullable(),
  description: z.string().nullable(),
  /**
   * Values of the deployment's org-registration schema fields (website, GST
   * number, domains, …), keyed by field name.
   */
  profile: z.record(z.string(), z.unknown()),
  /** The schema file that produced `profile`, e.g. `blue_dot/up-gzb/org-registration.v1`. */
  profile_ref: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Org = z.infer<typeof OrgSchema>;

/**
 * Extra data `GET /v1/org/read/:id` returns only when the `fields` query names it.
 * A dotted name adds data under a nested key: `parent.known_as_values` adds `org.parent`.
 */
export const ORG_READ_FIELDS = ['known_as_values', 'parent.known_as_values'] as const;

/** `GET /v1/org/read/:id` query. */
export const OrgReadQuerySchema = z.object({ fields: fieldsQuerySchema(ORG_READ_FIELDS) });
export type OrgReadQuery = z.infer<typeof OrgReadQuerySchema>;

/** The parent block of `GET /v1/org/read/:id`. The network admin's root for a top-level org. */
export const OrgReadParentSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** The parent's stored list; empty when it has none. */
  known_as_values: KnownAsValuesSchema,
});
export type OrgReadParent = z.infer<typeof OrgReadParentSchema>;

/** An organisation as `GET /v1/org/read/:id` returns it. */
export const OrgReadOrgSchema = OrgSchema.extend({
  /**
   * Only with `fields=known_as_values`. The "known as" values the org defines
   * for its direct children. Null when the org cannot have child orgs: it is
   * at `max_depth`, or it is the Default org.
   */
  known_as_values: KnownAsValuesSchema.nullable().optional(),
  /**
   * Only with `fields=parent.known_as_values`. The parent org and its stored
   * "known as" list, which holds this org's choices (see {@link knownAsChoices}).
   * Null when the caller cannot set this org's `known_as`: it does not own the
   * parent, or the org is the root, the Default org or rejected.
   */
  parent: OrgReadParentSchema.nullable().optional(),
});
export type OrgReadOrg = z.infer<typeof OrgReadOrgSchema>;

/** `GET /v1/org/read/:id`. */
export const OrgReadResponseSchema = z.object({
  org: OrgReadOrgSchema,
  owner: z.object({ id: z.string(), contact: PersonContactSchema }),
  coordinator_count: z.number().int(),
  /** Pending and active direct child orgs, Default excluded. */
  child_count: z.number().int(),
  pending_count: z.number().int(),
});
export type OrgReadResponse = z.infer<typeof OrgReadResponseSchema>;

/** `POST /v1/org/search`. */
export const OrgSearchRequestSchema = z
  .object({
    filter: z
      .object({
        status: UserOrgStatusSchema.optional(),
        name_prefix: z.string().trim().min(1).max(100).optional(),
        /** Only orgs below this org; the result never goes past the caller's reach. */
        descendants_of: z.string().uuid().optional(),
        /** Only the direct children of this org; the org must be within the caller's reach. */
        parent_id: z.string().uuid().optional(),
      })
      .strict()
      .refine((f) => f.descendants_of === undefined || f.parent_id === undefined, {
        message: 'Send descendants_of or parent_id, not both.',
        path: ['parent_id'],
      })
      .default({}),
    cursor: CursorSchema.optional(),
    limit: PageLimitSchema.optional(),
  })
  .strict();
export type OrgSearchRequest = z.infer<typeof OrgSearchRequestSchema>;

export const OrgSearchResponseSchema = z.object({
  orgs: z.array(
    OrgSchema.extend({
      coordinator_count: z.number().int(),
      /** Pending and active direct child orgs, Default excluded. */
      child_count: z.number().int(),
      pending_count: z.number().int(),
    }),
  ),
  next_cursor: z.string().nullable(),
});
export type OrgSearchResponse = z.infer<typeof OrgSearchResponseSchema>;

/**
 * `PATCH /v1/org/metadata/update/:id`. Every field is the org owner's only.
 *
 * `profile` holds schema fields to change: each value replaces the stored one,
 * `null` removes it. The API checks them against the deployment's
 * org-registration schema; only fields marked `x-updatable` are accepted.
 */
export const OrgMetadataUpdateRequestSchema = z
  .object({
    name: z.string().trim().min(2).max(200).optional(),
    locations: z.array(BecknLocationSchema).max(25).optional(),
    legal_name: z.string().trim().max(200).nullable().optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    profile: z
      .record(z.string(), z.unknown())
      .refine((p) => Object.keys(p).length > 0, { message: 'profile must name a field' })
      .optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'at least one field is required' });
export type OrgMetadataUpdateRequest = z.infer<typeof OrgMetadataUpdateRequestSchema>;

/**
 * `PATCH /v1/org/parent/update/:id`: moves the org under a new parent. Network admin only.
 *
 * The moved org keeps its `known_as` when the new parent's list has the key;
 * otherwise it takes the new parent's default, else `aggregator`.
 */
export const OrgParentUpdateRequestSchema = z
  .object({
    parent_id: z.string().uuid(),
  })
  .strict();
export type OrgParentUpdateRequest = z.infer<typeof OrgParentUpdateRequestSchema>;

/** `GET /v1/org/parent/options/:id`: candidate parents for a move. Network admin only. */
export const OrgParentOptionsResponseSchema = z.object({
  /** Number of orgs that move: the org and every org below it. */
  subtree_size: z.number().int(),
  options: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      depth: z.number().int(),
      known_as_name: z.string().nullable(),
      /** Whether the move to this parent would succeed. */
      ok: z.boolean(),
      /** The error code the move would give; null when `ok`. */
      reason: z.string().nullable(),
    }),
  ),
});
export type OrgParentOptionsResponse = z.infer<typeof OrgParentOptionsResponseSchema>;

/**
 * `PATCH /v1/org/known-as/update/:id`. The body has exactly one of two fields:
 * - `known_as` sets the org's own value. Only the owner of the org's parent
 *   can send it; the key must be one of the parent's values, or `aggregator`
 *   when the parent's list is empty.
 * - `known_as_values` replaces the values the org defines for its direct
 *   children. Only the org's owner can send it. Children whose key leaves the
 *   list take the new default, else `aggregator`.
 */
export const OrgKnownAsUpdateRequestSchema = z.union([
  z.object({ known_as: KnownAsKeySchema }).strict(),
  z.object({ known_as_values: KnownAsValuesRequestSchema }).strict(),
]);
export type OrgKnownAsUpdateRequest = z.infer<typeof OrgKnownAsUpdateRequestSchema>;

/**
 * `PATCH /v1/org/known-as/update/:id` response: the org. A `known_as_values`
 * request also returns the saved list, with the keys the API made.
 */
export const OrgKnownAsUpdateResponseSchema = OrgSchema.extend({
  known_as_values: KnownAsValuesSchema.optional(),
  /** With known_as_values: child orgs moved to the default because their value was removed. */
  reset_count: z.number().int().nonnegative().optional(),
});
export type OrgKnownAsUpdateResponse = z.infer<typeof OrgKnownAsUpdateResponseSchema>;

/** `POST /v1/org/decision/:id` response: adds what owner access achieved. */
export const OrgDecisionResponseSchema = DecisionResponseSchema.extend({
  owner_access: z.enum(['granted', 'partial', 'no_login', 'none']),
});
export type OrgDecisionResponse = z.infer<typeof OrgDecisionResponseSchema>;

/** `POST /v1/org/access/repair/:id` response. */
export const OwnerAccessResponseSchema = z.object({
  id: z.string(),
  status: z.enum(['granted', 'partial', 'no_login']),
  enable: z.enum(['ok', 'failed', 'skipped']),
  role: z.enum(['ok', 'failed', 'skipped']),
  group: z.enum(['ok', 'failed', 'skipped']),
});
export type OwnerAccessResponse = z.infer<typeof OwnerAccessResponseSchema>;

// ─── RBAC roles ────────────────────────────────────────────────────────────

/** A role on the wire: a named set of permissions and the rules for holding it. */
export const RoleSchema = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string(),
  is_builtin: z.boolean(),
  account_type: z.enum(['admin', 'coordinator']),
  /** Set for a base role (follows membership); null for an additional role. */
  base_for: z.enum(['org_member', 'org_owner', 'root_owner']).nullable(),
  assignable_org_types: z.array(OrgTypeSchema),
  /** The permission an assigner needs; null for a base role. */
  assigned_by: z.string().nullable(),
  max_days: z.number().int().positive().nullable(),
  permissions: z.array(z.string()),
});
export type Role = z.infer<typeof RoleSchema>;

/** One permission of the catalogue on the wire. */
export const PermissionSchema = z.object({
  key: z.string(),
  resource: z.string(),
  action: z.string(),
  description: z.string(),
  sensitive: z.boolean(),
  /**
   * Whether any route checks this permission. The console marks permissions
   * that nothing enforces yet.
   */
  enforced: z.boolean(),
});
export type Permission = z.infer<typeof PermissionSchema>;

/** `GET /v1/roles`: every role, and the permissions a role can be composed from. */
export const RolesResponseSchema = z.object({
  roles: z.array(RoleSchema),
  permissions: z.array(PermissionSchema),
});
export type RolesResponse = z.infer<typeof RolesResponseSchema>;

/**
 * How a role is given: by membership (a base role, and which membership), or
 * assigned by holders of a named permission (an additional role).
 */
export const RoleGrantSchema = z.discriminatedUnion('via', [
  z.object({
    via: z.literal('membership'),
    membership: z.enum(['org_member', 'org_owner', 'root_owner']),
  }),
  z.object({ via: z.literal('assignment'), assigned_by: z.string() }),
]);
export type RoleGrant = z.infer<typeof RoleGrantSchema>;

/** One row of the network admin's read-only roles table (#871). */
export const CatalogueRoleSchema = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string(),
  is_builtin: z.boolean(),
  /** Who holds it: organisation owners (admin accounts) or coordinators. */
  held_by: z.enum(['org_owners', 'coordinators']),
  /** Organisation types it is held in. */
  held_in: z.array(OrgTypeSchema),
  granted: RoleGrantSchema,
  /** Longest validity of an assignment, in days; null = none applies. */
  max_days: z.number().int().positive().nullable(),
  /** As stored, sorted. */
  permissions: z.array(z.string()),
});
export type CatalogueRole = z.infer<typeof CatalogueRoleSchema>;

/** `GET /v1/rbac/roles`: every role the API enforces, built-in and custom. */
export const CatalogueRolesResponseSchema = z.object({ roles: z.array(CatalogueRoleSchema) });
export type CatalogueRolesResponse = z.infer<typeof CatalogueRolesResponseSchema>;

/** One row of the network admin's read-only permissions table (#871). */
export const CataloguePermissionSchema = z.object({
  key: z.string(),
  description: z.string(),
  resource: z.string(),
  action: z.string(),
  /** Exposes or processes decrypted personal data. */
  personal_data: z.boolean(),
  /** No longer in the code's catalogue; kept so stored roles still resolve. */
  retired: z.boolean(),
  /** Keys of the roles that grant it, sorted. */
  granted_by_roles: z.array(z.string()),
});
export type CataloguePermission = z.infer<typeof CataloguePermissionSchema>;

/** `GET /v1/rbac/permissions`: every permission in the catalogue, retired included. */
export const CataloguePermissionsResponseSchema = z.object({
  permissions: z.array(CataloguePermissionSchema),
});
export type CataloguePermissionsResponse = z.infer<typeof CataloguePermissionsResponseSchema>;

/** One additional-role assignment on the wire. */
export const RoleAssignmentSchema = z.object({
  id: z.string(),
  role_key: z.string(),
  org_id: z.string(),
  granted_by: z.string().nullable(),
  granted_at: z.string(),
  expires_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
  /** Not revoked and not expired. */
  live: z.boolean(),
});
export type RoleAssignment = z.infer<typeof RoleAssignmentSchema>;

/** `GET /v1/user/roles/:id`: base roles (derived) and additional roles. */
export const UserRolesResponseSchema = z.object({
  base: z.array(z.object({ role_key: z.string(), org_id: z.string() })),
  additional: z.array(RoleAssignmentSchema),
  /** Additional roles the caller may assign to this user, per organisation. */
  assignable: z.array(z.object({ role_key: z.string(), org_id: z.string() })),
});
export type UserRolesResponse = z.infer<typeof UserRolesResponseSchema>;

/** `POST /v1/user/role/assign/:id`. Omit `days` for the role's longest validity. */
export const AssignRoleRequestSchema = z
  .object({
    role_key: z.string().min(1),
    org_id: z.string().uuid(),
    days: z.number().int().positive().optional(),
  })
  .strict();
export type AssignRoleRequest = z.infer<typeof AssignRoleRequestSchema>;

/** `POST /v1/user/role/revoke/:id`. */
export const RevokeRoleRequestSchema = z
  .object({ role_key: z.string().min(1), org_id: z.string().uuid() })
  .strict();
export type RevokeRoleRequest = z.infer<typeof RevokeRoleRequestSchema>;

/** `POST /v1/user/role/revoke/:id` response. */
export const RevokeRoleResponseSchema = z.object({ revoked: z.boolean() });
export type RevokeRoleResponse = z.infer<typeof RevokeRoleResponseSchema>;

/** `POST /v1/roles/create`: a custom role (network admin). */
export const CreateRoleRequestSchema = z
  .object({
    key: z
      .string()
      .min(1)
      .max(40)
      .regex(/^[a-z][a-z0-9_]*$/),
    name: z.string().min(1).max(80),
    description: z.string().max(300).default(''),
    account_type: z.enum(['admin', 'coordinator']),
    assignable_org_types: z.array(OrgTypeSchema).min(1),
    assigned_by: z.string().min(1),
    max_days: z.number().int().positive().nullable().default(null),
    permissions: z.array(z.string()).min(1),
  })
  .strict();
export type CreateRoleRequest = z.infer<typeof CreateRoleRequestSchema>;

/** `PATCH /v1/roles/update/:key`: change a custom role (the key and account type are fixed). */
export const UpdateRoleRequestSchema = z
  .object({
    name: z.string().min(1).max(80).optional(),
    description: z.string().max(300).optional(),
    assignable_org_types: z.array(OrgTypeSchema).min(1).optional(),
    assigned_by: z.string().min(1).optional(),
    max_days: z.number().int().positive().nullable().optional(),
    permissions: z.array(z.string()).min(1).optional(),
  })
  .strict();
export type UpdateRoleRequest = z.infer<typeof UpdateRoleRequestSchema>;

// ─── Hierarchy settings ─────────────────────────────────────────────────────

/** Extra data `GET /v1/org/hierarchy` returns only when the `fields` query names it. */
export const ORG_HIERARCHY_FIELDS = ['known_as_values'] as const;

/** `GET /v1/org/hierarchy` query. */
export const OrgHierarchyQuerySchema = z.object({
  fields: fieldsQuerySchema(ORG_HIERARCHY_FIELDS),
});
export type OrgHierarchyQuery = z.infer<typeof OrgHierarchyQuerySchema>;

/** `GET /v1/org/hierarchy`: the network facilitator and the tree limits. */
export const OrgHierarchyResponseSchema = z.object({
  /** The network facilitator, depth 0: the top of the tree. */
  network: z.object({
    id: z.string(),
    name: z.string(),
    /** Only with `fields=known_as_values`. The "known as" values the network defines for top-level orgs. */
    known_as_values: KnownAsValuesSchema.optional(),
  }),
  limits: z.object({
    /** The deepest an aggregator org can be; 1 keeps every org under the network. */
    max_depth: z.number().int(),
    /** The most pending and active direct children of any org; null is no limit. */
    max_children: z.number().int().nullable(),
    /** The most pending and active aggregator orgs, Default excluded. */
    max_total_orgs: z.number().int(),
  }),
  /** Pending and active aggregator orgs, Default excluded. */
  total_orgs: z.number().int(),
});
export type OrgHierarchyResponse = z.infer<typeof OrgHierarchyResponseSchema>;
