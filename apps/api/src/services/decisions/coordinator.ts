/**
 * Coordinator registration decision (`@aggregator-dpg/api`).
 *
 * The one place a pending coordinator is approved or rejected, used by the
 * emailed review link (`routes/aggregator-approvals.ts`) and the console
 * (`POST /v1/user/decision/:id`). Callers check who may decide first.
 *
 * Reject is a compare-and-set from `pending`, then side effects. Approve
 * provisions Signals and Keycloak before its compare-and-set; if that loses
 * to a concurrent reject, the Keycloak user is disabled and stamped `rejected`
 * again. Only the winner mails the applicant.
 */

import type { FastifyBaseLogger } from 'fastify';
import { getMailer } from '@aggregator-dpg/mailer';
import type { AggregatorStatus } from '@aggregator-dpg/shared-primitives/aggregator';
import { config } from '../../config.js';
import { getUserStore, type Coordinator } from '../user-store/index.js';
import { getOrganisationStore } from '../organisation-store/index.js';
import { getIdpAdmin, KC_ATTR, type IdpUser } from '../idp-admin/index.js';
import { getSignalStackWriter } from '../signalstack.js';
import { getNetworkConfig } from '../network-config.js';
import { renderApplicantApproved, renderApplicantRejected } from '../email-templates/index.js';
import { recordLoginIdentity } from '../identity-store/record.js';
import { revokeRolesOnLeave } from '../authz/roles.js';
import { requestTokenRolesSync } from '../authz/token-roles.js';

/** What the decider asks for. */
export type Decision = 'approve' | 'reject';

/** `updated_by` value of a decision taken through a signed email link. */
export const LINK_DECIDER = 'admin';

/** The result of a decision, for an HTML page or a JSON response. */
export type DecisionOutcome =
  | { kind: 'decided'; decision: Decision; notified: boolean }
  | {
      kind: 'already_decided';
      status: AggregatorStatus;
      decidedAt: Date;
      /** How it was decided, when the row still says (see {@link deciderOf}). */
      decidedBy: 'link' | 'console' | null;
    }
  | { kind: 'not_found' }
  /** The coordinator's org is no longer active (approve only). */
  | { kind: 'org_inactive' }
  | { kind: 'unavailable'; dependency: 'signalstack' | 'idp' | 'db' };

/** Inputs of {@link decideCoordinator}. */
export interface CoordinatorDecisionInput {
  aggregatorId: string;
  decision: Decision;
  /** Shown to the applicant on reject; never logged or stored. */
  reason?: string;
  /** The deciding admin's user id, or {@link LINK_DECIDER} for an emailed link. */
  decidedBy: string;
  requestId?: string;
  log: FastifyBaseLogger;
}

