/**
 * Coordinator profile endpoints in `@aggregator-dpg/api`.
 *
 *   GET /v1/aggregators/profile/me
 *     Returns the coordinator row plus identity fields from the token or Keycloak.
 *
 *   PATCH /v1/aggregators/profile/me
 *     A contact change writes the phone to Keycloak first, then the contact
 *     to the database. `name` goes to the database only.
 *
 *     Org details (`url`, `locations`, `contact.company`, `contact.gstNumber`)
 *     belong to the coordinator's org. A PATCH that changes any of them is
 *     refused with `409 ORG_DETAILS_READ_ONLY` before any write.
 *
 *     `consent` is read-only after registration; a body that sends it is
 *     refused as `SCHEMA_VALIDATION`. `org_slug` cannot be changed.
 *
 * Requires a Keycloak Bearer token carrying the `aggregator_id` claim.
 */

import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ConsentRecordSchema } from '@aggregator-dpg/shared-primitives/aggregator';
import type { BecknContact } from '@aggregator-dpg/shared-primitives/aggregator';
import { BecknContactSchema, BecknLocationSchema } from '@aggregator-dpg/shared-primitives/beckn';
import { authenticate, type AuthContext } from '../services/auth/access-token.js';
import { getUserStore } from '../services/user-store/index.js';
import { getOrganisationStore } from '../services/organisation-store/index.js';
import { getIdpAdmin, KC_ATTR } from '../services/idp-admin/index.js';
import type { IdpUser } from '../services/idp-admin/index.js';
import { normalisePhone } from '@aggregator-dpg/shared-primitives/phone';
import { httpError } from '../errors/http-error.js';
import { errorResponses } from '../errors/openapi.js';
import { callerFromAuth, recordRouteCaller } from '../services/authz/index.js';

// ─── Body schemas ───────────────────────────────────────────────────────────

const AggregatorPatchSchema = z
  .object({
    name: z.string().min(2).max(200).optional(),
    url: z.string().url().max(2048).nullable().optional(),
    contact: BecknContactSchema.optional(),
    locations: z.array(BecknLocationSchema).optional(),
  })
  // Strict: a body carrying `consent` is refused with 400 SCHEMA_VALIDATION.
  .strict();

const ProfileUpdateBodySchema = z
  .object({
    aggregator: AggregatorPatchSchema,
  })
  .strict();

// ─── Response schemas (OpenAPI) ─────────────────────────────────────────────

const ProfileIdentitySchema = z
  .object({
    first_name: z.string().nullable(),
    last_name: z.string().nullable(),
    email: z.string().nullable(),
    email_verified: z.boolean(),
    phone: z.string().nullable(),
    phone_verified: z.boolean(),
    active: z.boolean(),
  })
  .passthrough();

// PII sub-objects use the full entity schemas so undeclared keys are never serialized.
const ProfileCommonResponseShape = {
  aggregator_id: z.string(),
  org_slug: z.string(),
  actor_type: z.string(),
  type: z.string().nullable(),
  url: z.string().nullable(),
  contact: BecknContactSchema,
  locations: z.array(BecknLocationSchema),
  // The newest registration consent from the ledger; null when there is none.
  consent: ConsentRecordSchema.nullable(),
  status: z.string(),
  updated_at: z.string(),
};

const ProfileReadResponseSchema = z
  .object({
    ...ProfileCommonResponseShape,
    org_name: z.string(),
    identity: ProfileIdentitySchema,
    created_at: z.string(),
  })
  .passthrough();

const ProfileUpdateResponseSchema = z
  .object({
    ...ProfileCommonResponseShape,
    name: z.string(),
  })
  .passthrough();

