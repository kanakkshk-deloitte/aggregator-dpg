/**
 * Shared helpers of the console routes `/v1/user/*` and `/v1/org/*` in
 * `@aggregator-dpg/api`: wire mappers, keyset cursors, the per-actor write
 * limit, decision-outcome mapping, the owner notice and the org tree error
 * mapping (also used by org registration).
 *
 * Console logs carry actor id, target id and field names only. Never log
 * values, contact data or a decision reason.
 */

import type { FastifyBaseLogger, FastifyReply } from 'fastify';
import { getMailer } from '@aggregator-dpg/mailer';
import type { Org, User } from '@aggregator-dpg/shared-primitives/user-org';
import { config } from '../config.js';
import { httpError } from '../errors/http-error.js';
import type { Coordinator } from '../services/user-store/index.js';
import type { Organisation, OrgStoreError } from '../services/organisation-store/index.js';
import type { CoordinatorCursor } from '../services/user-store/interface.js';
import type { OrgCursor } from '../services/organisation-store/interface.js';
import { isNetworkAdmin, type Actor } from '../services/auth/actor/index.js';
import { checkConsoleWriteRate } from '../services/console-rate.js';
import { renderOrgAdminAction, renderOrgKnownAs } from '../services/email-templates/index.js';
import type { DecisionOutcome } from '../services/decisions/coordinator.js';

/** The console's landing URL, used in owner notices. */
export function consoleUrl(): string {
  return `${config.PUBLIC_PORTAL_URL}/console`;
}

/**
 * Masks an email address as `a***@example.org`.
 *
 * @param email - The address.
 * @returns The masked address; `***` when it has no `@`.
 */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}

/**
 * Masks a phone number to its last four digits (`******1234`).
 *
 * @param phone - The number, or null.
 * @returns The masked number, or null.
 */
export function maskPhone(phone: string | null): string | null {
  if (phone === null) return null;
  const digits = phone.replace(/\D/g, '');
  return digits.length <= 4 ? '****' : `${'*'.repeat(digits.length - 4)}${digits.slice(-4)}`;
}

/**
 * Maps a coordinator to its wire shape.
 *
 * @param a - The coordinator.
 * @param opts - `masked` hides the email and phone; set when the caller lacks `contact.unmask`.
 * @returns The `UserSchema` shape.
 */
export function toWireUser(a: Coordinator, opts: { masked?: boolean } = {}): User {
  const phone = a.contact.phone ?? null;
  return {
    id: a.id,
    user_type: 'coordinator',
    status: a.status,
    name: a.name,
    contact: {
      name: a.contact.name ?? null,
      email: opts.masked ? maskEmail(a.contact.email) : a.contact.email,
      phone: opts.masked ? maskPhone(phone) : phone,
    },
    serves: a.serves,
    org_id: a.parentOrgId,
    invited: a.inviteId !== null,
    created_at: a.createdAt.toISOString(),
    updated_at: a.updatedAt.toISOString(),
    rejected_at: a.rejectedAt ? a.rejectedAt.toISOString() : null,
  };
}

/**
 * Maps an organisation to its wire shape.
 *
 * The root carries no "known as" value. The name comes from the store,
 * resolved from the parent's list.
 *
 * @param o - The org.
 * @param orgType - `network_facilitator` for the root, else `aggregator`.
 * @returns The `OrgSchema` shape.
 */
export function toWireOrg(
  o: Organisation,
  orgType: 'network_facilitator' | 'aggregator' = 'aggregator',
): Org {
  const isRoot = orgType === 'network_facilitator';
  return {
    id: o.id,
    slug: o.slug,
    name: o.displayName,
    org_type: orgType,
    status: o.status,
    is_default: o.isDefault,
    locations: o.locations,
    legal_name: o.legalName,
    known_as: isRoot ? null : o.knownAs,
    known_as_name: isRoot ? null : o.knownAsName,
    depth: o.depth,
    parent_id: o.parentId,
    parent_name: o.parentName,
    description: o.description,
    profile: o.profile,
    profile_ref: o.profileRef,
    created_at: o.createdAt.toISOString(),
    updated_at: o.updatedAt.toISOString(),
  };
}

