/**
 * Keycloak user-attribute names used across `@aggregator-dpg/api`.
 *
 * Values match the keys in the Keycloak realm
 * (`infra/keycloak/realms/realm.json`) and its protocol mappers.
 */

/**
 * Keycloak carries five attributes:
 *
 *   - `aggregator_id`      — reverse pointer to Postgres
 *   - `aggregator_type`    — `seeker` | `provider`, drives single-type enforcement
 *   - `phoneNumber`        — read by the OTP login authenticator
 *   - `decision_made`      — gates login at the auth middleware
 *   - `signalstack_org_id` — signalstack organisation id, written after the
 *                            admin-approval upsert and exposed as a token claim
 *
 * Everything else lives in Postgres. Do not write the deprecated constants
 * below; they remain for existing realm exports.
 */
export const KC_ATTR = {
  /** Postgres aggregator UUID — reverse pointer from KC to our DB. */
  AGGREGATOR_ID: 'aggregator_id',
  /** `seeker` or `provider`. Limits an aggregator to its registered participant type. */
  AGGREGATOR_TYPE: 'aggregator_type',
  /** Applicant phone in E.164. Read by the OTP login authenticator. */
  PHONE_NUMBER: 'phoneNumber',
  /** `pending` / `approved` / `rejected` — the login gate. */
  DECISION_MADE: 'decision_made',
  /**
   * Signalstack organisation id from `POST /admin/aggregator/upsert`. Written on
   * approval and backfilled at login when missing.
   */
  SIGNALSTACK_ORG_ID: 'signalstack_org_id',
  /**
   * `aggregator-owner` on Keycloak users this app created for an org owner.
   * Only these users are disabled when an owner is replaced: the realm is
   * shared with Signals, so a reused user may be someone else's login.
   */
  CREATED_BY: 'created_by',

  // ─── Deprecated (do not write from new code) ────────────────────────────
  /** @deprecated Slug lives in Postgres (`aggregators.org_slug`). */
  ORG_SLUG: 'org_slug',
  /** @deprecated Display name lives in Postgres (`aggregators.name`). */
  ASSOCIATION: 'association',
  /** @deprecated Decision timestamp lives in Postgres. */
  DECIDED_AT: 'decided_at',
  /** @deprecated Rejection reason lives in Postgres. */
  REJECTION_REASON: 'rejection_reason',
} as const;

export type KcAttrName = (typeof KC_ATTR)[keyof typeof KC_ATTR];

/** Decision values written to / read from `KC_ATTR.DECISION_MADE`. */
export type DecisionMade = 'pending' | 'approved' | 'rejected';

/** The realm role the portal gate admits org owners by. */
export const OWNER_REALM_ROLE = 'org_owner';

/** {@link KC_ATTR.CREATED_BY} value on owner users the aggregator created. */
export const OWNER_CREATED_BY = 'aggregator-owner';