export function registerAggregatorProfileRoutes(app: FastifyInstance): void {
  app.get(
    '/v1/aggregators/profile/me',
    {
      config: { rbac: { access: 'self' } },
      schema: {
        tags: ['aggregator-profile'],
        summary: 'Read the caller aggregator profile',
        description:
          'Returns the full aggregator row + brand + contact + status for the aggregator bound to the Bearer token claim.',
        security: [{ bearerAuth: [] }],
        response: {
          200: ProfileReadResponseSchema,
          ...errorResponses(401, 403, 404, 503),
        },
      },
    },
    async (req, reply) => {
      const auth = await requireAuth(req);
      const log = req.log.child({ operation: 'aggregator-profile.read', actor: auth.userId });
      const start = Date.now();

      const userStore = getUserStore();

      const aggregator = await userStore.findById(auth.aggregatorId);
      if (!aggregator.ok) {
        throw httpError('DB_UNAVAILABLE', { cause: new Error(aggregator.error.message) });
      }
      if (!aggregator.value) {
        throw httpError('NOT_FOUND', { detail: 'Aggregator record not found.' });
      }

      const kcUser = await fetchKcUserSafe(auth, log);

      log.info(
        { status: 'success', latency_ms: Date.now() - start, aggregator_id: auth.aggregatorId },
        'profile read',
      );

      return reply.send({
        aggregator_id: auth.aggregatorId,
        org_slug: aggregator.value.orgSlug,
        // Falls back to the slug only when the name is empty.
        org_name: aggregator.value.name || aggregator.value.orgSlug,
        actor_type: aggregator.value.actorType,
        type: aggregator.value.type,
        url: aggregator.value.url,
        contact: aggregator.value.contact,
        locations: aggregator.value.locations,
        consent: aggregator.value.consent,
        status: aggregator.value.status,
        // From the token, falling back to Keycloak.
        identity: {
          first_name: auth.firstName ?? kcUser?.firstName ?? null,
          last_name: auth.lastName ?? kcUser?.lastName ?? null,
          email: auth.email ?? kcUser?.email ?? aggregator.value.contact.email,
          email_verified: auth.emailVerified ?? false,
          phone:
            auth.phoneNumber ??
            pickAttribute(kcUser, KC_ATTR.PHONE_NUMBER) ??
            aggregator.value.contact.phone,
          phone_verified:
            auth.phoneNumberVerified ?? pickAttribute(kcUser, 'phoneNumberVerified') === 'true',
          active: kcUser?.enabled ?? aggregator.value.status === 'active',
        },
        created_at: aggregator.value.createdAt.toISOString(),
        updated_at: aggregator.value.updatedAt.toISOString(),
      });
    },
  );

  app.patch(
    '/v1/aggregators/profile/me',
    {
      config: { rbac: { access: 'self' } },
      schema: {
        tags: ['aggregator-profile'],
        summary: 'Update the caller aggregator profile',
        description:
          "Partial update of the caller aggregator (name / contact). Consent is read-only after registration: a body carrying `consent` is refused with 400 SCHEMA_VALIDATION. Contact phone + email are mirrored to Keycloak before the DB write. Org details (url, locations, contact.company, contact.gstNumber) belong to the coordinator's organisation and are refused with 409 ORG_DETAILS_READ_ONLY.",
        security: [{ bearerAuth: [] }],
        body: ProfileUpdateBodySchema,
        response: {
          200: ProfileUpdateResponseSchema,
          ...errorResponses(400, 401, 403, 404, 409, 500, 503),
        },
      },
    },
    async (req, reply) => {
      const auth = await requireAuth(req);
      const log = req.log.child({ operation: 'aggregator-profile.update', actor: auth.userId });
      const start = Date.now();

      // Already validated and parsed by the route schema.
      const body = req.body as z.infer<typeof ProfileUpdateBodySchema>;

      const userStore = getUserStore();

      // A change to org details is refused before any write. Sending back the
      // current values is not a change.
      const sentOrgDetails =
        body.aggregator.url !== undefined ||
        body.aggregator.locations !== undefined ||
        body.aggregator.contact?.company !== undefined ||
        body.aggregator.contact?.gstNumber !== undefined;
      if (sentOrgDetails) {
        const current = await userStore.findById(auth.aggregatorId);
        if (!current.ok) {
          throw httpError('DB_UNAVAILABLE', {
            cause: new Error(current.error.message),
            fields: { sub_operation: 'userStore.findById' },
          });
        }
        const now = current.value;
        const same = (a: unknown, b: unknown) =>
          JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
        const changed = [
          ...(body.aggregator.url !== undefined && !same(body.aggregator.url, now?.url)
            ? ['url']
            : []),
          ...(body.aggregator.locations !== undefined &&
          !same(body.aggregator.locations, now?.locations)
            ? ['locations']
            : []),
          ...(body.aggregator.contact?.company !== undefined &&
          !same(body.aggregator.contact.company, now?.contact.company)
            ? ['contact.company']
            : []),
          ...(body.aggregator.contact?.gstNumber !== undefined &&
          !same(body.aggregator.contact.gstNumber, now?.contact.gstNumber)
            ? ['contact.gstNumber']
            : []),
        ];
        if (changed.length > 0) {
          throw httpError('ORG_DETAILS_READ_ONLY', { fields: { fields: changed } });
        }
      }

      // ─── 1. Write the phone to Keycloak first. ─────────────────────────────
      // A Keycloak failure aborts before the database write.
      let normalisedContact: BecknContact | undefined;
      // The stored phone, restored in Keycloak if the database write fails.
      let previousPhone: string | undefined;
      if (body.aggregator.contact) {
        const raw = body.aggregator.contact;
        const phoneR = normalisePhone(raw.phone);
        if (!phoneR.ok) {
          throw httpError('INVALID_PHONE', {
            detail: phoneR.error.message,
            // Keyed `phone` so the logger redacts it.
            fields: { phone: raw.phone },
          });
        }
        normalisedContact = { ...raw, phone: phoneR.value };

        // One phone and one email per person. Checked before the Keycloak write.
        previousPhone = await assertContactChangeAllowed(auth.aggregatorId, {
          email: raw.email,
          phone: phoneR.value,
        });

        const idp = getIdpAdmin();
        const kcWrite = await idp.setAttributes(auth.userId, {
          [KC_ATTR.PHONE_NUMBER]: phoneR.value,
        });
        if (!kcWrite.ok) {
          log.error(
            {
              status: 'failure',
              sub_operation: 'idp.setAttributes.contact',
              code: kcWrite.error.code,
              cause: kcWrite.error.message,
            },
            'failed to mirror phone to Keycloak — aborting before DB write',
          );
          throw httpError('IDP_UNAVAILABLE', { cause: kcWrite.error });
        }
      }

      // ─── 2. Coordinator-table updates ──────────────────────────────────────
      const patch: Parameters<typeof userStore.update>[1] = {
        updatedBy: auth.userId,
      };
      if (body.aggregator.name !== undefined) patch.name = body.aggregator.name;
      if (normalisedContact !== undefined) patch.contact = normalisedContact;

      const result = await userStore.update(auth.aggregatorId, patch);
      if (!result.ok && normalisedContact && previousPhone !== undefined) {
        // Restore the Keycloak phone. Best effort; logged on failure.
        const revert = await getIdpAdmin().setAttributes(auth.userId, {
          [KC_ATTR.PHONE_NUMBER]: previousPhone,
        });
        if (!revert.ok) {
          log.error(
            {
              status: 'failure',
              sub_operation: 'idp.setAttributes.revert',
              code: revert.error.code,
            },
            'DB update failed and the Keycloak phone could not be restored',
          );
        }
      }
      if (!result.ok) {
        throw httpError(mapAggregatorUpdateError(result.error.code), {
          cause: new Error(result.error.message),
        });
      }

      log.info(
        {
          status: 'success',
          latency_ms: Date.now() - start,
          aggregator_id: auth.aggregatorId,
        },
        'profile updated',
      );

      // Return the updated row.
      const aggregator = await userStore.findById(auth.aggregatorId);
      if (!aggregator.ok || !aggregator.value) {
        throw httpError('INTERNAL', { detail: 'Post-write read failed.' });
      }

      return reply.send({
        aggregator_id: auth.aggregatorId,
        org_slug: aggregator.value.orgSlug,
        name: aggregator.value.name,
        actor_type: aggregator.value.actorType,
        type: aggregator.value.type,
        url: aggregator.value.url,
        contact: aggregator.value.contact,
        locations: aggregator.value.locations,
        consent: aggregator.value.consent,
        status: aggregator.value.status,
        updated_at: aggregator.value.updatedAt.toISOString(),
      });
    },
  );
}