/** The owner's contact on the wire. */
export function ownerContact(
  o: Organisation,
  opts: { masked?: boolean } = {},
): {
  name: string | null;
  email: string;
  phone: string | null;
} {
  return {
    name: o.ownerName,
    email: opts.masked ? maskEmail(o.ownerEmail) : o.ownerEmail,
    phone: opts.masked ? maskPhone(o.ownerPhone) : o.ownerPhone,
  };
}

const encode = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64url');

function decode(cursor: string): unknown {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
  } catch {
    // An unreadable cursor is a client error, answered below.
    return null;
  }
}

const badCursor = () =>
  httpError('SCHEMA_VALIDATION', { detail: 'cursor is invalid', fields: { field: 'cursor' } });

/** Encodes a coordinator page cursor. */
export function encodeUserCursor(c: CoordinatorCursor): string {
  return encode({ c: c.createdAt.toISOString(), i: c.id });
}

/**
 * Decodes a coordinator page cursor.
 *
 * @throws {HttpError} SCHEMA_VALIDATION when malformed.
 */
export function decodeUserCursor(cursor: string): CoordinatorCursor {
  const v = decode(cursor) as { c?: unknown; i?: unknown } | null;
  if (!v || typeof v.c !== 'string' || typeof v.i !== 'string') throw badCursor();
  const createdAt = new Date(v.c);
  if (Number.isNaN(createdAt.getTime())) throw badCursor();
  return { createdAt, id: v.i };
}

/** Encodes an org page cursor. */
export function encodeOrgCursor(c: OrgCursor): string {
  return encode({ n: c.name, i: c.id });
}

/**
 * Decodes an org page cursor.
 *
 * @throws {HttpError} SCHEMA_VALIDATION when malformed.
 */
export function decodeOrgCursor(cursor: string): OrgCursor {
  const v = decode(cursor) as { n?: unknown; i?: unknown } | null;
  if (!v || typeof v.n !== 'string' || typeof v.i !== 'string') throw badCursor();
  return { name: v.n, id: v.i };
}

/**
 * Consumes one console write for the actor, or throws `RATE_LIMITED`.
 *
 * @param actor - The acting admin.
 * @param reply - For the `Retry-After` header.
 * @throws {HttpError} RATE_LIMITED.
 */
export async function guardWriteRate(actor: Actor, reply: FastifyReply): Promise<void> {
  const rl = await checkConsoleWriteRate(actor.userId);
  if (rl.allowed) return;
  void reply.header('Retry-After', String(rl.retryAfterSeconds));
  throw httpError('RATE_LIMITED', {
    detail: `Retry in ${rl.retryAfterSeconds}s.`,
    fields: { retry_after_seconds: rl.retryAfterSeconds },
  });
}

/**
 * Throws the HTTP error of a coordinator decision that did not succeed.
 *
 * @param outcome - A non-`decided` outcome.
 * @throws {HttpError} Always.
 */
export function throwDecisionFailure(
  outcome: Exclude<DecisionOutcome, { kind: 'decided' }>,
): never {
  switch (outcome.kind) {
    case 'already_decided':
      throw httpError('ALREADY_DECIDED', {
        fields: {
          status: outcome.status,
          decided_at: outcome.decidedAt.toISOString(),
          decided_by: outcome.decidedBy,
        },
      });
    case 'not_found':
      throw httpError('NOT_FOUND');
    case 'org_inactive':
      throw httpError('TARGET_ORG_INACTIVE');
    case 'unavailable':
      if (outcome.dependency === 'signalstack') throw httpError('SIGNALSTACK_PUSH_FAILED');
      if (outcome.dependency === 'idp') throw httpError('IDP_UNAVAILABLE');
      throw httpError('DB_UNAVAILABLE');
  }
}

