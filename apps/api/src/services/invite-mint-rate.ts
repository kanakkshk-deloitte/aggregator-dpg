/**
 * Injectable per-IP throttle for the invite-mint endpoint.
 *
 * Belongs to `@aggregator-dpg/api`. Wraps the Redis fixed-window limiter;
 * tests override via `_setInviteIpRateChecker`.
 */

import { config } from '../config.js';
import { consume } from './rate-limiter/index.js';

export interface InviteMintRateResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

type IpChecker = (ip: string) => Promise<InviteMintRateResult>;

let ipOverride: IpChecker | null = null;

/** Test helper — replace the per-IP checker (null restores the Redis default). */
export function _setInviteIpRateChecker(c: IpChecker | null): void {
  ipOverride = c;
}

/**
 * Coarse per-IP throttle for the mint endpoint, run before the grant check.
 * Fails open. Uses the public-submit window/max config.
 *
 * @param ip - The caller IP.
 * @returns Whether the call is allowed + retry-after seconds.
 */
export async function checkInviteIpRate(ip: string): Promise<InviteMintRateResult> {
  if (ipOverride) return ipOverride(ip);
  const r = await consume({
    namespace: 'invite-mint-ip',
    key: ip,
    windowSeconds: config.PUBLIC_SUBMIT_RATE_WINDOW_SECONDS,
    max: config.PUBLIC_SUBMIT_RATE_MAX_PER_WINDOW,
  });
  return { allowed: r.allowed, retryAfterSeconds: r.retryAfterSeconds };
}