async function fetchKcUserSafe(auth: AuthContext, log: FastifyBaseLogger): Promise<IdpUser | null> {
  try {
    const result = await getIdpAdmin().findById(auth.userId);
    if (result.ok) return result.value ?? null;
    log.warn(
      { sub_operation: 'fetchKcUser', code: result.error.code, hint: result.error.message },
      'failed to load KC user — falling back to JWT claims',
    );
    return null;
  } catch (err) {
    log.warn(
      {
        sub_operation: 'fetchKcUser',
        cause: err instanceof Error ? err.message : String(err),
      },
      'failed to load KC user (threw)',
    );
    return null;
  }
}

function pickAttribute(user: IdpUser | null, name: string): string | undefined {
  const v = user?.attributes?.[name];
  if (Array.isArray(v) && typeof v[0] === 'string' && v[0].length > 0) return v[0];
  return undefined;
}

async function requireAuth(req: FastifyRequest): Promise<AuthContext> {
  const result = await authenticate(req);
  if (result.ok) {
    await recordRouteCaller(req, callerFromAuth(result.context));
    return result.context;
  }
  const code = result.error.code === 'MISSING_AGGREGATOR_ID' ? 'FORBIDDEN' : 'UNAUTHORIZED';
  throw httpError(code, {
    detail: result.error.message,
    fields: { reason: result.error.code },
  });
}

