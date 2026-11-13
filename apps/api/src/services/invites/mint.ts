/**
 * Coordinator-invite minting (`@aggregator-dpg/api`).
 *
 * Shared by `POST /admin/v1/invites` and `POST /v1/user/create`. Per
 * recipient: validate, de-duplicate, then mint or refresh a 14-day invite and
 * mail it. If the address already has an account:
 *
 *   - a coordinator of this org: nothing is mailed; reported as `existing`;
 *   - any other account: a "you already have an account" mail is sent and an
 *     invite row is still kept, so the counts look the same as for a fresh
 *     address and cannot be used to probe other orgs' members.
 */

import type { FastifyBaseLogger } from 'fastify';
import type { MailerAdapter } from '@aggregator-dpg/mailer';
import type { AggregatorStatus } from '@aggregator-dpg/shared-primitives/aggregator';
import { isEmailAddress } from '@aggregator-dpg/shared-primitives/phone';
import { config } from '../../config.js';
import { getUserStore } from '../user-store/index.js';
import { getOrganisationStore } from '../organisation-store/index.js';
import type { getRegistrationInvitesStore } from '../registration-invites-store/index.js';
import { mintInviteToken } from '../invite-token.js';
import { renderCoordinatorInvite, renderInviteExistingAccount } from '../email-templates/index.js';

/** One invite recipient. */
export interface InviteRecipient {
  email: string;
  name?: string | undefined;
}

/** Result of minting a batch of recipients. */
export interface MintSummary {
  sent: number;
  resent: number;
  invalid: Array<{ email: string; reason: string }>;
  /** Addresses already registered as coordinators of this org (nothing mailed). */
  existing: Array<{ email: string; status: AggregatorStatus }>;
}

/** Inputs for {@link mintInviteBatch}. */
export interface MintBatchDeps {
  invites: ReturnType<typeof getRegistrationInvitesStore>;
  mailer: MailerAdapter;
  orgId: string;
  orgName: string;
  /** The inviting org's contact (owner email) — sender identity in the email. */
  inviterEmail: string;
  recipients: InviteRecipient[];
  ttlSec: number;
  /** Audit value stored on the invite row (`grant:<org>` or the admin's user id). */
  createdBy: string;
  log: FastifyBaseLogger;
}

/** Builds the coordinator registration URL carrying an invite token. */
function inviteUrl(token: string): string {
  return `${config.PUBLIC_PORTAL_URL}/register/coordinator?invite=${encodeURIComponent(token)}`;
}

/** Formats an absolute expiry date for the invite email (e.g. "15 Sep 2026"). */
function formatExpiryDate(d: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(d);
}

/** One recipient outcome after resolving its invite row. */
interface ResolvedInvite {
  jti: string;
  refreshed: boolean;
}

/**
 * Resolves the invite row for one (org, email): refreshes a pending invite or
 * creates one (refreshing on a unique-key race). Returns the `jti` and whether
 * it was a refresh, or `null` on a store error.
 */
async function resolveInviteJti(
  invites: MintBatchDeps['invites'],
  orgId: string,
  email: string,
  expiresAt: Date,
  createdBy: string,
): Promise<ResolvedInvite | null> {
  const existing = await invites.findPendingByOrgAndEmail(orgId, email);
  if (!existing.ok) return null;
  if (existing.value) {
    const refreshed = await invites.refresh(existing.value.jti, { expiresAt, createdBy });
    return refreshed.ok ? { jti: refreshed.value.jti, refreshed: true } : null;
  }
  const created = await invites.create({ parentOrgId: orgId, email, expiresAt, createdBy });
  if (created.ok) return { jti: created.value.jti, refreshed: false };
  if (created.error.code === 'DUPLICATE_PENDING') {
    const again = await invites.findPendingByOrgAndEmail(orgId, email);
    if (again.ok && again.value) {
      const refreshed = await invites.refresh(again.value.jti, { expiresAt, createdBy });
      return refreshed.ok ? { jti: refreshed.value.jti, refreshed: true } : null;
    }
  }
  return null;
}

/** Who already holds an address, as far as inviting is concerned. */
type AccountMatch =
  | { kind: 'none' }
  | { kind: 'own_coordinator'; status: AggregatorStatus }
  | { kind: 'other_account' }
  | { kind: 'error' };

/**
 * Looks the address up among coordinators, org owners and the root / Default owners.
 */
async function accountFor(email: string, orgId: string): Promise<AccountMatch> {
  const coordinator = await getUserStore().findByContactEmail(email);
  if (!coordinator.ok) return { kind: 'error' };
  if (coordinator.value) {
    return coordinator.value.parentOrgId === orgId
      ? { kind: 'own_coordinator', status: coordinator.value.status }
      : { kind: 'other_account' };
  }
  const orgStore = getOrganisationStore();
  const [owner, root, def] = await Promise.all([
    orgStore.findByOwnerEmail(email),
    orgStore.findRoot(),
    orgStore.findDefault(),
  ]);
  if (!owner.ok || !root.ok || !def.ok) return { kind: 'error' };
  if (owner.value || root.value?.ownerEmail === email || def.value?.ownerEmail === email) {
    return { kind: 'other_account' };
  }
  return { kind: 'none' };
}

