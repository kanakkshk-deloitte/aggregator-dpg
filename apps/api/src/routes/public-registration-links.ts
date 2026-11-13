/**
 * Public registration link endpoints of the aggregator API (`@aggregator-dpg/api`).
 *
 *   GET  /public/v1/aggregators/:orgSlug/links/:slug
 *     Anonymous resolve of a live link, for rendering the registration form.
 *     404 for missing or draft slugs; 410 for retired or expired ones.
 *
 *   POST /public/v1/aggregators/:orgSlug/registrations/:slug
 *     Anonymous submit. Validates the body against the domain's participant
 *     schema, normalises phone and email, creates the user and profile in
 *     signalstack, records a link_submission row, and returns its id.
 *
 * The (org_slug, slug) pair is the access credential; no JWT is needed.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getRegistrationLinksStore } from '../services/registration-links-store/index.js';
import type { RegistrationLink } from '../services/registration-links-store/index.js';
import { getUserStore } from '../services/user-store/index.js';
import { getNetworkConfig } from '../services/network-config.js';
import { domainRequiresConsent } from '@aggregator-dpg/network-config/interface';
import {
  describeSchemaIssue,
  fieldLabel,
  formatFieldErrors,
  type FieldError,
} from '@aggregator-dpg/network-config/field-errors';
import { resolveSubmissionShape, publicHintI18nKey } from '../services/registration-mode/index.js';
import { getSchemaLoader } from '../services/schema-loader/index.js';
import { normalisePhone } from '@aggregator-dpg/shared-primitives/phone';
import {
  LIFECYCLE_STATUSES,
  resolveLifecycle,
  type LifecycleStatus,
} from '../services/onboarding/lifecycle.js';
import { getSignalStackWriter } from '../services/signalstack.js';
import { getDb } from '../db/client.js';
import { linkSubmissions } from '../db/schema.js';
import { httpError } from '../errors/http-error.js';
import { errorResponses } from '../errors/openapi.js';
import { consume } from '../services/rate-limiter/index.js';
import { config } from '../config.js';
import { buildSignalStackItemState } from '@aggregator-dpg/signalstack-writer/item-state';

interface OrgSlugParams {
  orgSlug?: string;
  slug?: string;
}

const LinkParamsSchema = z.object({
  orgSlug: z.string().min(1).describe('Aggregator organisation slug.'),
  slug: z.string().min(1).describe('Registration link slug.'),
});

/** Public-safe shape of a live link returned by the resolve endpoint. */
const ResolveLinkResponseSchema = z
  .object({
    slug: z.string(),
    network: z.string().describe("Active signalstack network id (e.g. 'blue_dot')."),
    domain: z.string(),
    context: z.object({}).passthrough().describe('Link context snapshot (free-form metadata).'),
    registration_mode: z.string(),
    submission_shape: z.string().describe("'account_and_profile' or 'account_only'."),
    public_hint_i18n_key: z.string().nullable(),
    schema_id: z.string().nullable(),
    schema_version: z.string().nullable(),
    schema: z
      .unknown()
      .nullable()
      .describe("JSON Schema for the link's domain; null for account_only links."),
    identity: z
      .object({})
      .passthrough()
      .describe('Identity field selectors (name / phone / email) for this domain.'),
    expires_at: z.string().nullable(),
  })
  .passthrough();

/**
 * Submission body. The profile part is validated at runtime (Ajv) against the
 * domain's participant schema. Identity field names come from the network config.
 * `consent_terms` / `consent_privacy` are accepted on account_only links.
 */
const PublicRegistrationSubmitBodySchema = z
  .object({})
  .passthrough()
  .describe(
    "Dynamic registration payload validated at runtime against the link domain's participant JSON Schema (identity fields such as name/phone/email plus profile fields). consent_terms / consent_privacy are accepted on account_only links. item_locations optionally carries coordinates the registrant picked from the address autocomplete.",
  );