function mapAggregatorUpdateError(
  code:
    | 'NOT_FOUND'
    | 'DUPLICATE_SLUG'
    | 'DUPLICATE_PHONE'
    | 'DUPLICATE_EMAIL'
    | 'DUPLICATE'
    | 'CHECK_VIOLATION'
    | 'CONSENT_WRITE_FAILED'
    | 'DB_UNAVAILABLE',
): Parameters<typeof httpError>[0] {
  switch (code) {
    case 'NOT_FOUND':
      return 'NOT_FOUND';
    case 'DUPLICATE_PHONE':
      return 'PHONE_EXISTS';
    case 'DUPLICATE_EMAIL':
      return 'USER_EXISTS';
    case 'CHECK_VIOLATION':
      return 'SCHEMA_VALIDATION';
    case 'DUPLICATE_SLUG':
      return 'DUPLICATE_SLUG';
    // An unknown unique violation is a generic conflict.
    case 'DUPLICATE':
      return 'CONFLICT';
    default:
      return 'DB_UNAVAILABLE';
  }
}

/**
 * Checks a coordinator's requested contact change before anything is written.
 *
 * - Phone or email held by another person: PHONE_EXISTS / USER_EXISTS.
 * - Contact shared with an org-owner role and the email or phone changes: CONFLICT.
 *
 * Identity is compared on stored contact ids, never on the submitted email.
 *
 * @param selfId - The caller's own `aggregators.id`.
 * @param next - The requested email and canonical phone.
 * @returns The coordinator's current phone (to restore Keycloak on failure).
 * @throws {HttpError} PHONE_EXISTS, USER_EXISTS, CONFLICT, NOT_FOUND or DB_UNAVAILABLE.
 */
async function assertContactChangeAllowed(
  selfId: string,
  next: { email: string; phone: string },
): Promise<string> {
  const aggregators = getUserStore();
  const orgs = getOrganisationStore();

  const me = valueOrUnavailable('userStore.findById', await aggregators.findById(selfId));
  if (!me) throw httpError('NOT_FOUND');
  const email = next.email.trim().toLowerCase();
  const phoneClash = () => httpError('PHONE_EXISTS', { fields: { phone: next.phone } });
  const emailClash = () => httpError('USER_EXISTS', { fields: { email: next.email } });
  /** Another person: a coordinator row that is not the caller's own. */
  const otherCoordinator = (a: { id: string } | null): boolean => !!a && a.id !== selfId;
  /** Another person: an org owner whose contact is not this coordinator's. */
  const otherOwner = (o: { contactId: string } | null): boolean =>
    !!o && o.contactId !== me.contactId;

  const byPhone = await aggregators.findByContactPhone(next.phone);
  if (otherCoordinator(valueOrUnavailable('userStore.findByContactPhone', byPhone))) {
    throw phoneClash();
  }
  const byEmail = await aggregators.findByContactEmail(email);
  if (otherCoordinator(valueOrUnavailable('userStore.findByContactEmail', byEmail))) {
    throw emailClash();
  }
  const ownerByPhone = await orgs.findByOwnerPhone(next.phone);
  if (otherOwner(valueOrUnavailable('orgStore.findByOwnerPhone', ownerByPhone))) {
    throw phoneClash();
  }
  const ownerByEmail = await orgs.findByOwnerEmail(email);
  if (otherOwner(valueOrUnavailable('orgStore.findByOwnerEmail', ownerByEmail))) {
    throw emailClash();
  }

  const identityChanges = email !== me.contactEmail || next.phone !== me.contactPhone;
  if (identityChanges) {
    const owner = valueOrUnavailable(
      'orgStore.findByOwnerEmail',
      await orgs.findByOwnerEmail(me.contactEmail),
    );
    if (owner?.contactId === me.contactId) {
      throw httpError('CONFLICT', {
        detail: 'This contact is also an organisation owner; change it through the organisation.',
      });
    }
  }
  return me.contactPhone;
}

/**
 * Unwraps a store result, turning a store failure into `503 DB_UNAVAILABLE`.
 *
 * @param op - Store operation, reported as `sub_operation`.
 * @param result - The store result.
 * @returns The result value.
 * @throws {HttpError} DB_UNAVAILABLE when the store call failed.
 */
function valueOrUnavailable<T>(
  op: string,
  result: { ok: true; value: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) {
    throw httpError('DB_UNAVAILABLE', {
      cause: new Error(result.error.message),
      fields: { sub_operation: op },
    });
  }
  return result.value;
}
