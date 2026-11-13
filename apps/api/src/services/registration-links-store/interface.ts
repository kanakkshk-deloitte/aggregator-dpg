/**
 * Registration links store contract (`@aggregator-dpg/api`).
 *
 * Stores the `registration_links` table. Owns slug uniqueness and the status
 * lifecycle (draft, live, retired).
 */

export type RegistrationLinkStatus = 'draft' | 'live' | 'retired';

/**
 * Per-link registration mode key, an open snake_case identifier.
 *
 * Network config (`registration_modes`) maps each key to a form shape.
 * Unknown keys fall back via resolveSubmissionShape() in services/registration-mode.
 */
export type RegistrationLinkRegistrationMode = string;

export interface RegistrationLink {
  id: string;
  aggregatorId: string;
  slug: string;
  domain: string;
  context: Record<string, unknown>;
  /** See {@link RegistrationLinkRegistrationMode}. */
  registrationMode: RegistrationLinkRegistrationMode;
  /**
   * Read only, for older rows; the QR is generated client-side. Do not add a write path.
   */
  qrObjectKey: string | null;
  status: RegistrationLinkStatus;
  expiresAt: Date | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateRegistrationLinkInput {
  aggregatorId: string;
  slug: string;
  domain: string;
  context: Record<string, unknown>;
  status?: RegistrationLinkStatus;
  /** Defaults to the network's `form` mode when omitted. */
  registrationMode?: RegistrationLinkRegistrationMode;
  expiresAt?: Date | null;
  createdBy: string;
}

/**
 * Patch accepted by {@link RegistrationLinksStoreBase.updateDraft}.
 *
 * `null` on `expiresAt` clears the expiry; an omitted key is left unchanged.
 */
export interface UpdateDraftInput {
  slug?: string;
  context?: Record<string, unknown>;
  expiresAt?: Date | null;
}

export type StoreError =
  | { code: 'NOT_FOUND'; message: string }
  | { code: 'SLUG_COLLISION'; message: string }
  | { code: 'DB_UNAVAILABLE'; message: string };

export type StoreResult<T> = { ok: true; value: T } | { ok: false; error: StoreError };

export interface ListRegistrationLinksOptions {
  status?: RegistrationLinkStatus;
  limit: number;
  offset: number;
}

export interface ListRegistrationLinksResult {
  rows: RegistrationLink[];
  total: number;
}

export abstract class RegistrationLinksStoreBase {
  /**
   * Creates a registration link.
   *
   * Returns SLUG_COLLISION when the slug is taken, so the caller can retry.
   */
  abstract create(input: CreateRegistrationLinkInput): Promise<StoreResult<RegistrationLink>>;
  /**
   * Finds a link by id, scoped to the calling aggregator.
   *
   * Scoping is enforced here so a route mistake cannot leak another aggregator's rows.
   */
  abstract findById(
    id: string,
    aggregatorId: string,
  ): Promise<StoreResult<RegistrationLink | null>>;
  /**
   * Finds a link by its public slug, with no aggregator scoping.
   *
   * @deprecated Slugs are unique per aggregator. Use {@link findByOrgAndSlug}
   *   for the `/<org_slug>/<slug>` public URL.
   */
  abstract findBySlug(slug: string): Promise<StoreResult<RegistrationLink | null>>;

  /**
   * Finds a link by the coordinator's `signalstack_org_slug` and the link slug.
   */
  abstract findByOrgAndSlug(
    orgSlug: string,
    slug: string,
  ): Promise<StoreResult<RegistrationLink | null>>;
  /**
   * Updates the editable fields of a draft (`slug`, `context`, `expires_at`).
   *
   * Live and retired rows return `NOT_FOUND`. A taken slug returns `SLUG_COLLISION`.
   */
  abstract updateDraft(
    id: string,
    aggregatorId: string,
    patch: UpdateDraftInput,
  ): Promise<StoreResult<RegistrationLink>>;
  /**
   * Lists one aggregator's links, newest first, optionally filtered by status.
   */
  abstract list(
    aggregatorId: string,
    options: ListRegistrationLinksOptions,
  ): Promise<StoreResult<ListRegistrationLinksResult>>;
  /**
   * Sets a link's status. Setting the current status returns the row unchanged.
   */
  abstract updateStatus(
    id: string,
    aggregatorId: string,
    nextStatus: RegistrationLinkStatus,
  ): Promise<StoreResult<RegistrationLink>>;
}