/**
 * Max submitted coordinates. No schema caps the array and the input is
 * unauthenticated, so the limit is set here.
 */
const MAX_ITEM_LOCATIONS = 25;

/**
 * Coordinates the registrant picked from the address autocomplete, sent to
 * signalstack as `item_locations`.
 *
 * Absent or empty: signalstack geocodes the address text instead. Non-empty:
 * stored as-is. `lat`/`lng` must be numbers, as signalstack requires.
 */
const ItemLocationsSchema = z
  .array(
    z.object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
      label: z.string().min(1).optional(),
    }),
  )
  .max(MAX_ITEM_LOCATIONS);

/** 201 payload — participant created (or saved as draft) and pushed to signalstack. */
const SubmitAcceptedResponseSchema = z
  .object({
    outcome: z.string().describe("'passed'"),
    submission_id: z.string().optional(),
    registration_mode: z.string(),
    submission_shape: z.string(),
    lifecycle_status: z.enum(LIFECYCLE_STATUSES).nullable(),
    owned_elsewhere: z.boolean(),
  })
  .passthrough();

/** 409 payload: the phone or email is already registered. */
const SubmitSkippedResponseSchema = SubmitAcceptedResponseSchema.extend({
  outcome: z.string().describe("'skipped'"),
  message: z.string(),
}).passthrough();

export async function registerPublicRegistrationLinkRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/public/v1/aggregators/:orgSlug/links/:slug',
    {
      config: { rbac: { access: 'public' } },
      schema: {
        tags: ['public-registration'],
        summary: 'Resolve a public registration link',
        description:
          'Looks up a live (non-expired, active) registration link by org slug + link slug. Returns the link metadata (domain, context, schema id) that the public registration form needs. 404 for missing/draft slugs, 410 for retired or expired ones.',
        params: LinkParamsSchema,
        response: {
          200: ResolveLinkResponseSchema,
          ...errorResponses(400, 404, 410, 503),
        },
      },
    },
    async (req, reply) => {
      const { orgSlug, slug } = req.params as OrgSlugParams;
      if (!orgSlug || !slug) {
        throw httpError('SCHEMA_VALIDATION', { detail: 'orgSlug and slug are required.' });
      }
      const log = req.log.child({ operation: 'public.linkResolve', org_slug: orgSlug, slug });
      const start = Date.now();

      const link = await loadLiveLinkByOrgAndSlug(orgSlug, slug, log);

      // Include the domain's JSON Schema from the network config so the page needs
      // no second fetch. A domain no longer in the config returns 404.
      const networkCfg = await getNetworkConfig();
      const linkDomainCfg = networkCfg.domains[link.domain];
      if (!linkDomainCfg) {
        throw httpError('NOT_FOUND', {
          detail: `link domain '${link.domain}' not declared in network ${networkCfg.network.id}`,
        });
      }

      log.info({
        status: 'success',
        latency_ms: Date.now() - start,
        link_id: link.id,
        domain: link.domain,
      });

      // The link's registration_mode sets the form shape:
      //   - 'account_and_profile': identity + full profile schema.
      //   - 'account_only': identity only; `schema` is null.
      const submissionShape = resolveSubmissionShape(link.registrationMode, networkCfg);
      const hintKey = publicHintI18nKey(link.registrationMode, networkCfg);
      const accountOnly = submissionShape === 'account_only';

      return reply.send({
        slug: link.slug,
        // Active network id; the BFF passes it to /lookup.
        network: networkCfg.network.id,
        domain: link.domain,
        context: link.context,
        registration_mode: link.registrationMode,
        submission_shape: submissionShape,
        public_hint_i18n_key: hintKey,
        schema_id: accountOnly ? null : `participant-${link.domain}`,
        schema_version: accountOnly ? null : 'v1',
        schema: accountOnly ? null : linkDomainCfg.schema,
        // Identity field selectors for this domain. On an account-only submit only
        // these stay required (a name + at least one contact).
        identity: linkDomainCfg.identity,
        expires_at: link.expiresAt ? link.expiresAt.toISOString() : null,
      });
    },
  );

  app.post(
    '/public/v1/aggregators/:orgSlug/registrations/:slug',
    {
      config: { rbac: { access: 'public' } },
      schema: {
        tags: ['public-registration'],
        summary: 'Submit a public participant registration',
        description:
          "Public endpoint reached by the QR-link registration form. Validates the submission against the link's domain schema (runtime Ajv — the body shape is dynamic per network/domain), then creates the user + profile in signalstack. Returns 201 on success, 409 (outcome:'skipped') when the identity is already owned by ANOTHER aggregator, and 429 when the per-link rate limit trips. There is no de-duplication within an aggregator: a repeat submission creates a new profile and returns 201.",
        params: LinkParamsSchema,
        body: PublicRegistrationSubmitBodySchema,
        response: {
          201: SubmitAcceptedResponseSchema,
          409: SubmitSkippedResponseSchema,
          ...errorResponses(400, 404, 410, 429, 500, 502, 503),
        },
      },
    },
    async (req, reply) => {
      const { orgSlug, slug } = req.params as OrgSlugParams;
      if (!orgSlug || !slug) {
        throw httpError('SCHEMA_VALIDATION', { detail: 'orgSlug and slug are required.' });
      }
      const log = req.log.child({
        operation: 'public.registrationSubmit',
        org_slug: orgSlug,
        slug,
      });
      const start = Date.now();

      // Rate limit by (orgSlug, slug, ip). CAPTCHA is checked in the BFF; this is
      // a fallback.
      const ip = (req.ip ?? '0.0.0.0').toString();
      const rate = await consume({
        namespace: 'link-submit',
        key: `${orgSlug}:${slug}:${ip}`,
        windowSeconds: config.PUBLIC_SUBMIT_RATE_WINDOW_SECONDS,
        max: config.PUBLIC_SUBMIT_RATE_MAX_PER_WINDOW,
      });
      if (!rate.allowed) {
        void reply.header('Retry-After', String(rate.retryAfterSeconds));
        log.warn({ status: 'rate_limited', count: rate.count, ip });
        throw httpError('RATE_LIMITED', {
          detail: `Retry in ${rate.retryAfterSeconds}s.`,
        });
      }

      const link = await loadLiveLinkByOrgAndSlug(orgSlug, slug, log);

      const rawBody = (req.body ?? {}) as Record<string, unknown>;

      // Identity selectors from the network config, shared by the account_only
      // key guard and the normaliser.
      const networkCfgEarly = await getNetworkConfig();
      const linkDomainCfgEarly = networkCfgEarly.domains[link.domain];
      if (!linkDomainCfgEarly) {
        throw httpError('NOT_FOUND', {
          detail: `link domain '${link.domain}' not declared in network ${networkCfgEarly.network.id}`,
        });
      }
      // Consent is required only when the domain has `consent_required`.
      const consentRequiredForDomain = domainRequiresConsent(linkDomainCfgEarly.goLiveRequired);

      // Unknown registration_mode values fall back to `account_and_profile`
      // (see resolveSubmissionShape).
      const submissionShape = resolveSubmissionShape(link.registrationMode, networkCfgEarly);

      // `account_only`: accept identity fields only. Reject item_state or any other
      // top-level key before Ajv runs. Enforced here because the client can be tampered with.
      if (submissionShape === 'account_only') {
        const allowed = new Set<string>([
          'consent_terms',
          'consent_privacy',
          // Year of birth (or `age` from older clients) is allowed with consent on
          // guardian-gated domains.
          'age',
          'year_of_birth',
          ...[
            linkDomainCfgEarly.identity.name,
            linkDomainCfgEarly.identity.phone,
            linkDomainCfgEarly.identity.email,
          ].filter((k): k is string => typeof k === 'string' && k.length > 0),
        ]);
        for (const key of Object.keys(rawBody)) {
          if (!allowed.has(key)) {
            throw httpError('REGISTRATION_MODE_MISMATCH', {
              detail: `account_only link does not accept field '${key}'`,
              fields: { rejected_key: key },
            });
          }
        }
        // Require name and (phone or email); otherwise the writer would answer 502.
        const nameKey = linkDomainCfgEarly.identity.name;
        const phoneKey = linkDomainCfgEarly.identity.phone;
        const emailKey = linkDomainCfgEarly.identity.email;
        const hasName =
          nameKey &&
          typeof rawBody[nameKey] === 'string' &&
          (rawBody[nameKey] as string).length > 0;
        const hasPhone =
          phoneKey &&
          typeof rawBody[phoneKey] === 'string' &&
          (rawBody[phoneKey] as string).length > 0;
        const hasEmail =
          emailKey &&
          typeof rawBody[emailKey] === 'string' &&
          (rawBody[emailKey] as string).length > 0;
        if (!hasName || (!hasPhone && !hasEmail)) {
          throw httpError('SCHEMA_VALIDATION', {
            detail: 'account_only requires name and at least one of phone or email',
            fields: {
              missing: [
                ...(!hasName ? [nameKey ?? 'name'] : []),
                ...(!hasPhone && !hasEmail ? ['phone_or_email'] : []),
              ],
            },
          });
        }
      }

      // The link's registration_mode sets the submit shape. `account_only` creates
      // the user only (no item). `account_and_profile` always submits an item;
      // missing profile fields make it `draft`. A stray `partial` key is stripped.
      const body: Record<string, unknown> = { ...rawBody };
      delete body['partial'];

      // Read and strip `item_locations` so it never reaches Ajv or item_state.
      // Reject a malformed value here; signalstack's own 400 could not be traced to it.
      const rawItemLocations = body['item_locations'];
      delete body['item_locations'];
      let itemLocations: z.infer<typeof ItemLocationsSchema> = [];
      if (rawItemLocations !== undefined) {
        const parsed = ItemLocationsSchema.safeParse(rawItemLocations);
        if (!parsed.success) {
          throw httpError('SCHEMA_VALIDATION', {
            detail: `item_locations is invalid: ${parsed.error.issues[0]?.message ?? 'unexpected shape'}`,
          });
        }
        itemLocations = parsed.data;
      }

      const submitMode: 'with_item' | 'account_only' =
        submissionShape === 'account_only' ? 'account_only' : 'with_item';

      // Consent booleans are read, then stripped so they never reach Ajv or
      // item_state. Consent is required for adults only (see below).
      const termsOk = body['consent_terms'] === true;
      const privacyOk = body['consent_privacy'] === true;
      const profileConsentOk = body['consent_profile'] === true;
      delete body['consent_terms'];
      delete body['consent_privacy'];
      delete body['consent_profile'];

      // Year of birth gives the age; it is stripped from `body`. Only this
      // top-level age triggers the U18 rule, not a profile `age` field. Falls back
      // to body `age` for older clients.
      const yobRaw = body['year_of_birth'];
      delete body['year_of_birth'];
      const coerceNum = (v: unknown): number | undefined =>
        typeof v === 'number'
          ? v
          : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))
            ? Number(v)
            : undefined;
      const yob = coerceNum(yobRaw);
      const derivedAge =
        yob !== undefined ? new Date().getUTCFullYear() - yob : coerceNum(body['age']);

      // A minor cannot give consent here; they accept terms in the Signals app.
      // Signals rejects an onboard with top-level `age < 18`, so for a minor send
      // neither age nor compliance. For an adult, require consent and send both.
      // Unknown age is treated as adult.
      const isMinor = derivedAge !== undefined && derivedAge <= 18;
      if (consentRequiredForDomain && !isMinor) {
        const missingConsent: string[] = [];
        if (!termsOk) missingConsent.push('user_terms');
        if (!privacyOk) missingConsent.push('user_privacy');
        if (submitMode === 'with_item' && !profileConsentOk)
          missingConsent.push('profile_creation');
        if (missingConsent.length > 0) {
          throw httpError('CONSENT_REQUIRED', { fields: { missing: missingConsent } });
        }
      }
      const ageNum = isMinor ? undefined : derivedAge;
      // Send compliance only when the domain requires consent and the registrant is an adult.
      const compliance =
        !consentRequiredForDomain || isMinor
          ? undefined
          : [
              { key: 'user_terms', value: true },
              { key: 'user_privacy', value: true },
              ...(submitMode === 'account_only' ? [] : [{ key: 'profile_creation', value: true }]),
            ];

      // Identity selectors come from the network config (schema sniffer, with
      // aggregator.config.yaml overrides).
      const networkCfg = await getNetworkConfig();
      const linkDomainCfg = networkCfg.domains[link.domain];
      if (!linkDomainCfg) {
        throw httpError('NOT_FOUND', {
          detail: `link domain '${link.domain}' not declared in network ${networkCfg.network.id}`,
        });
      }
      const phoneSourceKey = linkDomainCfg.identity.phone;

      // 1. Validate against the domain schema. Skipped for `account_only`: identity
      // was checked above and Ajv would flag the consent keys as extra properties.
      if (submissionShape !== 'account_only') {
        // Remove empty cells before Ajv, so an unfilled field is absent rather than
        // failing `format`/`type`/`minLength`. Same as the worker's bulk-row strip.
        const schemaRef = { id: `participant-${link.domain}`, version: 'v1' };
        const loader = getSchemaLoader();
        const validatorResult = await loader.getValidator(schemaRef);
        if (!validatorResult.success) {
          log.error({ status: 'failure', sub: 'schema.load', error: validatorResult.error.code });
          throw httpError('INTERNAL', {
            detail: 'Registration schema unavailable.',
            cause: new Error(validatorResult.error.message),
          });
        }
        stripEmptyCells(body);

        // Name and at least one contact are required even on a partial profile;
        // Ajv below ignores `required`. Same rule as the account_only guard.
        {
          const present = (k?: string): boolean =>
            !!k && typeof body[k] === 'string' && (body[k] as string).length > 0;
          const nameKey = linkDomainCfg.identity.name;
          const emailKey = linkDomainCfg.identity.email;
          const hasName = present(nameKey);
          const hasPhone = present(phoneSourceKey);
          const hasEmail = present(emailKey);
          if (!hasName || (!hasPhone && !hasEmail)) {
            throw httpError('SCHEMA_VALIDATION', {
              detail: 'Registration requires name and at least one of phone or email.',
              fields: {
                missing: [
                  ...(!hasName ? [nameKey ?? 'name'] : []),
                  ...(!hasPhone && !hasEmail ? ['phone_or_email'] : []),
                ],
              },
            });
          }
        }

        const validate = validatorResult.value;
        if (!validate(body)) {
          // Partial profiles are accepted: drop `required` errors outside a `then` branch, since
          // signals marks such an item `draft`. Constraints on present fields still 400.
          //
          // For a conditional requirement (`allOf`/`if`/`then`), a `required` error
          // inside `then` is kept because signals enforces it. Ajv's `if` summary error
          // names no field, so it is dropped.
          const isConditionalRequired = (e: { keyword?: string; schemaPath?: string }) =>
            e.keyword === 'required' && (e.schemaPath ?? '').includes('/then/');
          const issues = (validate.errors ?? []).filter(
            (e) => e.keyword !== 'if' && (e.keyword !== 'required' || isConditionalRequired(e)),
          );
          if (issues.length > 0) {
            // Name each failed field in Signals' wording (#904): the form shows
            // `detail` in its banner, so it must say which field is wrong.
            const described = issues.map((e) => describeSchemaIssue(e, linkDomainCfg.schema));
            throw httpError('SCHEMA_VALIDATION', {
              detail: formatFieldErrors(described),
              fields: { issues, field_errors: fieldErrorMap(described) },
            });
          }
        }
      }

      // 2. Normalise the phone and email. Any client-supplied `participant_id` is
      // dropped, so an anonymous caller cannot choose it.
      delete (body as Record<string, unknown>)['participant_id'];
      const emailSourceKey = linkDomainCfg.identity.email;
      const phoneRaw =
        typeof body[phoneSourceKey] === 'string' ? (body[phoneSourceKey] as string) : '';
      let phoneNormalised: string | null = null;
      if (phoneRaw) {
        const phone = normalisePhone(phoneRaw);
        if (!phone.ok) {
          throw httpError('INVALID_PHONE', { detail: phone.error.message });
        }
        phoneNormalised = phone.value;
      }
      // Email is optional.
      const emailRaw =
        emailSourceKey && typeof body[emailSourceKey] === 'string'
          ? (body[emailSourceKey] as string)
          : '';
      const emailNormalised = emailRaw ? emailRaw.trim().toLowerCase() : null;

      // 2a. Read the signalstack org id from `users.signalstack_org_id` before the
      // transaction. NULL means the org was never registered with signalstack: answer
      // 503 so the participant retries.
      const ss = getSignalStackWriter();
      let signalstackOrgId: string | null = null;
      if (ss) {
        const aggLookup = await getUserStore().findById(link.aggregatorId);
        if (!aggLookup.ok) {
          throw httpError('DB_UNAVAILABLE', {
            fields: { sub_operation: 'userStore.findById' },
          });
        }
        if (!aggLookup.value) {
          throw httpError('NOT_FOUND', { detail: 'Aggregator missing for live link.' });
        }
        signalstackOrgId = aggLookup.value.signalstackOrgId;
        if (!signalstackOrgId) {
          throw httpError('SIGNALSTACK_ORG_NOT_REGISTERED', {
            fields: { aggregator_id: link.aggregatorId, link_id: link.id },
          });
        }
      }

      // 3 + 4. The link_submission INSERT and the signalstack push commit together:
      // a push failure rolls the row back, so a 2xx means signals has the profile.
      // Lifecycle fields are null when signals is disabled or the submit is account_only.
      let lifecycleStatusOut: LifecycleStatus | null = null;
      let ownedElsewhere = false;
      const txResult = await getDb().transaction(async (tx) => {
        // Default outcome; signals overwrites it when configured.
        const insertedOutcome: 'passed' | 'skipped' = 'passed';
        let outcome: 'passed' | 'skipped' = insertedOutcome;

        const submission = await tx
          .insert(linkSubmissions)
          .values({
            linkId: link.id,
            userId: link.aggregatorId,
            metadataSnapshot: link.context,
            submittedData: body,
            outcome,
          })
          .returning({ id: linkSubmissions.id });

        // Push inside the transaction so a failure rolls back the submission row.
        if (ss && signalstackOrgId) {
          const nameSourceKey = linkDomainCfg.identity.name;
          // Fallback only; the guard above rejects a blank name. The link id is an opaque UUID.
          const name =
            typeof body[nameSourceKey] === 'string' ? (body[nameSourceKey] as string) : link.id;
          const phoneFromBody =
            typeof body[phoneSourceKey] === 'string'
              ? (body[phoneSourceKey] as string)
              : phoneNormalised;
          const pushPhone = phoneNormalised ?? phoneFromBody;
          const result = await ss.onboard({
            actingOrgId: signalstackOrgId,
            requestId: req.id,
            name,
            ...(pushPhone ? { phoneNumber: pushPhone } : {}),
            ...(emailNormalised ? { email: emailNormalised } : {}),
            // Adult: send consent via `compliance`, plus age. Minor: send neither.
            ...(compliance ? { compliance } : {}),
            ...(ageNum !== undefined ? { age: ageNum } : {}),
            channel: 'link',
            source_id: link.id,
            network: config.SIGNALSTACK_ITEM_NETWORK,
            domain: link.domain,
            item_type: linkDomainCfg.itemType,
            profile: buildSignalStackItemState(body, pushPhone, linkDomainCfg.identity.phone),
            // Omitted when empty so signalstack geocodes the address text.
            ...(itemLocations.length > 0 ? { item_locations: itemLocations } : {}),
            submit_mode: submitMode,
          });

          if (!result.success) {
            log.error({
              status: 'failure',
              sub: 'signalstack.push',
              error: result.error.message,
              code: result.error.code,
              link_id: link.id,
            });
            // Show signals' profile-limit message as is; other failures get a generic message.
            const signalsMessage = (
              result.error.details as { signalsMessage?: unknown } | undefined
            )?.signalsMessage;
            // A client that skips the minor check gets `U18_NOT_ALLOWED` from Signals;
            // map it to the finish-in-the-app response.
            if (result.error.message.includes('U18_NOT_ALLOWED')) {
              throw httpError('U18_REGISTRATION_REDIRECT', {
                fields: { code: result.error.code, message: result.error.message },
                cause: result.error,
              });
            }
            // Signals rejected the profile data itself (#904). That is the
            // participant's input, not a server fault: answer 400 with Signals'
            // per-field messages so the form names the field, instead of the
            // generic 502 below.
            const details = result.error.details as
              { upstreamCode?: unknown; signalsFields?: unknown } | undefined;
            if (
              details?.upstreamCode === 'INVALID_ITEM_STATE' &&
              isStringMap(details.signalsFields) &&
              Object.keys(details.signalsFields).length > 0
            ) {
              const signalsFields = details.signalsFields;
              throw httpError('SCHEMA_VALIDATION', {
                detail: formatFieldErrors(
                  Object.entries(signalsFields).map(([field, message]) => ({
                    field,
                    label: fieldLabel(linkDomainCfg.schema, field),
                    message,
                  })),
                ),
                fields: {
                  field_errors: signalsFields,
                  upstream_code: details.upstreamCode,
                },
                cause: result.error,
              });
            }
            const detail =
              result.error.code === 'SIGNALSTACK_PROFILE_LIMIT_REACHED' &&
              typeof signalsMessage === 'string'
                ? signalsMessage
                : `Signalstack rejected the participant push (${result.error.code}).`;
            throw httpError('SIGNALSTACK_PUSH_FAILED', {
              detail,
              fields: { code: result.error.code, message: result.error.message },
              cause: result.error,
            });
          }

          // `account_only` creates no item, so lifecycle fields are null.
          const lifecycleStatus =
            submitMode === 'account_only' || !result.value.profile_item_id
              ? null
              : resolveLifecycle({
                  ...(result.value.lifecycle_status
                    ? { lifecycle_status: result.value.lifecycle_status }
                    : {}),
                });
          ownedElsewhere = Boolean(result.value.owned_elsewhere);
          lifecycleStatusOut = lifecycleStatus;

          // Signals decides the outcome. Each submission creates a new profile; there
          // is no dedup within an aggregator. Skip only when another aggregator owns
          // the identity (tenant isolation).
          outcome = ownedElsewhere ? 'skipped' : 'passed';

          log.info({
            status: 'success',
            sub: 'signalstack.push',
            user_id: result.value.user_id,
            profile_item_id: result.value.profile_item_id,
            onboarded_at: result.value.onboarded_at,
            already_registered: result.value.already_registered ?? false,
            owned_elsewhere: ownedElsewhere,
            lifecycle_status: lifecycleStatus,
            submit_mode: submitMode,
            link_id: link.id,
          });
        }

        // The row was inserted with `passed`; store any correction to `skipped` in
        // the same transaction so the row matches the response.
        const submissionId = submission[0]?.id;
        if (submissionId && outcome !== insertedOutcome) {
          await tx
            .update(linkSubmissions)
            .set({ outcome })
            .where(eq(linkSubmissions.id, submissionId));
        }

        return {
          outcome,
          submissionId,
        };
      });
      const { outcome, submissionId } = txResult;

      log.info({
        status: 'success',
        event_type: 'audit',
        audit: 'link.submission_recorded',
        latency_ms: Date.now() - start,
        link_id: link.id,
        outcome,
        submission_id: submissionId,
        lifecycle_status: lifecycleStatusOut,
        owned_elsewhere: ownedElsewhere,
        submit_mode: submitMode,
      });

      if (outcome === 'skipped') {
        // Owned by another aggregator: 409 with no participant identifier.
        return reply.code(409).send({
          outcome,
          submission_id: submissionId,
          message: 'This mobile number or email is already registered with another aggregator.',
          registration_mode: link.registrationMode,
          submission_shape: submissionShape,
          lifecycle_status: lifecycleStatusOut,
          owned_elsewhere: ownedElsewhere,
        });
      }

      return reply.code(201).send({
        outcome,
        submission_id: submissionId,
        registration_mode: link.registrationMode,
        submission_shape: submissionShape,
        lifecycle_status: lifecycleStatusOut,
        owned_elsewhere: ownedElsewhere,
      });
    },
  );
}

