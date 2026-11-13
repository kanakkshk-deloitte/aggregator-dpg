/**
 * Coordinator registration endpoints in `@aggregator-dpg/api`.
 *
 * Public submission flow:
 *   1. Validate the body with Zod and with `registration.v1.json` (Ajv). The
 *      JSON Schema is the form contract.
 *   2. Normalise `contact.phone` to E.164.
 *   3. Check email and phone uniqueness in the database and Keycloak.
 *   4. Generate `org_slug` from the name, retrying on a collision.
 *   5. Insert the coordinator (`pending`) and its consent row in one
 *      transaction. Extra schema fields go into `profile`.
 *   6. Create a disabled Keycloak user with `aggregator_id`,
 *      `aggregator_type`, `phoneNumber` and `decision_made: 'pending'`.
 *      Approval enables it.
 *   7. Email the review link to the org owner (see `resolveOwnerRouting`).
 *
 * A consent-ledger failure rolls the insert back. A Keycloak failure after the
 * commit deletes the coordinator row; its consent row stays, unlinked.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { RegistrationPayloadSchema } from '@aggregator-dpg/shared-primitives/aggregator';
import type { BecknContact, BecknLocation } from '@aggregator-dpg/shared-primitives/aggregator';
import { getRegistrationValidator } from '../services/registration-validator.js';
import { getUserStore } from '../services/user-store/index.js';
import { stampConsent } from '../services/registration-consent.js';
import type {
  Coordinator,
  LegacyOrgDetails,
  RecordConsentHook,
} from '../services/user-store/interface.js';
import { getOrganisationStore } from '../services/organisation-store/index.js';
import { getRegistrationInvitesStore } from '../services/registration-invites-store/index.js';
import { verifyInviteToken } from '../services/invite-token.js';
import { getIdpAdmin } from '../services/idp-admin/index.js';
import { sendAdminReviewEmail } from '../services/registration-notify.js';
import { defaultOrgOwnerEmail } from '../config.js';
import { coolingRetryAfter } from '../services/registration-cooling.js';
import { checkSubmitRate } from '../services/submit-rate.js';
import { loadConsentConfig } from '@aggregator-dpg/config-loader/fs';
import { getConsentLedger } from '../services/consent-ledger/index.js';
import { resolveActiveNetwork } from '@aggregator-dpg/network-config/paths';
import { getNetworkConfig } from '../services/network-config.js';
import { resolveProfileRef } from '../services/schema-ref.js';
import { normalisePhone } from '@aggregator-dpg/shared-primitives/phone';
import { splitName } from '../services/name.js';
import { slugFromName } from '../services/slug.js';
import { authenticateAny } from '../services/auth/access-token.js';
import { KC_ATTR } from '../services/idp-admin/index.js';
import { httpError } from '../errors/http-error.js';
import { errorResponses } from '../errors/openapi.js';
import type { ErrorCode } from '../errors/codes.js';
import { callerFromAny, recordRouteCaller } from '../services/authz/index.js';

const SLUG_RETRIES = 3;

// Adds `org_id` and `invite` to the strict payload schema.
const CoordinatorRegistrationBodySchema = RegistrationPayloadSchema.extend({
  org_id: z.string().optional(),
  // Invite token. When present it replaces `org_id` and is consumed on submit.
  invite: z.string().optional(),
});

/**
 * Body keys stored elsewhere, so never copied into `profile`.
 */
const AGGREGATOR_COLUMN_BACKED_KEYS: ReadonlySet<string> = new Set([
  'name',
  'type',
  'url',
  'contact',
  'locations',
  'consent',
  'org_id',
  'invite',
]);

/**
 * Collects the schema-driven fields of a registration body into the `profile` payload.
 *
 * The JSON Schema (`additionalProperties: false`) bounds which keys can appear.
 *
 * @param body - Validated coordinator-registration body.
 * @returns The `profile` payload; `{}` when the deployment declares no extra fields.
 */
function buildAggregatorProfile(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(body).filter(
      ([key, value]) => !AGGREGATOR_COLUMN_BACKED_KEYS.has(key) && value !== undefined,
    ),
  );
}

