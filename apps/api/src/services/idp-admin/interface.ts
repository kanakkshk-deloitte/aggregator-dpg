/**
 * Identity-provider admin contract (`@aggregator-dpg/api`).
 *
 * The small set of admin operations the API needs: users, attributes, groups,
 * realm roles and sessions. Another IdP can be supported by writing a new
 * adapter.
 */

export interface CreateUserInput {
  email: string;
  /** Phone in E.164 format. Stored as `phoneNumber` user attribute. */
  phone?: string;
  firstName?: string;
  lastName?: string;
  username?: string;
  enabled?: boolean;
  /** Free-form attributes. Existing fields take precedence. */
  attributes?: Record<string, string | string[]>;
  /**
   * Keycloak required actions for the new user, e.g. Update Profile on first
   * sign-in to collect fields not captured at registration.
   */
  requiredActions?: string[];
}

export interface IdpUser {
  id: string;
  email: string;
  username: string;
  enabled: boolean;
  firstName?: string;
  lastName?: string;
  attributes?: Record<string, string[]>;
}

export type IdpResult<T> = { ok: true; value: T } | { ok: false; error: IdpError };

export type IdpError =
  | { code: 'AUTH_FAILED'; message: string }
  | { code: 'USER_EXISTS'; message: string }
  | { code: 'USER_NOT_FOUND'; message: string }
  | { code: 'IDP_UNAVAILABLE'; message: string }
  | { code: 'BAD_REQUEST'; message: string }
  /** The IdP refused a character in the person's name. */
  | { code: 'INVALID_NAME'; message: string };

/**
 * Abstract IdP admin port. Concrete impls extend this base.
 */
export abstract class IdpAdminAdapter {
  abstract createUser(input: CreateUserInput): Promise<IdpResult<IdpUser>>;
  abstract findByEmail(email: string): Promise<IdpResult<IdpUser | null>>;
  abstract findById(userId: string): Promise<IdpResult<IdpUser | null>>;
  /**
   * Looks up a user by an attribute name/value pair, e.g. `aggregator_id`.
   */
  abstract findByAttribute(name: string, value: string): Promise<IdpResult<IdpUser | null>>;
  abstract enableUser(userId: string): Promise<IdpResult<void>>;
  abstract disableUser(userId: string): Promise<IdpResult<void>>;
  abstract deleteUser(userId: string): Promise<IdpResult<void>>;
  /**
   * Merges attributes onto an existing user. Only the given keys are written;
   * a `null` value removes the key.
   */
  abstract setAttributes(
    userId: string,
    attributes: Record<string, string | string[] | null>,
  ): Promise<IdpResult<void>>;

  /**
   * Writes the `decision_made` attribute on a user. Does not enable or
   * disable the user; call `enableUser` / `disableUser` for that.
   *
   * @param userId  - Keycloak user id (from `findByAttribute(aggregator_id)`).
   * @param decision - One of `'pending'`, `'approved'`, `'rejected'`.
   */
  abstract setUserDecision(
    userId: string,
    decision: 'pending' | 'approved' | 'rejected',
  ): Promise<IdpResult<void>>;

  /**
   * Creates a Keycloak group for an org. The group holds only the org owner;
   * coordinators are not members.
   *
   * @param name - Group name (e.g. `org-<slug>`).
   * @param attributes - Optional group attributes (e.g. `{ org_id }`).
   * @returns The created group's id.
   */
  abstract createGroup(
    name: string,
    attributes?: Record<string, string | string[]>,
  ): Promise<IdpResult<{ id: string }>>;

  /**
   * Deletes a group by id. Used when pruning an abandoned org registration.
   *
   * @param groupId - Group id returned by {@link createGroup}.
   * @returns `ok` with `void`; a 404 is treated as success (idempotent).
   */
  abstract deleteGroup(groupId: string): Promise<IdpResult<void>>;

  /**
   * Finds a top-level group by exact name, to adopt a group left by an earlier
   * attempt (a 409 on create).
   *
   * @param name - Exact group name.
   * @returns The group's id and attributes, or `null` when absent.
   */
  abstract findGroupByName(
    name: string,
  ): Promise<IdpResult<{ id: string; attributes: Record<string, string[]> } | null>>;

  /**
   * Removes a user from a group. A missing user or membership counts as success.
   *
   * @param userId - Keycloak user id.
   * @param groupId - Group id.
   */
  abstract removeUserFromGroup(userId: string, groupId: string): Promise<IdpResult<void>>;

  /**
   * Adds a user to a group.
   *
   * @param userId - Keycloak user id.
   * @param groupId - Group id returned by {@link createGroup}.
   */
  abstract addUserToGroup(userId: string, groupId: string): Promise<IdpResult<void>>;

  /**
   * Assigns a realm role (e.g. `org_owner`, `coordinator`) to a user.
   *
   * @param userId - Keycloak user id.
   * @param role - Realm role name.
   */
  abstract assignRealmRole(userId: string, role: string): Promise<IdpResult<void>>;

  /**
   * Removes a realm role from a user. Succeeds if the user does not hold it.
   *
   * @param userId - Keycloak user id.
   * @param role - Realm role name.
   */
  abstract removeRealmRole(userId: string, role: string): Promise<IdpResult<void>>;

  /**
   * Lists the realm roles mapped directly to a user (not composites).
   *
   * @param userId - Keycloak user id.
   * @returns Role names; `USER_NOT_FOUND` for an unknown user.
   */
  abstract listRealmRoles(userId: string): Promise<IdpResult<string[]>>;

  /**
   * Ends every session of a user now, so their tokens stop refreshing.
   *
   * @param userId - Keycloak user id.
   */
  abstract logoutSessions(userId: string): Promise<IdpResult<void>>;
}
