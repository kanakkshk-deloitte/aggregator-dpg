/**
 * Registration-invites store contract (`@aggregator-dpg/api`).
 *
 * Stores the `registration_invites` table, which makes email-bound
 * coordinator invites single-use, revocable and traceable. The invite JWT's
 * `sub` is a row's `jti`. Driver errors are mapped to `InviteStoreError` codes.
 */

export type RegistrationInviteStatus = 'pending' | 'consumed' | 'revoked' | 'expired';

export interface RegistrationInvite {
  jti: string;
  role: string;
  parentOrgId: string;
  email: string;
  status: RegistrationInviteStatus;
  expiresAt: Date;
  createdBy: string;
  createdAt: Date;
  consumedAt: Date | null;
}

export interface CreateInviteInput {
  parentOrgId: string;
  /** Normalised (lowercased, trimmed) by the caller before create. */
  email: string;
  expiresAt: Date;
  createdBy: string;
  /** Defaults to `coordinator`. */
  role?: string;
}

export interface RefreshInviteInput {
  expiresAt: Date;
  createdBy: string;
}

export type InviteStoreError =
  | { code: 'NOT_FOUND'; message: string }
  /** A live (pending) invite already exists for this (org, email). */
  | { code: 'DUPLICATE_PENDING'; message: string }
  | { code: 'DB_UNAVAILABLE'; message: string };

export type InviteStoreResult<T> = { ok: true; value: T } | { ok: false; error: InviteStoreError };

export abstract class RegistrationInvitesStoreBase {
  /**
   * Inserts a new pending invite.
   *
   * Returns `DUPLICATE_PENDING` when a live invite for the same org and email
   * exists; the caller can then use {@link refresh}.
   */
  abstract create(input: CreateInviteInput): Promise<InviteStoreResult<RegistrationInvite>>;

  /** Loads an invite by its `jti` (the token `sub`). */
  abstract findByJti(jti: string): Promise<InviteStoreResult<RegistrationInvite | null>>;

  /** Finds the pending invite for an org and email, if any. */
  abstract findPendingByOrgAndEmail(
    parentOrgId: string,
    email: string,
  ): Promise<InviteStoreResult<RegistrationInvite | null>>;

  /**
   * Updates a pending invite's expiry and creator, for a re-invite.
   *
   * Returns `NOT_FOUND` when the row is not `pending`.
   */
  abstract refresh(
    jti: string,
    input: RefreshInviteInput,
  ): Promise<InviteStoreResult<RegistrationInvite>>;

  /**
   * Atomically claims an invite (`pending` to `consumed`), setting `consumed_at`.
   *
   * Returns `null` when the invite was not pending, including a lost race.
   */
  abstract consume(jti: string): Promise<InviteStoreResult<RegistrationInvite | null>>;

  /**
   * Atomically revokes a pending invite (`pending` to `revoked`).
   *
   * Returns `null` when the invite was not pending.
   */
  abstract revoke(jti: string): Promise<InviteStoreResult<RegistrationInvite | null>>;
  /**
   * Undoes a claim whose registration did not complete (`consumed` to `pending`).
   *
   * Never revives a revoked or expired invite. Returns `null` when the row was
   * not consumed.
   */
  abstract release(jti: string): Promise<InviteStoreResult<RegistrationInvite | null>>;
}