const RegistrationCreatedResponseSchema = z
  .object({
    aggregator_id: z.string(),
    org_slug: z.string(),
    status: z.string(),
    message: z.string(),
  })
  .passthrough();

export async function registerAggregatorRegistrationRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/v1/aggregator-registrations/create',
    {
      config: { rbac: { access: 'service' } },
      schema: {
        tags: ['aggregator-registrations'],
        summary: 'Submit a new aggregator registration',
        description:
          'Validates submission against config/schemas/aggregator/registration.v1.json, creates a disabled user (login enabled on admin approval), and pushes the org to signalstack. Reached via a non-aggregator Bearer token from Keycloak.',
        body: CoordinatorRegistrationBodySchema,
        response: {
          201: RegistrationCreatedResponseSchema,
          ...errorResponses(400, 401, 409, 500, 503),
        },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const log = req.log.child({ operation: 'aggregator-registration.create' });
      const start = Date.now();

      // Invite claimed by this request, before anything is created. Unless the
      // registration completes, the `finally` below gives it back.
      let inviteJti: string | null = null;
      let inviteCommitted = false;
      try {
        // Re-sends the review link for an existing pending or revived record
        // using stored values. The anonymous submit never changes the record: it
        // carries no proof of identity, so a stranger must not overwrite it.
        const reclaimReview = async (row: Coordinator): Promise<FastifyReply> => {
          await sendAdminReviewEmail(
            {
              aggregatorId: row.id,
              applicantName: row.name,
              applicantEmail: row.contact.email,
              applicantPhone: row.contactPhone,
              ...(row.inviteEmail ? { invitedEmail: row.inviteEmail } : {}),
              ...(await resolveOwnerRouting(row.parentOrgId)),
            },
            log,
          );
          log.info(
            {
              status: 'success',
              latency_ms: Date.now() - start,
              aggregator_id: row.id,
              reclaim: true,
            },
            'registration re-submitted — review link re-sent (no field change)',
          );
          // Consent is recorded only on a fresh registration, not here.
          return reply.status(200).send({
            aggregator_id: row.id,
            org_slug: row.orgSlug,
            status: 'pending',
            message: 'Registration re-submitted. A fresh approval link has been sent for review.',
          });
        };

        // The BFF calls this with a service-account token, so no
        // `aggregator_id` claim is required.
        const auth = await authenticateAny(req);
        if (!auth.ok) {
          throw httpError('UNAUTHORIZED', {
            detail: auth.error.message,
            fields: { reason: auth.error.code },
          });
        }
        await recordRouteCaller(req, callerFromAny(auth.context));

        // Already validated and parsed by the route schema.
        const body = req.body as z.infer<typeof RegistrationPayloadSchema>;

        // `type` must be one of the network's domain ids.
        const networkCfg = await getNetworkConfig();
        if (!networkCfg.domainIds.includes(body.type)) {
          throw httpError('SCHEMA_VALIDATION', {
            detail: `unknown type '${body.type}' — valid: ${networkCfg.domainIds.join(', ')}`,
            fields: { type: 'invalid' },
          });
        }

        // `org_id` and `invite` are not form fields; strip them before Ajv.
        const {
          org_id: _orgIdField,
          invite: _inviteField,
          ...formBody
        } = req.body as Record<string, unknown>;

        const validate = await getRegistrationValidator();
        if (!validate(formBody)) {
          throw httpError('SCHEMA_VALIDATION', {
            detail: 'Payload failed JSON Schema validation.',
            fields: { issues: validate.errors ?? [] },
          });
        }
        const phoneResult = normalisePhone(body.contact.phone);
        if (!phoneResult.ok) {
          throw httpError('INVALID_PHONE', {
            detail: phoneResult.error.message,
            // Keyed `phone` so the logger redacts it.
            fields: { phone: body.contact.phone },
          });
        }
        const phoneE164 = phoneResult.value;
        // Store the E.164 phone. Zod has already lowercased the email.
        const contact: BecknContact = {
          ...body.contact,
          phone: phoneE164,
        };

        const userStore = getUserStore();
        const idp = getIdpAdmin();

        // Stamp consent with the server time. `valid_till` is clamped to a maximum.
        const serverConsent = stampConsent(body.consent);
        if (!serverConsent) {
          throw httpError('SCHEMA_VALIDATION', {
            detail: 'consent.valid_till must be in the future.',
            fields: { 'consent.valid_till': 'invalid' },
          });
        }

        // Rate limit per (ip, email). Fails open so a Redis outage does not block registration.
        const rl = await checkSubmitRate(`${req.ip}|${contact.email}`);
        if (!rl.allowed) {
          void reply.header('Retry-After', String(rl.retryAfterSeconds));
          throw httpError('RATE_LIMITED', {
            detail: `Retry in ${rl.retryAfterSeconds}s.`,
            fields: { retry_after_seconds: rl.retryAfterSeconds },
          });
        }

        // The coordinator's org; must be active.
        let parentOrgId: string;
        let orgIsDefault = false;
        // The invited email. The coordinator may register with another one;
        // this is kept so the approving owner can see it.
        let inviteEmailClaim: string | null = null;
        {
          const orgStore = getOrganisationStore();
          const reqInvite = (req.body as { invite?: string }).invite;

          // Invite path: the org comes from the token claim, re-checked against
          // the database, and the invite is claimed before anything is created.
          if (reqInvite) {
            const verified = await verifyInviteToken(reqInvite);
            if (!verified.ok) {
              throw httpError(
                verified.error.code === 'EXPIRED' ? 'INVITE_EXPIRED' : 'INVITE_INVALID',
              );
            }
            // The invited email is recorded, not enforced.
            inviteEmailClaim = verified.email.trim().toLowerCase();
            const inviteStore = getRegistrationInvitesStore();
            const org = await orgStore.findById(verified.org);
            if (!org.ok) {
              throw httpError('DB_UNAVAILABLE', {
                cause: new Error(org.error.message),
                fields: { sub_operation: 'orgStore.findById' },
              });
            }
            // The Default org takes no invites.
            if (org.value?.status !== 'active' || org.value.isDefault) {
              throw httpError('TARGET_ORG_INACTIVE');
            }
            const ownerMatch = await orgStore.findByOwnerEmail(contact.email);
            if (ownerMatch.ok && ownerMatch.value) {
              throw httpError('OWNER_ALREADY_REGISTERED', { fields: { email: contact.email } });
            }
            // Claim the invite now, before anything is created, so concurrent
            // submits on one link create at most one registration.
            const claimed = await inviteStore.consume(verified.jti);
            if (!claimed.ok) {
              throw httpError('DB_UNAVAILABLE', {
                cause: new Error(claimed.error.message),
                fields: { sub_operation: 'inviteStore.consume' },
              });
            }
            if (claimed.value === null) {
              throw httpError('INVITE_ALREADY_USED', { fields: { email: contact.email } });
            }
            inviteJti = verified.jti;
            parentOrgId = verified.org;
          } else {
            // Selector path: the coordinator picks an active org. `org_id` is required.
            const reqOrgId = (req.body as { org_id?: string }).org_id;
            if (!reqOrgId) {
              throw httpError('SCHEMA_VALIDATION', {
                detail: 'org_id is required.',
                fields: { field: 'org_id' },
              });
            }
            const org = await orgStore.findById(reqOrgId);
            if (!org.ok) {
              throw httpError('DB_UNAVAILABLE', {
                cause: new Error(org.error.message),
                fields: { sub_operation: 'orgStore.findById' },
              });
            }
            if (org.value?.status !== 'active') {
              throw httpError('TARGET_ORG_INACTIVE');
            }
            // An org owner cannot also register as a coordinator.
            const ownerMatch = await orgStore.findByOwnerEmail(contact.email);
            if (ownerMatch.ok && ownerMatch.value) {
              throw httpError('OWNER_ALREADY_REGISTERED', { fields: { email: contact.email } });
            }
            // The Default org is selectable only while it is the only active org.
            if (org.value.isDefault) {
              const active = await orgStore.listActive();
              if (!active.ok) {
                throw httpError('DB_UNAVAILABLE', {
                  cause: new Error(active.error.message),
                  fields: { sub_operation: 'orgStore.listActive' },
                });
              }
              if (active.value.some((o) => !o.isDefault)) {
                throw httpError('TARGET_ORG_INACTIVE');
              }
            }
            parentOrgId = org.value.id;
            orgIsDefault = org.value.isDefault;
          }
        }

        // A Default-org coordinator names its own organisation, never "Default".
        if (orgIsDefault && body.name.trim().toLowerCase() === 'default') {
          throw httpError('SCHEMA_VALIDATION', {
            detail: 'The organisation name cannot be "Default".',
            fields: { field: 'name' },
          });
        }

        // `url` and `locations` belong to a real org, so sending them is refused.
        // A Default-org coordinator keeps its own as `legacy_org_details`.
        const submittedLocations = (body.locations ?? []).filter(hasLocationContent);
        const ownOrgDetails: LegacyOrgDetails = {
          ...(body.url?.trim() ? { url: body.url.trim() } : {}),
          ...(submittedLocations.length > 0 ? { locations: submittedLocations } : {}),
        };
        if (!orgIsDefault && Object.keys(ownOrgDetails).length > 0) {
          throw httpError('ORG_DETAILS_READ_ONLY', {
            fields: { fields: Object.keys(ownOrgDetails) },
          });
        }

        // Check email and phone uniqueness in the database and Keycloak.
        const dbEmail = await userStore.findByContactEmail(contact.email);
        if (!dbEmail.ok) {
          throw httpError('DB_UNAVAILABLE', {
            cause: new Error(dbEmail.error.message),
            fields: { sub_operation: 'userStore.findByContactEmail' },
          });
        }
        if (dbEmail.value !== null) {
          const existing = dbEmail.value;
          if (existing.status === 'inactive') {
            // Rejected: refuse until the cooling window from `rejected_at` ends,
            // then revive the same row to pending and re-send the review link.
            const retryAfter = coolingRetryAfter(existing.rejectedAt, existing.updatedAt);
            if (retryAfter) {
              throw httpError('REGISTRATION_COOLING', {
                fields: { email: contact.email, retry_after: retryAfter },
              });
            }
            const revived = await userStore.update(existing.id, {
              status: 'pending',
              rejectedAt: null,
              updatedBy: 'self',
            });
            if (!revived.ok) {
              throw httpError('DB_UNAVAILABLE', {
                cause: new Error(revived.error.message),
                fields: { sub_operation: 'userStore.reviveRejected' },
              });
            }
            return reclaimReview(existing);
          }
          if (existing.status !== 'pending') {
            // Active or retired: the email is taken.
            throw httpError('USER_EXISTS', { fields: { email: contact.email } });
          }
          // Pending: re-send the review link.
          return reclaimReview(existing);
        }

        const dbPhone = await userStore.findByContactPhone(phoneE164);
        if (!dbPhone.ok) {
          throw httpError('DB_UNAVAILABLE', {
            cause: new Error(dbPhone.error.message),
            fields: { sub_operation: 'userStore.findByContactPhone' },
          });
        }
        if (dbPhone.value !== null) {
          const existingPhone = dbPhone.value;
          if (existingPhone.status === 'inactive') {
            // Same cooling window for a rejected record that owns this phone.
            const retryAfter = coolingRetryAfter(existingPhone.rejectedAt, existingPhone.updatedAt);
            if (retryAfter) {
              throw httpError('REGISTRATION_COOLING', {
                fields: { phone: phoneE164, retry_after: retryAfter },
              });
            }
            const revived = await userStore.update(existingPhone.id, {
              status: 'pending',
              rejectedAt: null,
              updatedBy: 'self',
            });
            if (!revived.ok) {
              throw httpError('DB_UNAVAILABLE', {
                cause: new Error(revived.error.message),
                fields: { sub_operation: 'userStore.reviveRejected' },
              });
            }
            return reclaimReview(existingPhone);
          }
          throw httpError('PHONE_EXISTS', { fields: { phone: phoneE164 } });
        }

        const kcEmail = await idp.findByEmail(contact.email);
        if (!kcEmail.ok) {
          throw httpError('IDP_UNAVAILABLE', {
            cause: kcEmail.error,
            fields: { sub_operation: 'idp.findByEmail' },
          });
        }
        if (kcEmail.value !== null) {
          throw httpError('USER_EXISTS', { fields: { email: contact.email } });
        }

        // The phone is the OTP login key, so it must be unique in Keycloak too.
        const kcPhone = await idp.findByAttribute(KC_ATTR.PHONE_NUMBER, phoneE164);
        if (!kcPhone.ok) {
          throw httpError('IDP_UNAVAILABLE', {
            cause: kcPhone.error,
            fields: { sub_operation: 'idp.findByAttribute.phoneNumber' },
          });
        }
        if (kcPhone.value !== null) {
          throw httpError('PHONE_EXISTS', { fields: { phone: phoneE164 } });
        }

        // Consent is written in the same transaction as the coordinator row,
        // before any Keycloak call. No coordinator exists without a consent record.
        const recordConsent = await aggregatorConsentWriter({
          consent: serverConsent,
          log,
        });

        const aggregator = await createAggregatorWithSlug(userStore, body.name, {
          type: body.type,
          contact,
          consent: serverConsent,
          recordConsent,
          orgId: parentOrgId,
          legacyOrgDetails:
            orgIsDefault && Object.keys(ownOrgDetails).length > 0 ? ownOrgDetails : null,
          inviteId: inviteJti,
          profile: buildAggregatorProfile(body as unknown as Record<string, unknown>),
          profileRef: resolveProfileRef('registration.v1.json'),
        });
        if (!aggregator.ok) {
          const code = mapStoreCreateError(aggregator.error.code);
          throw httpError(code, {
            cause: new Error(aggregator.error.message),
            ...(code === 'CONSENT_WRITE_FAILED'
              ? { fields: { sub_operation: 'recordAggregatorConsent', rolled_back: true } }
              : {}),
          });
        }
        const { id: aggregatorId, orgSlug } = aggregator.value;

        // Keycloak attributes:
        //   - aggregator_id    the coordinator's row id
        //   - aggregator_type  participant focus
        //   - phoneNumber      OTP login key
        //   - decision_made    login gate
        const kcAttributes: Record<string, string> = {
          [KC_ATTR.AGGREGATOR_ID]: aggregatorId,
          [KC_ATTR.AGGREGATOR_TYPE]: body.type,
          [KC_ATTR.PHONE_NUMBER]: phoneE164,
          [KC_ATTR.DECISION_MADE]: 'pending',
        };

        // Split the name into first and last for Keycloak.
        const { firstName, lastName } = splitName(contact.name);
        const kcResult = await idp.createUser({
          email: contact.email,
          username: contact.email,
          phone: phoneE164,
          enabled: false,
          firstName,
          lastName,
          attributes: kcAttributes,
        });
        if (!kcResult.ok) {
          await userStore.deleteById(aggregatorId);
          if (kcResult.error.code === 'USER_EXISTS') {
            throw httpError('USER_EXISTS', {
              cause: kcResult.error,
              fields: { email: contact.email, rolled_back: true },
            });
          }
          if (kcResult.error.code === 'INVALID_NAME') {
            throw httpError('NAME_INVALID_CHARACTERS', {
              fields: { name: 'contact.name', rolled_back: true },
            });
          }
          throw httpError('IDP_UNAVAILABLE', {
            cause: kcResult.error,
            fields: { sub_operation: 'idp.createUser', rolled_back: true },
          });
        }

        // Fully provisioned: keep the invite consumed.
        inviteCommitted = true;

        await sendAdminReviewEmail(
          {
            aggregatorId,
            applicantName: body.name,
            applicantEmail: contact.email,
            applicantPhone: phoneE164,
            ...(inviteEmailClaim ? { invitedEmail: inviteEmailClaim } : {}),
            ...(await resolveOwnerRouting(parentOrgId)),
          },
          log,
        );

        log.info(
          {
            status: 'success',
            latency_ms: Date.now() - start,
            aggregator_id: aggregatorId,
            org_slug: orgSlug,
            keycloak_user_id: kcResult.value.id,
          },
          'aggregator registration submitted',
        );

        return reply.status(201).send({
          aggregator_id: aggregatorId,
          org_slug: orgSlug,
          status: 'pending',
          message: 'Registration submitted. You will receive credentials by email after approval.',
        });
      } finally {
        // Give the invite back on any exit that did not create a registration.
        // Only releases the claim this request took.
        if (inviteJti && !inviteCommitted) {
          const released = await getRegistrationInvitesStore().release(inviteJti);
          if (!released.ok || released.value === null) {
            log.warn(
              { status: 'failure', sub_operation: 'inviteStore.release', invite_jti: inviteJti },
              'invite release after an incomplete registration did not commit',
            );
          }
        }
      }
    },
  );
}