/** The decision a stored status records, or `null` while pending. */
export function priorDecision(status: AggregatorStatus): 'approved' | 'rejected' | null {
  switch (status) {
    case 'active':
    case 'retired':
      return 'approved';
    case 'inactive':
      return 'rejected';
    default:
      return null;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Returns how a row was decided, read from its `updated_by`.
 *
 * {@link LINK_DECIDER} is an emailed link and an admin's user id is the
 * console. Anything else (such as a later write) gives `null`.
 *
 * @param updatedBy - The row's `updated_by`.
 * @returns `link`, `console`, or `null` when unknown.
 */
export function deciderOf(updatedBy: string | null): 'link' | 'console' | null {
  if (updatedBy === LINK_DECIDER) return 'link';
  return updatedBy && UUID_RE.test(updatedBy) ? 'console' : null;
}

/** The `already_decided` outcome of a decided row. */
function alreadyDecided(row: Coordinator): DecisionOutcome {
  return {
    kind: 'already_decided',
    status: row.status,
    decidedAt: row.status === 'inactive' ? (row.rejectedAt ?? row.updatedAt) : row.updatedAt,
    decidedBy: deciderOf(row.updatedBy),
  };
}

/**
 * Loads a coordinator and its Keycloak user, recording the login link
 * (best effort).
 *
 * @param aggregatorId - Coordinator id.
 * @returns The row and the user, or why they are unavailable.
 */
export async function loadCoordinatorAndUser(
  aggregatorId: string,
): Promise<
  | { ok: true; aggregator: Coordinator; kcUser: IdpUser }
  | { ok: false; reason: 'not_found' | 'db' | 'idp' | 'idp_missing' }
> {
  const stored = await getUserStore().findById(aggregatorId);
  if (!stored.ok) return { ok: false, reason: 'db' };
  if (!stored.value) return { ok: false, reason: 'not_found' };
  const kc = await getIdpAdmin().findByAttribute(KC_ATTR.AGGREGATOR_ID, aggregatorId);
  if (!kc.ok) return { ok: false, reason: 'idp' };
  if (!kc.value) return { ok: false, reason: 'idp_missing' };
  await recordLoginIdentity(aggregatorId, kc.value.id, 'decisions.recordIdentity');
  return { ok: true, aggregator: stored.value, kcUser: kc.value };
}

/** Display name preference: the contact's name, the Keycloak names, the email. */
function applicantName(aggregator: Coordinator, kcUser: IdpUser): string {
  if (aggregator.contact.name) return aggregator.contact.name;
  const parts = [kcUser.firstName, kcUser.lastName].filter((p): p is string => Boolean(p));
  return parts.length > 0 ? parts.join(' ') : kcUser.email;
}

/**
 * Approves or rejects a pending coordinator.
 *
 * @param input - The coordinator, the decision and who takes it.
 * @returns The outcome; never throws.
 */
export async function decideCoordinator(input: CoordinatorDecisionInput): Promise<DecisionOutcome> {
  const log = input.log.child({
    operation: 'coordinator-decision',
    aggregator_id: input.aggregatorId,
  });
  const lookup = await loadCoordinatorAndUser(input.aggregatorId);
  if (!lookup.ok) {
    if (lookup.reason === 'not_found' || lookup.reason === 'idp_missing')
      return { kind: 'not_found' };
    return { kind: 'unavailable', dependency: lookup.reason === 'db' ? 'db' : 'idp' };
  }
  if (priorDecision(lookup.aggregator.status)) return alreadyDecided(lookup.aggregator);
  return input.decision === 'approve'
    ? approve(input, lookup.aggregator, lookup.kcUser, log)
    : reject(input, lookup.aggregator, lookup.kcUser, log);
}

async function approve( // NOSONAR typescript:S3776 — inherently branchy decision flow; splitting would obscure it
  input: CoordinatorDecisionInput,
  aggregator: Coordinator,
  kcUser: IdpUser,
  log: FastifyBaseLogger,
): Promise<DecisionOutcome> {
  const store = getUserStore();
  const idp = getIdpAdmin();

  // The coordinator's org must still be active.
  if (aggregator.parentOrgId) {
    const org = await getOrganisationStore().findById(aggregator.parentOrgId);
    if (!org.ok) return { kind: 'unavailable', dependency: 'db' };
    if (org.value?.status !== 'active') return { kind: 'org_inactive' };
  }

  // 1. Signals first. Until it succeeds the row stays pending; a retry is safe
  //    (idempotent on external_id).
  const signalstack = getSignalStackWriter();
  let signalstackOrgId: string | null = null;
  if (signalstack) {
    const started = Date.now();
    const networkCfg = await getNetworkConfig();
    // The coordinator's known domains; none (or `[]`) means all of them.
    const served = aggregator.serves.filter((d) => networkCfg.domainIds.includes(d));
    const domains = served.length > 0 ? served : networkCfg.domainIds;
    const upsert = await signalstack.upsertAggregator({
      external_id: aggregator.id,
      name: aggregator.name,
      slug: aggregator.orgSlug,
      domains,
      ...(input.requestId ? { requestId: input.requestId } : {}),
    });
    if (!upsert.success) {
      log.error({
        status: 'failure',
        sub_operation: 'signalstack.upsertAggregator',
        code: upsert.error.code,
        latency_ms: Date.now() - started,
      });
      return { kind: 'unavailable', dependency: 'signalstack' };
    }
    signalstackOrgId = upsert.value.org_id;
  }

  // 2. Enable the Keycloak user (idempotent); must succeed to sign in.
  const enable = await idp.enableUser(kcUser.id);
  if (!enable.ok) {
    log.error({ status: 'failure', sub_operation: 'idp.enableUser', code: enable.error.code });
    return { kind: 'unavailable', dependency: 'idp' };
  }
  // 3. The gate attribute. Soft-fail: the enabled flag already admits them, and
  //    the login-time check repairs it.
  const stamp = await idp.setUserDecision(kcUser.id, 'approved');
  if (!stamp.ok) {
    log.warn({ status: 'failure', sub_operation: 'idp.setUserDecision', code: stamp.error.code });
  }
  // 4. Signals org id on Keycloak. Soft-fail: login backfill repairs it.
  //    The row's copy is written after the commit point, so a losing approval
  //    never touches the row.
  if (signalstackOrgId) {
    const attr = await idp.setAttributes(kcUser.id, {
      [KC_ATTR.SIGNALSTACK_ORG_ID]: signalstackOrgId,
    });
    if (!attr.ok)
      log.warn({ status: 'failure', sub_operation: 'idp.setAttributes', code: attr.error.code });
  }

  // 5. The commit point: compare-and-set pending → active.
  const cas = await store.approveFromPending(aggregator.id, input.decidedBy);
  if (!cas.ok || cas.value === null) {
    // Failed or lost. Unless the row is now approved, undo the Keycloak
    // changes, so a user is never enabled while its row is not active.
    const now = await store.findById(aggregator.id);
    const current = now.ok ? now.value : null;
    if (current?.status !== 'active') await compensate(kcUser.id, log);
    if (signalstackOrgId) {
      // The Signals org stays; a later approval reuses it.
      log.warn({ status: 'skipped', sub_operation: 'signalstack.orgLeftByLostApproval' });
    }
    if (!cas.ok) {
      log.error({
        status: 'failure',
        sub_operation: 'store.approveFromPending',
        code: cas.error.code,
      });
      return { kind: 'unavailable', dependency: 'db' };
    }
    if (!current) return { kind: 'not_found' };
    return alreadyDecided(current);
  }
  // RBAC edge: the coordinator now holds its base role; refresh its token claim.
  requestTokenRolesSync([aggregator.id], 'coordinator_approved');
  if (signalstackOrgId) {
    const db = await store.updateSignalstackOrgId(aggregator.id, signalstackOrgId, input.decidedBy);
    if (!db.ok)
      log.warn({
        status: 'failure',
        sub_operation: 'store.updateSignalstackOrgId',
        code: db.error.code,
      });
  }

  const mail = renderApplicantApproved({
    contactName: applicantName(aggregator, kcUser),
    association: aggregator.name,
    identifier: aggregator.contact.email,
    signInUrl: `${config.PUBLIC_PORTAL_URL}/login`,
  });
  const sent = await getMailer().send({
    to: aggregator.contact.email,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
  });
  if (!sent.ok)
    log.error({ status: 'failure', sub_operation: 'mailer.send.approved', code: sent.error.code });
  log.info({ status: 'success', decision: 'approve', decided_by: input.decidedBy });
  return { kind: 'decided', decision: 'approve', notified: sent.ok };
}

/** Disables the user and stamps `rejected` again (a lost or failed approval). */
async function compensate(kcUserId: string, log: FastifyBaseLogger): Promise<void> {
  const idp = getIdpAdmin();
  const [disable, back] = await Promise.all([
    idp.disableUser(kcUserId),
    idp.setUserDecision(kcUserId, 'rejected'),
  ]);
  if (!disable.ok || !back.ok) {
    log.error({
      status: 'failure',
      sub_operation: 'compensate.lostApproval',
      disable: disable.ok ? 'ok' : disable.error.code,
      stamp: back.ok ? 'ok' : back.error.code,
    });
  }
}

async function reject(
  input: CoordinatorDecisionInput,
  aggregator: Coordinator,
  kcUser: IdpUser,
  log: FastifyBaseLogger,
): Promise<DecisionOutcome> {
  const store = getUserStore();
  // Compare-and-set first; only the winner continues.
  const cas = await store.rejectFromPending(aggregator.id, input.decidedBy);
  if (!cas.ok) {
    log.error({
      status: 'failure',
      sub_operation: 'store.rejectFromPending',
      code: cas.error.code,
    });
    return { kind: 'unavailable', dependency: 'db' };
  }
  if (cas.value === null) {
    const now = await store.findById(aggregator.id);
    if (!now.ok) return { kind: 'unavailable', dependency: 'db' };
    if (!now.value) return { kind: 'not_found' };
    return alreadyDecided(now.value);
  }
  // A rejected coordinator loses its additional roles in the org.
  if (aggregator.parentOrgId) {
    await revokeRolesOnLeave(aggregator.id, aggregator.parentOrgId, 'coordinator_rejected');
  }
  requestTokenRolesSync([aggregator.id], 'coordinator_rejected');
  const stamp = await getIdpAdmin().setUserDecision(kcUser.id, 'rejected');
  if (!stamp.ok) {
    log.warn({ status: 'failure', sub_operation: 'idp.setUserDecision', code: stamp.error.code });
  }
  const mail = renderApplicantRejected({
    contactName: applicantName(aggregator, kcUser),
    association: aggregator.name,
    entityLabel: 'coordinator',
    ...(input.reason ? { reason: input.reason } : {}),
  });
  const sent = await getMailer().send({
    to: aggregator.contact.email,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
  });
  if (!sent.ok)
    log.error({ status: 'failure', sub_operation: 'mailer.send.rejected', code: sent.error.code });
  // Never log the reason; it is free text.
  log.info({ status: 'success', decision: 'reject', decided_by: input.decidedBy });
  return { kind: 'decided', decision: 'reject', notified: sent.ok };
}
