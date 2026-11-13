/**
 * Organisation registration decision and owner access (`@aggregator-dpg/api`).
 *
 * `decideOrg` is the one place a pending aggregator org is approved or
 * rejected, used by the emailed review link (`routes/aggregator-org-approvals.ts`)
 * and the console (`POST /v1/org/decision/:id`). Both are a compare-and-set
 * from `pending` first; only the winner provisions and mails.
 *
 * `grantOwnerAccess` lets an owner sign in: enables their Keycloak user,
 * grants the `org_owner` realm role and adds the org's group. It runs at
 * approval, from "repair access", and in the `enable-owners` tool step. Idempotent.
 */

import type { FastifyBaseLogger } from 'fastify';
import { getMailer } from '@aggregator-dpg/mailer';
import type { AggregatorStatus } from '@aggregator-dpg/shared-primitives/aggregator';
import { config } from '../../config.js';
import { getOrganisationStore, type Organisation } from '../organisation-store/index.js';
import { getIdpAdmin, OWNER_REALM_ROLE } from '../idp-admin/index.js';
import { renderApplicantRejected, renderOrgOwnerApproved } from '../email-templates/index.js';
import { deciderOf, type Decision } from './coordinator.js';
import { requestTokenRolesSync } from '../authz/token-roles.js';

/** The `already_decided` outcome of a decided org. */
function alreadyDecided(org: Organisation): OrgDecisionOutcome {
  return {
    kind: 'already_decided',
    status: org.status,
    decidedAt: org.status === 'inactive' ? (org.rejectedAt ?? org.updatedAt) : org.updatedAt,
    decidedBy: deciderOf(org.updatedBy),
  };
}

/** The realm role the portal gate admits owners by. */
export const OWNER_ROLE = OWNER_REALM_ROLE;

/** The result of an org decision. */
export type OrgDecisionOutcome =
  | { kind: 'decided'; decision: Decision; notified: boolean; ownerAccess: OwnerAccessResult }
  | {
      kind: 'already_decided';
      status: AggregatorStatus;
      decidedAt: Date;
      /** How it was decided, when the row still says (see `deciderOf`). */
      decidedBy: 'link' | 'console' | null;
    }
  | { kind: 'not_found' }
  | { kind: 'unavailable'; dependency: 'db' };

/** Inputs of {@link decideOrg}. */
export interface OrgDecisionInput {
  orgId: string;
  decision: Decision;
  /** Shown to the owner on reject; never logged or stored. */
  reason?: string;
  /** The deciding admin's user id, or `'admin'` for an emailed link. */
  decidedBy: string;
  log: FastifyBaseLogger;
}

/** Outcome of one owner-access provisioning step. */
export type OwnerAccessStepResult = 'ok' | 'failed' | 'skipped';

/** What {@link grantOwnerAccess} achieved; any `failed` step can be retried. */
export interface OwnerAccessResult {
  /** `no_login`: the owner has no recorded Keycloak user. */
  status: 'granted' | 'partial' | 'no_login';
  enable: OwnerAccessStepResult;
  role: OwnerAccessStepResult;
  group: OwnerAccessStepResult;
}

/** The sign-in link owners are sent (the console is reached after sign-in). */
export function ownerSignInUrl(): string {
  return `${config.PUBLIC_PORTAL_URL}/login`;
}

/**
 * Lets an org's owner sign in: enables their Keycloak user, assigns the
 * `org_owner` role, adds them to the org's group. Each step is attempted even
 * when an earlier one fails; failures are logged (codes only).
 *
 * @param org - The org (its `ownerKcSub` and `kcGroupId`).
 * @param log - Logger.
 * @returns Per-step results.
 */