/**
 * Builds the consent-ledger write that `store.create` runs inside its transaction.
 *
 * The consent config is read now, before the transaction. A failed ledger
 * write throws, so the store rolls back and answers `CONSENT_WRITE_FAILED`.
 *
 * @param consent - The server-stamped registration consent (`valid_till` is stored).
 * @param log - Request-scoped child logger.
 * @returns The hook to pass as `recordConsent`.
 * @throws {HttpError} CONSENT_WRITE_FAILED when the consent config cannot be read.
 */
async function aggregatorConsentWriter({
  consent,
  log,
}: {
  consent: ReturnType<typeof RegistrationPayloadSchema.parse>['consent'];
  log: ReturnType<FastifyRequest['log']['child']>;
}): Promise<RecordConsentHook> {
  const { network, brand } = resolveActiveNetwork();
  let termsVersion: number;
  let privacyVersion: number;
  try {
    const consentCfg = await loadConsentConfig(network, brand);
    termsVersion = consentCfg.audiences.aggregator.documents.terms.current_version;
    privacyVersion = consentCfg.audiences.aggregator.documents.privacy.current_version;
  } catch (e) {
    log.error(
      {
        operation: 'consentLedger.recordAggregatorConsent',
        status: 'failure',
        error: e instanceof Error ? e.message : String(e),
        network,
        brand: brand ?? null,
      },
      'consent config load failed — registration refused',
    );
    throw httpError('CONSENT_WRITE_FAILED', {
      fields: { sub_operation: 'loadConsentConfig', rolled_back: true },
    });
  }

  return async (executor, aggregatorId) => {
    const result = await getConsentLedger()
      .withExecutor(executor)
      .recordRegistrationConsent({
        subjectType: 'user',
        subjectId: aggregatorId,
        network,
        brand: brand ?? null,
        termsVersion,
        privacyVersion,
        validTill: new Date(consent.valid_till),
      });
    if (!result.success) {
      log.error(
        {
          operation: 'consentLedger.recordAggregatorConsent',
          status: 'failure',
          error: result.error.message,
          error_type: result.error.name,
          aggregator_id: aggregatorId,
          network,
          brand: brand ?? null,
          terms_version: termsVersion,
          privacy_version: privacyVersion,
        },
        'consent ledger write failed — registration rolled back',
      );
      // Throwing inside the store's transaction rolls the registration back.
      throw result.error;
    }
  };
}