/** Batch-wide inputs shared by every recipient. */
type BatchContext = Omit<MintBatchDeps, 'recipients'>;

/** What happened to one recipient that reached the mailer. */
type SendOutcome = 'sent' | 'resent' | 'store_error';

/**
 * Keeps an invite row for an address that already has another account and
 * mails it a "you already have an account" note, so counts match a fresh
 * address (no account oracle).
 */
async function inviteExistingAccount(ctx: BatchContext, email: string): Promise<SendOutcome> {
  const expiresAt = new Date(Date.now() + ctx.ttlSec * 1000);
  const kept = await resolveInviteJti(ctx.invites, ctx.orgId, email, expiresAt, ctx.createdBy);
  if (!kept) return 'store_error';
  const mail = renderInviteExistingAccount({
    orgName: ctx.orgName,
    signInUrl: `${config.PUBLIC_PORTAL_URL}/login`,
  });
  const send = await ctx.mailer.send({
    to: email,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
  });
  if (!send.ok) {
    ctx.log.warn({
      status: 'failure',
      sub_operation: 'mailer.send.inviteExistingAccount',
      code: send.error.code,
    });
  }
  return kept.refreshed ? 'resent' : 'sent';
}

/** Mints or refreshes an invite for a new address and mails the registration link. */
async function inviteNewAddress(
  ctx: BatchContext,
  email: string,
  recipientName: string | undefined,
): Promise<SendOutcome> {
  const expiresAt = new Date(Date.now() + ctx.ttlSec * 1000);
  const resolved = await resolveInviteJti(ctx.invites, ctx.orgId, email, expiresAt, ctx.createdBy);
  if (!resolved) return 'store_error';
  const { token } = await mintInviteToken({ jti: resolved.jti, org: ctx.orgId, email });
  const mail = renderCoordinatorInvite({
    orgName: ctx.orgName,
    inviterEmail: ctx.inviterEmail,
    inviteUrl: inviteUrl(token),
    expiresOn: formatExpiryDate(expiresAt),
    ...(recipientName ? { recipientName } : {}),
  });
  const send = await ctx.mailer.send({
    to: email,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
  });
  if (!send.ok) {
    ctx.log.warn(
      {
        status: 'failure',
        sub_operation: 'mailer.send.coordinatorInvite',
        code: send.error.code,
      },
      'coordinator-invite email delivery failed (invite minted)',
    );
  }
  return resolved.refreshed ? 'resent' : 'sent';
}

/** Adds one recipient's outcome to the batch summary. */
function tally(summary: MintSummary, email: string, outcome: SendOutcome): void {
  if (outcome === 'store_error') summary.invalid.push({ email, reason: 'store_error' });
  else summary[outcome] += 1;
}

/**
 * Mints or refreshes and emails an invite per recipient. Invalid and duplicate
 * addresses are bucketed; existing accounts are handled as in the module doc.
 * A failed email is logged and still counted as sent. Recipients are handled
 * one at a time, in order.
 *
 * @param deps - Store, mailer, org, recipients, and token settings.
 * @returns Per-batch counts, the invalid list and own-org existing members.
 */
export async function mintInviteBatch(deps: MintBatchDeps): Promise<MintSummary> {
  const { recipients, ...ctx } = deps;
  const summary: MintSummary = { sent: 0, resent: 0, invalid: [], existing: [] };
  // De-duplicate within the batch.
  const seen = new Set<string>();

  for (const recipient of recipients) {
    const email = recipient.email.trim().toLowerCase();
    if (!isEmailAddress(email)) {
      summary.invalid.push({ email: recipient.email, reason: 'invalid_email' });
      continue;
    }
    if (seen.has(email)) {
      summary.invalid.push({ email: recipient.email, reason: 'duplicate_in_batch' });
      continue;
    }
    seen.add(email);

    const account = await accountFor(email, ctx.orgId); // NOSONAR typescript:S9382 — sequential by design
    if (account.kind === 'error') {
      summary.invalid.push({ email: recipient.email, reason: 'store_error' });
    } else if (account.kind === 'own_coordinator') {
      summary.existing.push({ email: recipient.email, status: account.status });
    } else if (account.kind === 'other_account') {
      tally(summary, recipient.email, await inviteExistingAccount(ctx, email)); // NOSONAR typescript:S9382 — sequential by design
    } else {
      tally(summary, recipient.email, await inviteNewAddress(ctx, email, recipient.name)); // NOSONAR typescript:S9382 — sequential by design
    }
  }
  return summary;
}