/**
 * Deletes every top-level field whose value is empty (`null`, `undefined`,
 * blank string, or empty array), required or not.
 *
 * An absent required field makes signals mark the item `draft`. Matches the
 * worker's `stripAllEmptyCells`.
 *
 * @param payload - The submission body; mutated in place.
 */
function stripEmptyCells(payload: Record<string, unknown>): void {
  for (const [field, value] of Object.entries(payload)) {
    const isEmpty =
      value === null ||
      value === undefined ||
      (typeof value === 'string' && value.trim() === '') ||
      (Array.isArray(value) && value.length === 0);
    if (isEmpty) {
      delete payload[field];
    }
  }
}

/**
 * Loads a registration link by (org_slug, slug) and checks it is `live`.
 * Missing answers 404; retired or expired answers 410.
 */
async function loadLiveLinkByOrgAndSlug(
  orgSlug: string,
  slug: string,
  log: FastifyRequest['log'],
): Promise<RegistrationLink> {
  const store = getRegistrationLinksStore();
  const found = await store.findByOrgAndSlug(orgSlug, slug);
  if (!found.ok) {
    throw httpError('DB_UNAVAILABLE', { cause: new Error(found.error.message) });
  }
  if (!found.value || found.value.status === 'draft') {
    log.info({ status: 'failure', reason: 'not_found' });
    throw httpError('NOT_FOUND', { detail: 'No registration link for this slug.' });
  }
  if (found.value.status === 'retired') {
    log.info({ status: 'failure', reason: 'retired', link_id: found.value.id });
    throw httpError('LINK_NOT_LIVE', {
      detail: 'This registration link has been retired.',
    });
  }
  if (found.value.expiresAt && found.value.expiresAt.getTime() < Date.now()) {
    log.info({ status: 'failure', reason: 'expired', link_id: found.value.id });
    throw httpError('LINK_NOT_LIVE', {
      detail: 'This registration link has expired.',
    });
  }
  return found.value;
}

/**
 * Collapses described field errors into `{ field: message }`, first message
 * per field, the same shape as Signals' `fields` map.
 *
 * @param errors - Described field errors in report order.
 * @returns One message per field; field-less errors are left out.
 */
function fieldErrorMap(errors: readonly FieldError[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of errors) {
    if (e.field && !Object.hasOwn(out, e.field)) out[e.field] = e.message;
  }
  return out;
}

/** True for a plain `{ string: string }` object such as Signals' `fields` map. */
function isStringMap(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === 'string')
  );
}