/**
 * Inserts a coordinator, retrying up to {@link SLUG_RETRIES} times on a slug collision.
 */
async function createAggregatorWithSlug(
  store: ReturnType<typeof getUserStore>,
  name: string,
  extras: {
    type: ReturnType<typeof RegistrationPayloadSchema.parse>['type'];
    contact: BecknContact;
    consent: ReturnType<typeof RegistrationPayloadSchema.parse>['consent'];
    /** Writes the consent ledger row inside the create transaction. */
    recordConsent: RecordConsentHook;
    /** The coordinator's org (`users.org_id`). */
    orgId: string;
    /** The coordinator's own org details (Default-org registrations only). */
    legacyOrgDetails: LegacyOrgDetails | null;
    /** The consumed invite's `jti`, when registered via one. */
    inviteId: string | null;
    profile: Record<string, unknown>;
    /** `null` when no registration schema resolved. */
    profileRef: string | null;
  },
): ReturnType<typeof store.create> {
  let last: Awaited<ReturnType<typeof store.create>> | null = null;
  for (let attempt = 0; attempt < SLUG_RETRIES; attempt += 1) {
    const orgSlug = slugFromName(name);
    last = await store.create({
      orgSlug,
      name,
      type: extras.type,
      contact: extras.contact,
      consent: extras.consent,
      recordConsent: extras.recordConsent,
      createdBy: 'self',
      updatedBy: 'self',
      orgId: extras.orgId,
      legacyOrgDetails: extras.legacyOrgDetails,
      inviteId: extras.inviteId,
      profile: extras.profile,
      profileRef: extras.profileRef,
    });
    if (last.ok) return last;
    if (last.error.code !== 'DUPLICATE_SLUG') return last;
  }
  return (
    last ?? {
      ok: false,
      error: { code: 'DB_UNAVAILABLE', message: 'slug retries exhausted' },
    }
  );
}