export async function grantOwnerAccess( // NOSONAR typescript:S3776 — inherently branchy decision flow; splitting would obscure it
  org: Organisation,
  log: FastifyBaseLogger,
): Promise<OwnerAccessResult> {
  const sub = org.ownerKcSub;
  if (!sub) {
    log.warn({
      operation: 'owner-access.grant',
      status: 'skipped',
      org_id: org.id,
      reason: 'no_login',
    });
    return { status: 'no_login', enable: 'skipped', role: 'skipped', group: 'skipped' };
  }
  const idp = getIdpAdmin();
  const enable = await idp.enableUser(sub);
  const role = await idp.assignRealmRole(sub, OWNER_ROLE);
  const group = org.kcGroupId ? await idp.addUserToGroup(sub, org.kcGroupId) : null;
  let groupStatus: OwnerAccessStepResult;
  if (group === null) {
    groupStatus = 'skipped';
  } else {
    groupStatus = group.ok ? 'ok' : 'failed';
  }
  const result: OwnerAccessResult = {
    status: 'granted',
    enable: enable.ok ? 'ok' : 'failed',
    role: role.ok ? 'ok' : 'failed',
    group: groupStatus,
  };
  if (result.enable === 'failed' || result.role === 'failed' || result.group === 'failed') {
    result.status = 'partial';
    let groupDetail: string;
    if (group === null) {
      groupDetail = 'skipped';
    } else {
      groupDetail = group.ok ? 'ok' : group.error.code;
    }
    log.warn({
      operation: 'owner-access.grant',
      status: 'failure',
      org_id: org.id,
      enable: enable.ok ? 'ok' : enable.error.code,
      role: role.ok ? 'ok' : role.error.code,
      group: groupDetail,
    });
  }
  return result;
}

/**
 * Approves or rejects a pending aggregator org.
 *
 * @param input - The org, the decision and who takes it.
 * @returns The outcome; never throws.
 */
export async function decideOrg(input: OrgDecisionInput): Promise<OrgDecisionOutcome> {
  // NOSONAR typescript:S3776 — inherently branchy decision flow; splitting would obscure it
  const log = input.log.child({ operation: 'org-decision', org_id: input.orgId });
  const store = getOrganisationStore();
  const found = await store.findById(input.orgId);
  if (!found.ok) return { kind: 'unavailable', dependency: 'db' };
  if (!found.value || found.value.isDefault) return { kind: 'not_found' };
  const org = found.value;
  if (org.status !== 'pending') return alreadyDecided(org);

  const cas =
    input.decision === 'approve'
      ? await store.approve(org.id, input.decidedBy)
      : await store.reject(org.id, input.decidedBy);
  if (!cas.ok) {
    log.error({
      status: 'failure',
      sub_operation: `store.${input.decision}`,
      code: cas.error.code,
    });
    return { kind: 'unavailable', dependency: 'db' };
  }
  if (cas.value === null) {
    const now = await store.findById(org.id);
    if (!now.ok) return { kind: 'unavailable', dependency: 'db' };
    if (!now.value) return { kind: 'not_found' };
    return alreadyDecided(now.value);
  }
  if (input.decision === 'reject') {
    const mail = renderApplicantRejected({
      association: org.displayName,
      entityLabel: 'organisation',
      ...(input.reason ? { reason: input.reason } : {}),
    });
    const sent = await getMailer().send({
      to: org.ownerEmail,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    });
    if (!sent.ok)
      log.warn({
        status: 'failure',
        sub_operation: 'mailer.send.orgRejected',
        code: sent.error.code,
      });
    // Never log the reason; it is free text.
    log.info({ status: 'success', decision: 'reject', decided_by: input.decidedBy });
    return {
      kind: 'decided',
      decision: 'reject',
      notified: sent.ok,
      ownerAccess: { status: 'no_login', enable: 'skipped', role: 'skipped', group: 'skipped' },
    };
  }

  // Approved: give the owner sign-in access. Soft-fail per step; "repair access" re-runs it.
  const ownerAccess = await grantOwnerAccess(org, log);
  // RBAC edge: the owner now holds Org Admin in this organisation.
  requestTokenRolesSync([org.ownerUserId], 'org_approved');
  const mail = renderOrgOwnerApproved({
    orgName: org.displayName,
    ownerEmail: org.ownerEmail,
    inviteUrl: ownerSignInUrl(),
  });
  const sent = await getMailer().send({
    to: org.ownerEmail,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
  });
  if (!sent.ok)
    log.warn({
      status: 'failure',
      sub_operation: 'mailer.send.orgOwnerApproved',
      code: sent.error.code,
    });
  log.info({
    status: 'success',
    decision: 'approve',
    decided_by: input.decidedBy,
    owner_access: ownerAccess.status,
  });
  return { kind: 'decided', decision: 'approve', notified: sent.ok, ownerAccess };
}
