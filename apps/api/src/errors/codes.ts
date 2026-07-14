/**
 * Central error code catalogue.
 *
 * Every domain-specific failure has one entry here. Routes throw
 * `httpError(ERR.<KEY>)` and the global error handler renders the canonical
 * envelope. Adding a new error = adding a row here.
 *
 * Layered fields per code:
 *   - `code`     machine identifier surfaced in API response and logs
 *   - `status`   HTTP status the handler returns
 *   - `title`    short human-readable headline shown in the UI
 *   - `detail`   fuller user-facing sentence shown in API response body
 *   - `hint`     internal/dev-facing context for debugging — logs only
 *   - `docs`     optional link to runbook or self-service page
 */

export interface ErrorCatalogueEntry {
  readonly code: string;
  readonly status: number;
  readonly title: string;
  readonly detail: string;
  readonly hint: string;
  readonly docs?: string;
}

export const ERR = {
  // ── Generic ─────────────────────────────────────────────────────────────
  INTERNAL: {
    code: 'INTERNAL',
    status: 500,
    title: 'Something went wrong',
    detail: 'The server hit an unexpected error. Please try again.',
    hint: 'Unhandled exception reached the global error handler. Check stack.',
  },
  CONSENT_WRITE_FAILED: {
    code: 'CONSENT_WRITE_FAILED',
    status: 500,
    title: 'Could not record consent',
    detail:
      'Your consent could not be recorded, so the registration was not completed. Please try again.',
    hint: 'The consent-ledger write failed and the registration was rolled back (fail-closed). Check consent config + DB.',
  },
  SCHEMA_VALIDATION: {
    code: 'SCHEMA_VALIDATION',
    status: 400,
    title: 'Invalid input',
    detail: 'One or more fields failed validation.',
    hint: 'Zod or Ajv rejected the request body. See response.error.fields for offending paths.',
  },
  BAD_JSON: {
    code: 'BAD_JSON',
    status: 400,
    title: 'Invalid request',
    detail: 'Request body is not valid JSON.',
    hint: 'Fastify body parser threw. Check Content-Type and body bytes.',
  },

  // ── Auth ────────────────────────────────────────────────────────────────
  UNAUTHORIZED: {
    code: 'UNAUTHORIZED',
    status: 401,
    title: 'Sign-in required',
    detail: 'Your session is missing or invalid. Please sign in again.',
    hint: 'Bearer token absent, malformed, or signature/issuer/exp check failed.',
  },
  FORBIDDEN: {
    code: 'FORBIDDEN',
    status: 403,
    title: 'Access denied',
    detail: 'You do not have permission to perform this action.',
    hint: 'JWT aggregator_id claim does not match path id, or role missing.',
  },
  NOT_APPROVED: {
    code: 'NOT_APPROVED',
    status: 403,
    title: 'Approval pending',
    detail:
      'Your aggregator account has not been approved yet. An admin must approve the registration before this action is available.',
    hint: 'JWT `decision_made` claim is missing, "pending", or "rejected". See requireApproved().',
  },
  AGGREGATOR_TYPE_MISMATCH: {
    code: 'AGGREGATOR_TYPE_MISMATCH',
    status: 403,
    title: 'Wrong participant type',
    detail:
      'Your aggregator is registered for a different participant type. You can only upload or create registration links for the type you registered as.',
    hint: 'Request body participant_type does not match the JWT `aggregator_type` claim.',
  },
  AGGREGATOR_TYPE_MISSING: {
    code: 'AGGREGATOR_TYPE_MISSING',
    status: 403,
    title: 'Aggregator type not set',
    detail:
      'Your account is missing its aggregator type. Sign out and back in to refresh your session; if the problem persists, contact support.',
    hint: 'JWT has no `aggregator_type` claim. KC user attribute missing or mapper not configured. Refresh required after backfill.',
  },

  // ── Registration ────────────────────────────────────────────────────────
  USER_EXISTS: {
    code: 'USER_EXISTS',
    status: 409,
    title: 'Email already registered',
    detail: 'An account with this email already exists. Use a different email or sign in instead.',
    hint: 'Pre-check at idp.findByEmail returned non-null. Stale or duplicate KC user.',
  },
  PHONE_EXISTS: {
    code: 'PHONE_EXISTS',
    status: 409,
    title: 'Phone already registered',
    detail:
      'A user with this mobile number already exists. Use a different number or sign in instead.',
    hint: 'idp.findByAttribute(phoneNumber) returned non-null. Phone is OTP login key — must be unique.',
  },
  INVALID_PHONE: {
    code: 'INVALID_PHONE',
    status: 400,
    title: 'Invalid phone number',
    detail: 'The phone number format is not recognised. Include country code, e.g. +91…',
    hint: 'normalisePhone() failed E.164 parse. Check libphonenumber output.',
  },

  // ── IDP (Keycloak) ──────────────────────────────────────────────────────
  IDP_UNAVAILABLE: {
    code: 'IDP_UNAVAILABLE',
    status: 503,
    title: 'Identity service unavailable',
    detail: 'The identity service is temporarily unreachable. Please try again shortly.',
    hint: 'Keycloak admin API call failed (network/timeout/5xx). Check KC pod + admin creds.',
  },

  // ── Downstream identity store (signalstack) ─────────────────────────────
  SIGNALSTACK_PUSH_FAILED: {
    code: 'SIGNALSTACK_PUSH_FAILED',
    status: 502,
    title: 'Could not register with signalstack',
    detail:
      'The participant was validated locally but could not be pushed to the signalstack identity store. Please retry; if the problem persists, contact support.',
    hint: 'signalstack-writer.onboard returned a non-2xx. See response.error.fields.code for the writer-side classification (transport, timeout, validation, etc.).',
  },

  SIGNALSTACK_ORG_NOT_REGISTERED: {
    code: 'SIGNALSTACK_ORG_NOT_REGISTERED',
    status: 503,
    title: 'Aggregator not registered with signalstack',
    detail:
      'This aggregator has no signalstack organisation id on file. Submissions cannot be pushed until the aggregator owner signs into the portal once so the org registration completes.',
    hint: 'aggregators.signalstack_org_id is NULL. Either the approval-time upsert failed and was never retried, or the login-time backfill has not run yet for this aggregator.',
  },

  SIGNALSTACK_PROBE_FAILED: {
    code: 'SIGNALSTACK_PROBE_FAILED',
    status: 502,
    title: 'Could not check identity with signalstack',
    detail:
      'The identity probe to signalstack failed. The lookup is idempotent; please retry. If the problem persists, contact support.',
    hint: 'signalstack-writer.probeUser returned a non-2xx (transport, timeout, or upstream error). Distinct from SIGNALSTACK_PUSH_FAILED, which is the write-mode error.',
  },

  // ── Support / contact form ──────────────────────────────────────────────────
  SUPPORT_NOT_CONFIGURED: {
    code: 'SUPPORT_NOT_CONFIGURED',
    status: 503,
    title: 'Support unavailable',
    detail: 'Support is not configured on this instance.',
    hint: 'Set SUPPORT_EMAIL to enable the contact-support form.',
  },
  SUPPORT_SEND_FAILED: {
    code: 'SUPPORT_SEND_FAILED',
    status: 502,
    title: 'Could not send support message',
    detail: 'Failed to send your message. Please try again later.',
    hint: 'The mail transport rejected or failed the send.',
  },

  // ── Persistence ─────────────────────────────────────────────────────────
  DB_UNAVAILABLE: {
    code: 'DB_UNAVAILABLE',
    status: 503,
    title: 'Service temporarily unavailable',
    detail: 'A backend service is offline. Please retry in a few moments.',
    hint: 'Postgres write failed (connection/constraint/timeout). Check DB pod + slug retries.',
  },
  DUPLICATE_SLUG: {
    code: 'DUPLICATE_SLUG',
    status: 503,
    title: 'Service temporarily unavailable',
    detail: 'Could not allocate a unique identifier for your organisation. Please retry.',
    hint: 'slugWithSuffix collisions exhausted SLUG_RETRIES. Increase entropy or retries.',
  },

  // ── Mail / approval token ───────────────────────────────────────────────
  TOKEN_MINT_FAILED: {
    code: 'TOKEN_MINT_FAILED',
    status: 500,
    title: 'Could not finalise registration',
    detail:
      'We saved your details but failed to issue an approval link. An admin can still process the request.',
    hint: 'mintApprovalToken() threw. Check JWT signing key + jose library.',
  },
  MAIL_FAILED: {
    code: 'MAIL_FAILED',
    status: 500,
    title: 'Email delivery failed',
    detail: 'We could not send the email. Please contact support.',
    hint: 'mailer.send returned non-ok. Check SMTP config + provider response.',
  },

  // ── Approval flow ───────────────────────────────────────────────────────
  APPROVAL_TOKEN_INVALID: {
    code: 'APPROVAL_TOKEN_INVALID',
    status: 400,
    title: 'Invalid approval link',
    detail: 'This approval link is malformed or has been tampered with.',
    hint: 'JWT verification failed. Check signing key rotation.',
  },
  APPROVAL_TOKEN_EXPIRED: {
    code: 'APPROVAL_TOKEN_EXPIRED',
    status: 410,
    title: 'Approval link expired',
    detail: 'This approval link has expired. Ask the applicant to resubmit.',
    hint: 'JWT exp in past. TTL is 1h.',
  },
  APPROVAL_TOKEN_USED: {
    code: 'APPROVAL_TOKEN_USED',
    status: 409,
    title: 'Already processed',
    detail: 'This registration has already been approved or rejected.',
    hint: 'Decision row exists. Single-use token replayed.',
  },

  // ── Generic resource ────────────────────────────────────────────────────
  NOT_FOUND: {
    code: 'NOT_FOUND',
    status: 404,
    title: 'Not found',
    detail: 'The requested resource does not exist.',
    hint: 'Store returned null for the given id.',
  },
  CONFLICT: {
    code: 'CONFLICT',
    status: 409,
    title: 'Action not allowed',
    detail: 'The requested action conflicts with the current resource state.',
    hint: 'State-machine transition disallowed (e.g. retired → live).',
  },
  OWNER_ALREADY_REGISTERED: {
    code: 'OWNER_ALREADY_REGISTERED',
    status: 409,
    title: 'Already an organisation owner',
    detail:
      'This email or phone already belongs to an organisation owner. Request coordinator access from your organisation instead of registering again.',
    hint: 'Coordinator submit matched an aggregator_orgs.owner_email (spec A4). Owner→coordinator graduation is deferred.',
  },
  ORG_SLUG_TAKEN: {
    code: 'ORG_SLUG_TAKEN',
    status: 409,
    title: 'Organisation name unavailable',
    detail:
      'An organisation with a matching name is already registered or pending. Try a different name.',
    hint: 'aggregator_orgs partial-unique slug collision over non-terminal rows (spec A9).',
  },
  ORG_NAME_TAKEN: {
    code: 'ORG_NAME_TAKEN',
    status: 409,
    title: 'Organisation name unavailable',
    detail:
      'An organisation with this name is already registered or pending. Please choose a different name.',
    hint: 'aggregator_orgs partial-unique display_name (case-insensitive) collision over non-terminal rows.',
  },
  TARGET_ORG_INACTIVE: {
    code: 'TARGET_ORG_INACTIVE',
    status: 409,
    title: 'Organisation unavailable',
    detail:
      'The selected organisation is not accepting coordinators. Contact the organisation owner.',
    hint: 'Coordinator submit/approval against an org whose status != active (spec §6.2 re-validate).',
  },

  // ── Bulk uploads ────────────────────────────────────────────────────────
  BULK_UPLOAD_NOT_READY: {
    code: 'BULK_UPLOAD_NOT_READY',
    status: 410,
    title: 'Errors report not ready',
    detail: 'The errors report is only available after the upload finishes processing.',
    hint: 'GET /errors.csv called before bulk_uploads.status reached completed.',
  },

  // ── Registration links (public path) ────────────────────────────────────
  LINK_NOT_LIVE: {
    code: 'LINK_NOT_LIVE',
    status: 410,
    title: 'Registration link no longer active',
    detail: 'This registration link is not accepting submissions.',
    hint: 'registration_link.status is retired or expired.',
  },
  LINK_DUPLICATE: {
    code: 'LINK_DUPLICATE',
    status: 409,
    title: 'Already registered',
    detail: 'This participant has already registered with this aggregator.',
    hint: 'participants UNIQUE (aggregator_id, participant_id) — ON CONFLICT path.',
  },
  RATE_LIMITED: {
    code: 'RATE_LIMITED',
    status: 429,
    title: 'Too many requests',
    detail: 'You have made too many requests. Please slow down and retry shortly.',
    hint: 'Per-slug+ip rate limiter on public submit; window/max in config.',
  },

  // ── Registration mode (per-link admin channel; voice / form / future) ──
  REGISTRATION_MODE_MISMATCH: {
    code: 'REGISTRATION_MODE_MISMATCH',
    status: 400,
    title: 'Registration mode mismatch',
    detail:
      'This registration link only accepts identity fields (name + phone or email + consent). It does not accept profile data.',
    hint: 'POST body to a link whose registration_mode resolves to submission_shape=account_only included item_state or unknown fields. Server rejects to prevent profile leakage into an account-only capture.',
  },
  REGISTRATION_MODE_IMMUTABLE: {
    code: 'REGISTRATION_MODE_IMMUTABLE',
    status: 400,
    title: 'Registration mode cannot be changed',
    detail:
      'The registration mode is fixed at link creation time. Create a new link to use a different mode.',
    hint: 'PATCH /v1/links/:id included registration_mode. Immutable by design — UpdateLinkBodySchema is .strict() so unknown keys 400 automatically.',
  },
  INVALID_REGISTRATION_MODE: {
    code: 'INVALID_REGISTRATION_MODE',
    status: 400,
    title: 'Invalid registration mode',
    detail: 'The selected registration mode is not declared in this network configuration.',
    hint: 'Create body referenced a mode key not present in aggregator.config.yaml registration_modes. Surface the declared keys via fields.declared.',
  },
  INVALID_CONFIG: {
    code: 'INVALID_CONFIG',
    status: 400,
    title: 'Invalid configuration',
    detail: 'The combination of fields supplied is not allowed by the API.',
    hint: 'A field combination violates a business invariant (e.g. profile fields on an account_only link). Inspect detail for the specific rule.',
  },
} as const satisfies Record<string, ErrorCatalogueEntry>;

export type ErrorCode = keyof typeof ERR;