function mapStoreCreateError(
  code:
    | 'NOT_FOUND'
    | 'DUPLICATE_SLUG'
    | 'DUPLICATE_PHONE'
    | 'DUPLICATE_EMAIL'
    | 'DUPLICATE'
    | 'CHECK_VIOLATION'
    | 'CONSENT_WRITE_FAILED'
    | 'DB_UNAVAILABLE',
): ErrorCode {
  switch (code) {
    case 'DUPLICATE_SLUG':
      return 'DUPLICATE_SLUG';
    // The ledger write failed inside the create transaction: nothing exists.
    case 'CONSENT_WRITE_FAILED':
      return 'CONSENT_WRITE_FAILED';
    // An unknown unique violation is a generic conflict.
    case 'DUPLICATE':
      return 'CONFLICT';
    case 'DUPLICATE_PHONE':
      return 'PHONE_EXISTS';
    case 'DUPLICATE_EMAIL':
      return 'USER_EXISTS';
    case 'CHECK_VIOLATION':
      return 'SCHEMA_VALIDATION';
    default:
      return 'DB_UNAVAILABLE';
  }
}

/**
 * Resolves the org claim and recipient for a coordinator's review email.
 *
 * The email goes to the org owner. For the Default org it goes to
 * `DEFAULT_ORG_OWNER_EMAIL`, else to the network admins (no `recipientEmail`).
 *
 * @param parentOrgId - The coordinator's org id, or `null`.
 * @returns `{ org?, recipientEmail? }` extras for `sendAdminReviewEmail`.
 */
async function resolveOwnerRouting(
  parentOrgId: string | null,
): Promise<{ org?: string; recipientEmail?: string }> {
  if (!parentOrgId) return {};
  const org = await getOrganisationStore().findById(parentOrgId);
  if (org.ok && org.value?.isDefault) {
    const owner = defaultOrgOwnerEmail();
    return { org: parentOrgId, ...(owner ? { recipientEmail: owner } : {}) };
  }
  const ownerEmail = org.ok && org.value ? org.value.ownerEmail : undefined;
  return { org: parentOrgId, ...(ownerEmail ? { recipientEmail: ownerEmail } : {}) };
}

/**
 * Reports whether a submitted location has a street, locality, or coordinates other than `[0,0]`.
 *
 * @param loc - One submitted location.
 * @returns `true` when it is worth keeping.
 */
function hasLocationContent(loc: BecknLocation): boolean {
  const a = loc.address;
  if (a?.streetAddress?.trim() || a?.addressLocality?.trim()) return true;
  const c = (loc.geo as { coordinates?: unknown }).coordinates;
  return Array.isArray(c) && c.length === 2 && (c[0] !== 0 || c[1] !== 0);
}
