/**
 * Server-side stamping of a registration's consent (`@aggregator-dpg/api`).
 *
 * Shared by coordinator and org registration, so both store a server-set
 * `given_at` and a clamped `valid_till` in the consent ledger.
 */

/** Maximum consent validity (five years), so a client cannot store a permanent consent. */
export const MAX_CONSENT_VALIDITY_MS = 5 * 365 * 24 * 60 * 60 * 1000;

/** The consent block a registration form submits. */
export interface SubmittedConsent {
  value: true;
  given_at: string;
  valid_till: string;
}

/**
 * Sets `given_at` to now and clamps `valid_till` to at most
 * {@link MAX_CONSENT_VALIDITY_MS} after now.
 *
 * A shorter window is kept; an unparseable `valid_till` gets the maximum.
 *
 * @param incoming - Consent block from the registration form.
 * @param now - The current instant (injectable for tests).
 * @returns The stamped consent, or `null` when `valid_till` is not after `now`.
 */
export function stampConsent<T extends SubmittedConsent>(
  incoming: T,
  now: Date = new Date(),
): T | null {
  const maxValidTill = new Date(now.getTime() + MAX_CONSENT_VALIDITY_MS);
  const requestedValidTill = new Date(incoming.valid_till);
  if (Number.isFinite(requestedValidTill.getTime()) && requestedValidTill <= now) return null;
  const validTill =
    Number.isFinite(requestedValidTill.getTime()) && requestedValidTill < maxValidTill
      ? requestedValidTill
      : maxValidTill;
  return {
    ...incoming,
    given_at: now.toISOString(),
    valid_till: validTill.toISOString(),
  };
}
