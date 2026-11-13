/**
 * Best-effort recording of a coordinator's IdP login (`@aggregator-dpg/api`).
 *
 * The IdP subject is recorded when an approver opens the review link and on
 * the coordinator's first approved request per process. A failure is logged
 * and never blocks the caller; a conflicting link is never overwritten.
 */

import { logger } from '../../logger.js';
import { IDP_PROVIDER } from '../idp-admin/provider.js';
import { getIdentityStore } from './index.js';
import type { IdentityStoreBase } from './interface.js';

/**
 * Users already recorded by this process, per store instance, to avoid a write per request.
 */
let recorded = new WeakMap<IdentityStoreBase, Set<string>>();

/**
 * Links the user's login at this deployment's IdP, once per process.
 *
 * @param userId - The account (`users.id`).
 * @param subject - The IdP's user id.
 * @param operation - Caller name for the log entry.
 */
export async function recordLoginIdentity(
  userId: string,
  subject: string,
  operation: string,
): Promise<void> {
  const store = getIdentityStore();
  let seen = recorded.get(store);
  if (!seen) {
    seen = new Set<string>();
    recorded.set(store, seen);
  }
  if (seen.has(userId)) return;
  // Only coordinator accounts are linked through this path.
  const r = await store.link(userId, IDP_PROVIDER, subject, 'coordinator');
  if (r.ok) {
    seen.add(userId);
    if (r.value === 'linked') {
      logger.info({ operation, status: 'success', aggregator_id: userId, identity: 'linked' });
    }
    return;
  }
  if (r.error.code !== 'DB_UNAVAILABLE') seen.add(userId); // retrying will not fix a conflict
  logger.warn({ operation, status: 'failure', error: r.error.code, aggregator_id: userId });
}

/** Test helper — forget which users were recorded. */
export function _resetRecordedIdentities(): void {
  recorded = new WeakMap();
}