/**
 * Emails an org's owner that the network admin acted in their org.
 *
 * Skipped when the actor owns the org. A failed send is logged and never fails the action.
 *
 * @param actor - The acting admin.
 * @param org - The org acted on.
 * @param action - What was done, e.g. "approved a coordinator" (no values).
 * @param log - Request logger.
 */
export async function notifyOwnerOfAdminAction(
  actor: Actor,
  org: Organisation,
  action: string,
  log: FastifyBaseLogger,
): Promise<void> {
  if (!isNetworkAdmin(actor) || org.ownerUserId === actor.userId) return;
  const mail = renderOrgAdminAction({ orgName: org.displayName, action, consoleUrl: consoleUrl() });
  const sent = await getMailer().send({
    to: org.ownerEmail,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
  });
  if (!sent.ok) {
    log.warn({
      status: 'failure',
      sub_operation: 'mailer.send.orgAdminAction',
      org_id: org.id,
      code: sent.error.code,
    });
  }
}

/**
 * Emails an org's owner that the owner of the parent org changed what the org is known as.
 *
 * For a top-level org the parent is the network, so the email names the
 * network administrator. Skipped when the actor owns the org. A failed send is
 * logged and never fails the action.
 *
 * @param actor - The acting admin, the parent's owner.
 * @param org - The org acted on.
 * @param log - Request logger.
 */
export async function notifyOwnerOfParentAction(
  actor: Actor,
  org: Organisation,
  log: FastifyBaseLogger,
): Promise<void> {
  if (org.ownerUserId === actor.userId) return;
  const mail =
    org.depth <= 1 || org.parentName === null
      ? renderOrgAdminAction({
          orgName: org.displayName,
          action: 'changed what the organisation is known as',
          consoleUrl: consoleUrl(),
        })
      : renderOrgKnownAs({
          orgName: org.displayName,
          parentName: org.parentName,
          consoleUrl: consoleUrl(),
        });
  const sent = await getMailer().send({
    to: org.ownerEmail,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
  });
  if (!sent.ok) {
    log.warn({
      status: 'failure',
      sub_operation: 'mailer.send.orgKnownAs',
      org_id: org.id,
      code: sent.error.code,
    });
  }
}

/**
 * Throws the HTTP error for an organisation tree refusal from the store.
 *
 * Returns without throwing for any other store error, so the caller maps it.
 *
 * @param e - The store error.
 * @param fields - Error fields added to `ORG_DEPTH_LIMIT` and `ORG_CHILD_LIMIT`.
 * @throws {HttpError} CONFLICT, SCHEMA_VALIDATION, ORG_PARENT_CYCLE, ORG_DEPTH_LIMIT, ORG_CHILD_LIMIT or ORG_TOTAL_LIMIT.
 */
export function throwTreeRefusal(e: OrgStoreError, fields?: Record<string, unknown>): void {
  const limitFields = fields ? { fields } : {};
  switch (e.code) {
    case 'NOT_MOVABLE':
      throw httpError('CONFLICT', {
        detail: 'This organisation cannot be moved.',
        fields: { reason: 'not_movable' },
      });
    case 'ORG_BUSY':
      throw httpError('CONFLICT', {
        detail: 'The organisation is being changed. Try again.',
        fields: { reason: 'busy' },
      });
    case 'INVALID_PARENT':
      throw httpError('SCHEMA_VALIDATION', {
        detail: 'The parent must be the network or an active organisation.',
        fields: { parent_id: 'invalid' },
      });
    case 'PARENT_CYCLE':
      throw httpError('ORG_PARENT_CYCLE');
    case 'DEPTH_LIMIT':
      throw httpError('ORG_DEPTH_LIMIT', limitFields);
    case 'CHILD_LIMIT':
      throw httpError('ORG_CHILD_LIMIT', limitFields);
    case 'TOTAL_LIMIT':
      throw httpError('ORG_TOTAL_LIMIT');
    default:
      return;
  }
}
