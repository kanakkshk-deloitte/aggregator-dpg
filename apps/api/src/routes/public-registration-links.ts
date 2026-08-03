/**
 * Public registration link endpoints.
 *
 *   GET  /public/v1/aggregators/:orgSlug/links/:slug
 *     Anonymous resolve. Returns the public-safe shape of a live link so a
 *     BFF can render the registration form. 404 for missing or draft slugs;
 *     410 for retired or expired ones.
 *
 *   POST /public/v1/aggregators/:orgSlug/registrations/:slug
 *     Anonymous synchronous submit. Validates the body against the active
 *     participant schema for the link's domain, normalises phone+email,
 *     creates the participant + a link_submission row, and returns the
 *     submission id.
 *
 * Security model: (org_slug, slug) pair is the access token. No JWT
 * required. Aggregator scoping is implicit via the link row.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PostgresParticipantsWriter } from '@aggregator-dpg/participants-writer/postgres';
import type { ParticipantsWriterBase } from '@aggregator-dpg/participants-writer/interface';
import { getRegistrationLinksStore } from '../services/registration-links-store/index.js';
import type { RegistrationLink } from '../services/registration-links-store/index.js';
import { getAggregatorStore } from '../services/aggregator-store/index.js';
import { getNetworkConfig } from '../services/network-config.js';
import { resolveSubmissionShape, publicHintI18nKey } from '../services/registration-mode/index.js';
import { getSchemaLoader } from '../services/schema-loader/index.js';
import { normalisePhone } from '../services/phone.js';
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

let participantsWriter: ParticipantsWriterBase | null = null;
function getParticipantsWriter(): ParticipantsWriterBase {
  if (participantsWriter) return participantsWriter;
  participantsWriter = new PostgresParticipantsWriter(getDb());
  return participantsWriter;
}

/** Test helper — override the writer (e.g., inject a fake). */
export function _setParticipantsWriter(w: ParticipantsWriterBase | null): void {
  participantsWriter = w;
}

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
 * Submission body. The profile portion is dynamic — it is validated at
 * runtime (Ajv) against the active participant JSON Schema for the link's
 * domain, so no static shape can be pinned here. Identity field names
 * (name / phone / email) also vary per network and come from the network
 * config; `consent_terms` / `consent_privacy` booleans are accepted on
 * account_only links.
 */
const PublicRegistrationSubmitBodySchema = z
  .object({})
  .passthrough()
  .describe(
    "Dynamic registration payload validated at runtime against the link domain's participant JSON Schema (identity fields such as name/phone/email plus profile fields). consent_terms / consent_privacy are accepted on account_only links.",
  );

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

/** 409 payload — dedup hit: the phone/email is already registered. */
const SubmitSkippedResponseSchema = SubmitAcceptedResponseSchema.extend({
  outcome: z.string().describe("'skipped'"),
  message: z.string(),
}).passthrough();

export async function registerPublicRegistrationLinkRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/public/v1/aggregators/:orgSlug/links/:slug',
    {
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

      // Pull the link domain's JSON Schema from the live network config so
      // the public registration page can render the form without a
      // separate fetch (and without hardcoding any seeker/provider
      // assumption). Networks that omit the domain return 404 — the link
      // points at a no-longer-declared domain.
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

      // Per-link registration_mode resolves (via network config) to a form
      // shape that locks the rendered form:
      //   - 'account_and_profile': identity + full profile schema.
      //   - 'account_only': identity only — `schema` is nulled so the client
      //     never accidentally renders a profile form for this link.
      const submissionShape = resolveSubmissionShape(link.registrationMode, networkCfg);
      const hintKey = publicHintI18nKey(link.registrationMode, networkCfg);
      const accountOnly = submissionShape === 'account_only';

      return reply.send({
        slug: link.slug,
        // Active network id (e.g. 'blue_dot' / 'orange_dot'). The BFF needs
        // it alongside the domain to call /lookup, which scopes the probe
        // to the right signalstack network.
        network: networkCfg.network.id,
        domain: link.domain,
        context: link.context,
        registration_mode: link.registrationMode,
        submission_shape: submissionShape,
        public_hint_i18n_key: hintKey,
        schema_id: accountOnly ? null : `participant-${link.domain}`,
        schema_version: accountOnly ? null : 'v1',
        schema: accountOnly ? null : linkDomainCfg.schema,
        // Identity field selectors (name / phone / email) for this domain.
        // The public form needs them to relax required-field validation when
        // the user opts into "submit identity now, complete later": account-only
        // submits create no item, so only the identity fields signalstack needs
        // (a name + at least one contact) stay mandatory.
        identity: linkDomainCfg.identity,
        expires_at: link.expiresAt ? link.expiresAt.toISOString() : null,
      });
    },
  );

  app.post(
    '/public/v1/aggregators/:orgSlug/registrations/:slug',
    {
      schema: {
        tags: ['public-registration'],
        summary: 'Submit a public participant registration',
        description:
          "Public endpoint reached by the QR-link registration form. Validates the submission against the link's domain schema (runtime Ajv — the body shape is dynamic per network/domain), creates the participant + user, and pushes to signalstack. Returns 201 on success, 409 (outcome:'skipped') when the phone/email is already registered with this aggregator, and 429 when the per-link rate limit trips.",
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

      // Rate limit by (orgSlug, slug, ip). CAPTCHA enforcement is handled at
      // the BFF layer (Cloudflare Turnstile) — the API layer keeps a coarse
      // fallback so a misconfigured BFF can't expose unbounded write traffic.
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

      // Identity selectors live in the network config; load them up front so
      // both the account_only allowed-key guard and the downstream normaliser
      // share one source of truth.
      const networkCfgEarly = await getNetworkConfig();
      const linkDomainCfgEarly = networkCfgEarly.domains[link.domain];
      if (!linkDomainCfgEarly) {
        throw httpError('NOT_FOUND', {
          detail: `link domain '${link.domain}' not declared in network ${networkCfgEarly.network.id}`,
        });
      }

      // Resolve the link's registration_mode to a form shape via the live
      // network config. Unknown keys fall back to `account_and_profile` (see
      // resolveSubmissionShape) so config drift never hard-fails a live link.
      const submissionShape = resolveSubmissionShape(link.registrationMode, networkCfgEarly);

      // `account_only` shape locks the form: identity fields only, no profile
      // payload, no schema render. Reject any item_state or stray top-level key
      // BEFORE we touch the Ajv path. Allowed identity field names come from the
      // network config so the rule stays generic across signalstack networks
      // (blue_dot uses `phone`, purple_dot uses `mobile_number`, etc.). Server
      // enforcement only — the web form already renders just identity fields for
      // an account_only link, but trusting the client would let a tampered
      // submit bypass the capture-scope intent.
      if (submissionShape === 'account_only') {
        const allowed = new Set<string>([
          'consent_terms',
          'consent_privacy',
          // Age/year-of-birth required with consent on guardian-gated domains
          // (§4.4); the account_only form collects year_of_birth (age kept for
          // backward compatibility with older clients).
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
        // Identity-presence guard: name AND (phone OR email) must be present.
        // Without this we'd defer to signalstack-writer.onboard's guardInput
        // which 502s — wrong status code for a client-side missing-field.
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

      // The submit shape is driven entirely by the link's resolved
      // registration_mode — there is no client-supplied `partial` flag anymore.
      // `account_only` flips signals' lifecycle path to user-row-only (no item,
      // no lifecycle fields). `account_and_profile` always submits with_item;
      // missing required profile fields are accepted silently (see the Ajv
      // block below) and signals' classifier marks the item `draft`. The stray
      // `partial` key is stripped defensively in case an old client still sends
      // it.
      const body: Record<string, unknown> = { ...rawBody };
      delete body['partial'];

      const submitMode: 'with_item' | 'account_only' =
        submissionShape === 'account_only' ? 'account_only' : 'with_item';

      // Consent booleans are captured outside the participant profile schema,
      // then stripped from `body` so they never reach Ajv (a+p) or the
      // signalstack item_state. `consent_profile` (profile_creation) is a
      // distinct point on the with_item shape. See the minor branch below —
      // consent is required for adults only.
      const termsOk = body['consent_terms'] === true;
      const privacyOk = body['consent_privacy'] === true;
      const profileConsentOk = body['consent_profile'] === true;
      delete body['consent_terms'];
      delete body['consent_privacy'];
      delete body['consent_profile'];

      // Year of birth (snapshot model, no birthdate stored) → derived age.
      // Stripped from `body` so it never reaches Ajv / item_state; the a+p
      // profile keeps its own `age` schema field (which does NOT trigger the
      // U18 gate — only the top-level `age` does). Falls back to body `age`
      // for older clients.
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

      // U18 (§4.4): a minor cannot establish consent here — they accept terms
      // in the Signals app after signing in. Signals rejects any onboard that
      // carries a top-level `age < 18` (`U18_NOT_ALLOWED`) but creates the user
      // when NEITHER age NOR compliance is sent. So for a minor we submit
      // WITHOUT age and WITHOUT compliance (no consent required); for an adult
      // we require consent and forward both. Age is unknown ⇒ treat as adult
      // (form always collects year of birth).
      const isMinor = derivedAge !== undefined && derivedAge <= 18;
      if (!isMinor) {
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
      const compliance = isMinor
        ? undefined
        : [
            { key: 'user_terms', value: true },
            { key: 'user_privacy', value: true },
            ...(submitMode === 'account_only' ? [] : [{ key: 'profile_creation', value: true }]),
          ];

      // Identity selectors come from the resolved network config so the
      // route stays generic across signalstack networks. The sniffer
      // picks them up from the schema; aggregator.config.yaml overrides
      // when needed. Loaded up front so `account_only` validation can keep
      // just the identity fields required (see below).
      const networkCfg = await getNetworkConfig();
      const linkDomainCfg = networkCfg.domains[link.domain];
      if (!linkDomainCfg) {
        throw httpError('NOT_FOUND', {
          detail: `link domain '${link.domain}' not declared in network ${networkCfg.network.id}`,
        });
      }
      const phoneSourceKey = linkDomainCfg.identity.phone;

      // 1. Schema validation against the link's domain schema. Skipped for
      // `account_only` shape — the upstream identity-presence guard already
      // enforced shape (name + phone OR email + consent), no profile fields
      // are written, and running Ajv would mis-flag the consent toggles as
      // `additionalProperties` violations against the profile schema.
      if (submissionShape !== 'account_only') {
        // Strip every empty cell (required or not) BEFORE Ajv runs. An empty
        // cell means "not provided" — leaving it trips `format`/`type`/
        // `minItems`/`minLength` even on fields the participant never filled.
        // Removing it makes the field absent, which is exactly what signals'
        // shape-only validation relaxes (missing-required ⇒ `draft`). Mirrors
        // the worker's bulk-row strip so both ingest paths behave identically.
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

        // Identity-presence guard — mandatory even on a partial profile submit.
        // The relaxed Ajv pass below drops `required` so profile fields may be
        // blank (signals classifies the item `draft`), but identity itself —
        // name AND at least one contact — must always be present. Without this,
        // a blank name would silently fall back to the participant UUID and a
        // contactless row would 502 at signals' onboard guard. Mirrors the
        // account_only guard above so both shapes enforce the same invariant.
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
          // Silent partial-accept: `account_and_profile` links always submit
          // with_item, but a participant may save an incomplete profile. Drop
          // ONLY `required` errors (a missing field) — signals relaxes exactly
          // and only missing-required, classifying the item `draft`. Every
          // value constraint on a PRESENT field — `minItems`/`minLength`/
          // `minimum`/`type`/`format`/`pattern`/`enum`/`additionalProperties` —
          // still 400s here, matching signals' shape-only validation. Relaxing
          // value constraints would green-light data signals later rejects.
          const PARTIAL_OK = new Set(['required']);
          const issues = (validate.errors ?? []).filter((e) => !PARTIAL_OK.has(e.keyword ?? ''));
          if (issues.length > 0) {
            throw httpError('SCHEMA_VALIDATION', {
              detail: 'Submission failed schema validation.',
              fields: { issues },
            });
          }
        }
      }

      // 2. Normalisation. The server discards any client-supplied
      // `participant_id` (anonymous caller probing prevention) and derives the
      // dedup key from the normalised phone — same person re-submitting the
      // form hits the wrapper's ON CONFLICT path and returns outcome='skipped'.
      // Falls back to a fresh UUID when phone is absent so dedup degrades
      // gracefully for phone-optional schemas (no dedup, but still works).
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
      // Email is optional in IdentitySelectors
      // override is undefined; dedup falls back to phone-only.
      const emailRaw =
        emailSourceKey && typeof body[emailSourceKey] === 'string'
          ? (body[emailSourceKey] as string)
          : '';
      const emailNormalised = emailRaw ? emailRaw.trim().toLowerCase() : null;
      const participantId = phoneNormalised ?? randomUUID();

      // 2a. Resolve the aggregator's signalstack org id BEFORE opening the
      // transaction. Anonymous submitters carry no token, so the value must
      // come from `aggregators.signalstack_org_id` (written at approval time
      // or by the login-time backfill in `requireApproved`). A NULL here means
      // the aggregator never completed the signalstack handshake — fail fast
      // with 503 so the participant retries rather than landing a half-pushed
      // row.
      const ss = getSignalStackWriter();
      let signalstackOrgId: string | null = null;
      if (ss) {
        const aggLookup = await getAggregatorStore().findById(link.aggregatorId);
        if (!aggLookup.ok) {
          throw httpError('DB_UNAVAILABLE', {
            fields: { sub_operation: 'aggregatorStore.findById' },
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

      // 3 + 4. participant UPSERT (via shared writer), link_submission INSERT,
      // AND signalstack push must all commit atomically. A signalstack failure
      // rolls back the local rows so the caller sees a single, honest outcome:
      // a 2xx response means the participant exists in both stores. Tightens
      // the DB connection hold time — acceptable for a public-link form submit
      // (low volume). If push volume ever requires async fan-out, switch to an
      // outbox table inside the tx + worker consumer.
      // Lifecycle fields hoisted out of the tx scope so the response path can
      // surface them without re-reading the signals response. `null` is the
      // honest default: signals is disabled (no push) OR the submit was
      // account_only — neither produces a lifecycle classification.
      let lifecycleStatusOut: LifecycleStatus | null = null;
      let ownedElsewhere = false;
      const writer = getParticipantsWriter();
      const txResult = await getDb().transaction(async (tx) => {
        // Bind the writer to the active tx for atomicity. If a custom writer
        // (test fake) was injected via _setParticipantsWriter, use it directly.
        type DbCtor = ConstructorParameters<typeof PostgresParticipantsWriter>[0];
        const txWriter: ParticipantsWriterBase =
          writer instanceof PostgresParticipantsWriter
            ? new PostgresParticipantsWriter(tx as unknown as DbCtor)
            : writer;

        const writeResult = await txWriter.writeLinkSubmission({
          aggregatorId: link.aggregatorId,
          type: link.domain,
          participantId,
          data: body,
          phone: phoneNormalised,
          email: emailNormalised,
          sourceLinkId: link.id,
        });

        if (!writeResult.success) {
          // Bubble DB failure to fastify so the request returns 500.
          throw new Error(writeResult.error.message);
        }
        const { outcome: writeOutcome, participant } = writeResult.value;
        let outcome: 'passed' | 'skipped' = writeOutcome;
        const participantRowId = participant.id;

        const submission = await tx
          .insert(linkSubmissions)
          .values({
            linkId: link.id,
            aggregatorId: link.aggregatorId,
            participantId: participantRowId,
            metadataSnapshot: link.context,
            submittedData: body,
            outcome,
          })
          .returning({ id: linkSubmissions.id });

        // Outward signalstack push, inside the same tx so a downstream failure
        // rolls the local rows back. Local participant table is deduped per
        // (aggregator_id, type, participant_id); signalstack is the global
        // identity store and must also see the row, otherwise the dashboard
        // and downstream consumers are out of sync.
        if (ss && signalstackOrgId) {
          const nameSourceKey = linkDomainCfg.identity.name;
          const name =
            typeof body[nameSourceKey] === 'string'
              ? (body[nameSourceKey] as string)
              : participantRowId;
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
            // Adult: record consent via the `compliance` array (the live Signals
            // mechanism, never the deprecated flags) + forward age. Minor: both
            // omitted so Signals creates the user without consent (§4.4) — they
            // accept terms in the Signals app after signing in.
            ...(compliance ? { compliance } : {}),
            ...(ageNum !== undefined ? { age: ageNum } : {}),
            channel: 'link',
            source_id: link.id,
            network: config.SIGNALSTACK_ITEM_NETWORK,
            domain: link.domain,
            item_type: linkDomainCfg.itemType,
            profile: buildSignalStackItemState(link.domain, body, pushPhone, linkDomainCfg),
            submit_mode: submitMode,
          });

          if (!result.success) {
            log.error({
              status: 'failure',
              sub: 'signalstack.push',
              error: result.error.message,
              code: result.error.code,
              link_id: link.id,
              participant_id: participantRowId,
            });
            // Profile cap (signals #349): show the bare user-facing sentence
            // (no `signalstack onboard returned 409: PROFILE_LIMIT_REACHED:`
            // infra prefixes) directly on the public form. Falls back to the
            // generic string for any other push failure.
            const signalsMessage = (
              result.error.details as { signalsMessage?: unknown } | undefined
            )?.signalsMessage;
            // Belt-and-braces (§4.4): the form gates minors client-side, but a
            // bypassed client that pushes an under-18 gets Signals'
            // `U18_NOT_ALLOWED`. Map it to the finish-in-the-app response
            // instead of a generic push failure.
            if (result.error.message.includes('U18_NOT_ALLOWED')) {
              throw httpError('U18_REGISTRATION_REDIRECT', {
                fields: { code: result.error.code, message: result.error.message },
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

          // Cross-org existing user → signalstack has the person under a
          // different aggregator and won't expose/duplicate them here.
          // Record a skipped outcome so the form shows the friendly
          // "already registered" screen instead of a hard failure.
          // `already_registered` (legacy) and `owned_elsewhere` (Task 4 rename)
          // carry the same signal during the transition — OR them together so
          // either field flips the outcome.
          const isExisting =
            Boolean(result.value.already_registered) || Boolean(result.value.owned_elsewhere);
          if (isExisting) {
            outcome = 'skipped';
          }

          // Resolve lifecycle through the back-compat helper so the absent →
          // 'live' rule stays centralised. `account_only` submits produce no
          // item, so we suppress lifecycle fields entirely (null) — the
          // resolver would otherwise return 'live' for an absent column.
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

          // signalstack is the identity authority. The local participants table
          // is a soon-to-be-removed mirror, so its per-phone dedup must not flip
          // an account_only capture to `skipped`/409 — re-submitting the same
          // phone is an idempotent success (signals returns the same user). Drive
          // the account_only outcome from signals: skip only when the identity is
          // genuinely owned by another aggregator (owned_elsewhere).
          if (submitMode === 'account_only') {
            outcome = ownedElsewhere ? 'skipped' : 'passed';
          }

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
            participant_id: participantRowId,
          });
        }

        return {
          outcome,
          participantRowId,
          submissionId: submission[0]?.id,
        };
      });
      const { outcome, participantRowId, submissionId } = txResult;

      log.info({
        status: 'success',
        event_type: 'audit',
        audit: 'link.submission_recorded',
        latency_ms: Date.now() - start,
        link_id: link.id,
        outcome,
        participant_id: participantRowId,
        submission_id: submissionId,
        lifecycle_status: lifecycleStatusOut,
        owned_elsewhere: ownedElsewhere,
        submit_mode: submitMode,
      });

      if (outcome === 'skipped') {
        // Surface dedup in the response status to match the design (409).
        // `participant_id` is intentionally omitted on the public path so we
        // do not leak the DB row UUID of an existing participant to an
        // anonymous caller.
        return reply.code(409).send({
          outcome,
          submission_id: submissionId,
          message: 'This mobile number or email is already registered with this aggregator.',
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
 * Mutates `payload`: deletes any top-level field whose value is empty —
 * `null`, `undefined`, an empty/whitespace string, or an empty array —
 * regardless of whether the field is required.
 *
 * Partial submits seed unfilled fields with empty values (RJSF sends `[]`
 * for unselected multi-selects and `''` for blank inputs). Removing them
 * makes the field absent, which is exactly what signals' shape-only
 * validation relaxes: a missing required field classifies the item `draft`,
 * while value constraints on present fields stay enforced on both sides.
 * Mirrors the worker's `stripAllEmptyCells` so the two ingest paths agree.
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

function buildSignalStackItemState(
  _domain: string,
  body: Record<string, unknown>,
  pushPhone: string | null,
  domainCfg: { identity: { phone: string } },
): Record<string, unknown> {
  const itemState: Record<string, unknown> = { ...body };

  // Signalstack's item_state schema validates the phone field with the
  // network's own pattern (e.g. purple_dot mobile_number requires
  // `^[0-9]{10}$`). The E.164 form is already carried up-stack as the
  // user.phone_number identity arg, so item_state should keep the raw
  // body value the user submitted. Only overwrite when the body had no
  // value at all — preserves the bulk-CSV fallback while letting form
  // submits pass schema validation upstream.
  const rawPhone = body[domainCfg.identity.phone];
  if (pushPhone && (typeof rawPhone !== 'string' || rawPhone.length === 0)) {
    itemState[domainCfg.identity.phone] = pushPhone;
  }

  return itemState;
}

/**
 * Loads a registration link by (org_slug, slug) and asserts it is currently
 * `live`. Translates store/null/expiry into the canonical 404 / 410 status
 * codes.
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
