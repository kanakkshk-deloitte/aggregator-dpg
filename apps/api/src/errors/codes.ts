/**
 * Error code catalogue for the api app.
 *
 * Each failure has one entry. Routes throw `httpError(ERR.<KEY>)` and the
 * global error handler renders the envelope.
 *
 * Fields per code:
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

import { SUPPORTED_PLACEHOLDERS } from '@aggregator-dpg/campaign-template';

/** The supported placeholders, rendered as `{{token}}` for error hints. */
const PLACEHOLDER_LIST = SUPPORTED_PLACEHOLDERS.map((token) => `{{${token}}}`).join(', ');

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
  EXPORT_ENQUEUE_FAILED: {
    code: 'EXPORT_ENQUEUE_FAILED',
    status: 503,
    title: 'Export could not be queued',
    detail: 'The export request could not be queued for processing. Please retry shortly.',
    hint: 'The BullMQ enqueue failed — most likely Redis is unreachable. Check REDIS_URL and the queue Redis. (Downstream export config — network-admin email, Signals creds — lives on the worker and is not preflighted here.)',
  },
  EMAIL_ENQUEUE_FAILED: {
    code: 'EMAIL_ENQUEUE_FAILED',
    status: 503,
    title: 'Email could not be queued',
    detail: 'The campaign email request could not be queued for processing. Please retry shortly.',
    hint: 'The BullMQ enqueue failed — most likely Redis is unreachable. Check REDIS_URL and the queue Redis. (Mailer + Signals creds live on the worker and are not preflighted here.)',
  },
  UNKNOWN_PLACEHOLDER: {
    code: 'UNKNOWN_PLACEHOLDER',
    status: 400,
    title: 'Unknown template placeholder',
    detail: 'The subject or body contains a placeholder that is not supported.',
    hint: `Only the fixed set is allowed: ${PLACEHOLDER_LIST}. See response.error.fields.unknown for the offending tokens.`,
  },
  CAMPAIGN_TOO_MANY_ITEMS: {
    code: 'CAMPAIGN_TOO_MANY_ITEMS',
    status: 400,
    title: 'Too many items',
    detail: 'The request asks for more items than a single campaign job allows.',
    hint: 'item_ids length (after de-dup) exceeded the channel cap (e.g. CAMPAIGN_EXPORT_MAX_ITEMS). Split the request or raise the cap.',
  },
  CAMPAIGN_VOICE_TOO_MANY_ITEMS: {
    code: 'CAMPAIGN_VOICE_TOO_MANY_ITEMS',
    status: 400,
    title: 'Too many items',
    detail: 'The request asks for more items than a single voice campaign job allows.',
    hint: 'item_ids length (after de-dup) exceeded CAMPAIGN_VOICE_MAX_ITEMS. Split the request or raise the cap.',
  },
  VOICE_ENQUEUE_FAILED: {
    code: 'VOICE_ENQUEUE_FAILED',
    status: 503,
    title: 'Voice campaign could not be queued',
    detail: 'The voice campaign request could not be queued for processing. Please retry shortly.',
    hint: 'The BullMQ enqueue failed — most likely Redis is unreachable. Check REDIS_URL and the queue Redis. (Raya provider config lives on the worker and is not preflighted here.)',
  },
  CAMPAIGN_RATE_LIMITED: {
    code: 'CAMPAIGN_RATE_LIMITED',
    status: 429,
    title: 'Too many requests',
    detail: 'Too many campaign requests in a short window. Please retry shortly.',
    hint: 'Ingress rate-limit tripped (per-channel CAMPAIGN_<CHANNEL>_SUBMIT_MAX per CAMPAIGN_<CHANNEL>_SUBMIT_WINDOW_SECONDS, per org). See Retry-After.',
  },
  CAMPAIGN_ACTIVE_LIMIT: {
    code: 'CAMPAIGN_ACTIVE_LIMIT',
    status: 429,
    title: 'Too many active jobs',
    detail:
      'This organisation already has the maximum number of campaign jobs in progress. Wait for one to finish.',
    hint: 'Active (queued|processing) job count reached CAMPAIGN_<CHANNEL>_MAX_ACTIVE_PER_ORG for this signalstack_org_id.',
  },
  CAMPAIGN_JOB_FORBIDDEN: {
    code: 'CAMPAIGN_JOB_FORBIDDEN',
    status: 403,
    title: 'Job not accessible',
    detail: 'That campaign job does not belong to your organisation.',
    hint: 'getJob/getJobItems is tenant-scoped by signalstack_org_id. Per the contract spec §5 an unknown or other-org job id is a 403, not a 404.',
  },
  CONSENT_REQUIRED: {
    code: 'CONSENT_REQUIRED',
    status: 400,
    title: 'Consent required',
    detail: 'You must accept the terms and privacy policy to continue.',
    hint: 'The registration submit did not carry consent_terms=true and consent_privacy=true. The form must send both as booleans.',
  },
  U18_REGISTRATION_REDIRECT: {
    code: 'U18_REGISTRATION_REDIRECT',
    status: 400,
    title: 'Finish in the Signalstack app',
    detail:
      'Under-18 registration cannot be completed here. Please finish in the Signalstack app, where a parent or guardian can confirm.',
    hint: "Signals rejected the push with U18_NOT_ALLOWED. The form gates minors client-side (§4.4); this is the belt-and-braces mapping for a bypassed client. Signals' draft-create + u18_redirect_required path is not implemented upstream.",
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
  USER_NOT_PROVISIONED: {
    code: 'USER_NOT_PROVISIONED',
    status: 403,
    title: 'Account not set up',
    detail: 'Your sign-in is not linked to an account here yet. Contact the network administrator.',
    hint: 'No aggregator_id claim and no user_identities row for (IDP_PROVIDER, sub). The boot reconcile (root / Default owners) or org create links admins; nothing links by email.',
  },
  NOT_ORG_ADMIN: {
    code: 'NOT_ORG_ADMIN',
    status: 403,
    title: 'No active organisation',
    detail: 'Your account does not manage an active organisation.',
    hint: 'Admin account resolved by subject but owns no active org (pending, rejected or released). See services/auth/actor.',
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
  NAME_INVALID_CHARACTERS: {
    code: 'NAME_INVALID_CHARACTERS',
    status: 400,
    title: 'Name has symbols we cannot accept',
    detail: 'Please remove symbols such as ( ) < > & / # from the name and try again.',
    hint: 'Keycloak refused the first or last name (error-person-name-invalid-character).',
  },
  USER_EXISTS: {
    code: 'USER_EXISTS',
    status: 409,
    title: 'Email already in use',
    detail:
      'This email is already registered. Please use a different email, or sign in if it’s yours.',
    hint: 'Pre-check at idp.findByEmail returned non-null. Stale or duplicate KC user.',
  },
  PHONE_EXISTS: {
    code: 'PHONE_EXISTS',
    status: 409,
    title: 'Phone already in use',
    detail:
      'This mobile number is already registered. Please use a different number, or sign in if it’s yours.',
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
  // One code per reason so the form can say what to change. The handler sets `detail` to the limit or filename.
  ATTACHMENT_COUNT_EXCEEDED: {
    code: 'ATTACHMENT_COUNT_EXCEEDED',
    status: 400,
    title: 'Too many attachments',
    detail: 'Too many files were attached to this submission.',
    hint: 'Limit set by SUPPORT_ATTACHMENT_MAX_FILES.',
  },
  ATTACHMENT_TOO_LARGE: {
    code: 'ATTACHMENT_TOO_LARGE',
    status: 400,
    title: 'Attachments too large',
    detail: 'The attachments exceed the size allowed for one submission.',
    hint: 'Budget set by SUPPORT_ATTACHMENT_MAX_TOTAL_BYTES; the route body limit is derived from it.',
  },
  PAYLOAD_TOO_LARGE: {
    code: 'PAYLOAD_TOO_LARGE',
    status: 413,
    title: 'Request too large',
    detail: 'The request body is larger than this endpoint accepts.',
    hint: "Fastify's bodyLimit rejected the body before any handler ran; on /v1/support the limit is derived from SUPPORT_ATTACHMENT_MAX_TOTAL_BYTES.",
  },
  ATTACHMENT_INVALID_ENCODING: {
    code: 'ATTACHMENT_INVALID_ENCODING',
    status: 400,
    title: 'Attachment could not be read',
    detail: 'One of the attached files was not valid base64.',
    hint: "Buffer.from(x, 'base64') ignores characters outside the alphabet, so an unvalidated payload would be mailed as a corrupt file. Checked in services/support-attachments.ts.",
  },
  ATTACHMENT_TYPE_NOT_ALLOWED: {
    code: 'ATTACHMENT_TYPE_NOT_ALLOWED',
    status: 400,
    title: 'Attachment type not accepted',
    detail: 'One of the attached files is not an accepted type.',
    hint: 'Allowlist lives in services/support-attachments.ts. It matches the client-declared contentType, so it filters honest mistakes rather than a renamed file — the mailbox must still scan attachments.',
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

  ALREADY_DECIDED: {
    code: 'ALREADY_DECIDED',
    status: 409,
    title: 'Already decided',
    detail: 'This registration has already been approved or rejected.',
    hint: 'Decision compare-and-set lost (decided by an emailed link or another console session). `fields` carries status, decided_at, decided_by.',
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
    hint: "Coordinator submit matched an org owner's email (the owner's admin account contact; spec A4). Owner→coordinator graduation is deferred.",
  },
  ORG_SLUG_TAKEN: {
    code: 'ORG_SLUG_TAKEN',
    status: 409,
    title: 'Organisation name unavailable',
    detail:
      'An organisation with a matching name is already registered or pending. Try a different name.',
    hint: 'organisations partial-unique slug collision over non-terminal rows (spec A9).',
  },
  ORG_NAME_TAKEN: {
    code: 'ORG_NAME_TAKEN',
    status: 409,
    title: 'Organisation name unavailable',
    detail:
      'An organisation with this name is already registered or pending. Please choose a different name.',
    hint: 'organisations partial-unique name (case-insensitive) collision over non-terminal aggregator orgs.',
  },
  ORG_DEPTH_LIMIT: {
    code: 'ORG_DEPTH_LIMIT',
    status: 409,
    title: 'Too many levels',
    detail: 'The organisation cannot be placed this deep. Choose a parent higher in the tree.',
    hint: 'Store DEPTH_LIMIT: parent depth + 1 (+ subtree height on a move) exceeds organisation.hierarchy.max_depth.',
  },
  ORG_CHILD_LIMIT: {
    code: 'ORG_CHILD_LIMIT',
    status: 409,
    title: 'Parent organisation is full',
    detail:
      'The selected parent organisation cannot take more organisations. Choose another parent.',
    hint: 'Store CHILD_LIMIT: pending + active children of the parent (Default excluded) reached organisation.hierarchy.max_children.',
  },
  ORG_TOTAL_LIMIT: {
    code: 'ORG_TOTAL_LIMIT',
    status: 409,
    title: 'Registration closed',
    detail: 'This network is not accepting new organisations right now.',
    hint: 'Store TOTAL_LIMIT: pending + active aggregator orgs (root and Default excluded) reached organisation.hierarchy.max_total_orgs.',
  },
  ORG_PARENT_CYCLE: {
    code: 'ORG_PARENT_CYCLE',
    status: 400,
    title: 'Invalid parent',
    detail: 'An organisation cannot be moved under itself or an organisation below it.',
    hint: 'Store PARENT_CYCLE: the requested parent is the org or one of its descendants.',
  },
  REGISTRATION_COOLING: {
    code: 'REGISTRATION_COOLING',
    status: 409,
    title: 'Please try again later',
    detail:
      'A recent registration with these details was declined. You can register again after the cooling period.',
    hint: 'A rejected record for this email/phone/owner_email exists and now - rejected_at < REGISTRATION_COOLING_MINUTES. See response.error.fields.retry_after for the ISO timestamp.',
  },
  TARGET_ORG_INACTIVE: {
    code: 'TARGET_ORG_INACTIVE',
    status: 409,
    title: 'Organisation unavailable',
    detail:
      'The selected organisation is not accepting coordinators. Contact the organisation owner.',
    hint: 'Coordinator submit/approval against an org whose status != active (spec §6.2 re-validate).',
  },

  ORG_DETAILS_READ_ONLY: {
    code: 'ORG_DETAILS_READ_ONLY',
    status: 409,
    title: 'Organisation details are read-only here',
    detail:
      "url, locations, company and GST number belong to the coordinator's organisation and cannot be changed from the coordinator profile.",
    hint: 'Profile PATCH carried an org-detail field (migration 0028); the org owner edits them. `fields.fields` lists the offending keys.',
  },

  // ── Coordinator invites ──────────────────────────────────────────────────
  INVITE_INVALID: {
    code: 'INVITE_INVALID',
    status: 400,
    title: 'Invalid invite',
    detail: 'This invitation link is not valid. Ask your organisation owner for a fresh invite.',
    hint: 'invite-token signature/audience/claims/role verify failed, or the invite row is missing.',
  },
  INVITE_EXPIRED: {
    code: 'INVITE_EXPIRED',
    status: 410,
    title: 'Invite expired',
    detail: 'This invitation has expired. Ask your organisation owner to send a fresh invite.',
    hint: 'invite-token exp elapsed (INVITE_TOKEN_TTL_SECONDS). Recovery is the owner re-mint path (§6).',
  },
  INVITE_ALREADY_USED: {
    code: 'INVITE_ALREADY_USED',
    status: 409,
    title: 'Invite already used',
    detail: 'This invitation has already been used. If you already registered, sign in instead.',
    hint: 'Invite row not pending (consumed/revoked/expired) or the pending→consumed CAS lost a race (§4.4.6).',
  },
  GRANT_INVALID: {
    code: 'GRANT_INVALID',
    status: 400,
    title: 'Invalid link',
    detail: 'This invite-management link is not valid. Use the link from your approval email.',
    hint: 'grant-token signature/audience/sub verify failed (aggregator-grant).',
  },
  GRANT_EXPIRED: {
    code: 'GRANT_EXPIRED',
    status: 410,
    title: 'Link expired',
    detail: 'This invite-management link has expired. Request a fresh link to continue.',
    hint: 'grant-token exp elapsed (GRANT_TOKEN_TTL_SECONDS). Recovery re-mails a fresh grant to the registered owner (§6).',
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
    hint: 'Create body referenced a mode key not present in aggregator.config.yaml registration_modes, or one this deployment withholds via AGGREGATOR_ONBOARDING_ENABLED. Surface the declared keys via fields.declared and the usable subset via fields.enabled.',
  },
  INVALID_CONFIG: {
    code: 'INVALID_CONFIG',
    status: 400,
    title: 'Invalid configuration',
    detail: 'The combination of fields supplied is not allowed by the API.',
    hint: 'A field combination violates a business invariant (e.g. profile fields on an account_only link). Inspect detail for the specific rule.',
  },
  RBAC_NOT_ENABLED: {
    code: 'RBAC_NOT_ENABLED',
    status: 503,
    title: 'Access control is off',
    detail: 'Access control is not enabled on this instance, so roles cannot be changed.',
    hint: 'RBAC_MODE=off: the role catalogue is not loaded. Set RBAC_MODE=log or enforce (docs/rbac/).',
  },
  ROLE_UNKNOWN: {
    code: 'ROLE_UNKNOWN',
    status: 400,
    title: 'Unknown role',
    detail: 'That role does not exist on this instance.',
    hint: 'role_key is not a key of the role table (built-in roles are seeded by migration 0031).',
  },
  ROLE_EXISTS: {
    code: 'ROLE_EXISTS',
    status: 409,
    title: 'Role already exists',
    detail: 'A role with that key already exists.',
    hint: 'Role keys are unique across built-in and custom roles.',
  },
  ROLE_BUILTIN: {
    code: 'ROLE_BUILTIN',
    status: 409,
    title: 'Built-in role',
    detail: 'Built-in roles cannot be changed or deleted here.',
    hint: 'Built-in roles are seeded by migration 0031 and changed by a new migration; create a custom role instead.',
  },
  ROLE_IN_USE: {
    code: 'ROLE_IN_USE',
    status: 409,
    title: 'Role in use',
    detail: 'This role is assigned to someone, so it cannot be deleted.',
    hint: 'Revoke its live assignments first.',
  },
  ROLE_LIMIT_REACHED: {
    code: 'ROLE_LIMIT_REACHED',
    status: 409,
    title: 'Too many custom roles',
    detail: 'This instance already has the most custom roles allowed.',
    hint: 'MAX_CUSTOM_ROLES (50); delete an unused custom role first.',
  },
  ROLE_INVALID: {
    code: 'ROLE_INVALID',
    status: 400,
    title: 'Invalid role',
    detail: 'The role breaks a role rule.',
    hint: 'See fields.issues; rules: docs/rbac/rbac-permissions-and-roles.md §4.',
  },
  ROLE_ASSIGNMENT_NOT_ALLOWED: {
    code: 'ROLE_ASSIGNMENT_NOT_ALLOWED',
    status: 409,
    title: 'Role cannot be assigned',
    detail: 'This role cannot be given to this user in this organisation.',
    hint: 'A role rule refused it; see fields.reason (base_role, not_member, self, account_type, org_type, days_exceed_max). Rules: docs/rbac/rbac-permissions-and-roles.md §4.',
  },
} as const satisfies Record<string, ErrorCatalogueEntry>;

export type ErrorCode = keyof typeof ERR;
