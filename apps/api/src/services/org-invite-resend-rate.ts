/**
 * Injectable rate-limit check for re-sending an approved org's owner its
 * sign-in link.
 *
 * Belongs to `@aggregator-dpg/api`. Guards the `active` branch of
 * `POST /v1/orgs/create`, where an owner re-submits the form and is mailed a
 * sign-in link. Runs in addition to `checkSubmitRate`, with two differences:
 *
 * - Keyed on the stored owner email only, not `ip|email`, so rotating IPs
 *   does not get a fresh bucket.
 * - Fails closed, so a Redis outage cannot remove the limit on mail sent from
 *   an anonymous form. The narrow key means an outage blocks re-sends for one
 *   address only.
 *
 * Tests override via `_setOrgInviteResendRateChecker`.
 *
 * @module @aggregator-dpg/api
 */

import { config } from '../config.js';
import { consume } from './rate-limiter/index.js';

/** Outcome of one resend rate check. */
export interface OrgInviteResendRateResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

type Checker = (ownerEmail: string) => Promise<OrgInviteResendRateResult>;

let override: Checker | null = null;

/** Test helper — replace the checker (null restores the Redis default). */
export function _setOrgInviteResendRateChecker(c: Checker | null): void {
  override = c;
}

/**
 * Consumes one slot from the invite-resend bucket for an owner address.
 *
 * @param ownerEmail - The org's stored owner email, never the submitted address.
 * @returns Whether the resend is allowed + retry-after seconds.
 */
export async function checkOrgInviteResendRate(
  ownerEmail: string,
): Promise<OrgInviteResendRateResult> {
  if (override) return override(ownerEmail);
  const r = await consume({
    namespace: 'org-invite-resend',
    key: ownerEmail.toLowerCase(),
    windowSeconds: config.ORG_INVITE_RESEND_RATE_WINDOW_SECONDS,
    max: config.ORG_INVITE_RESEND_RATE_MAX_PER_WINDOW,
    failClosed: true,
  });
  return { allowed: r.allowed, retryAfterSeconds: r.retryAfterSeconds };
}
