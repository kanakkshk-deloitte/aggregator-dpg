# Aggregator DPG — Technical Specification

**Status:** Draft v0.1 (product spec) — implementation has moved ahead of parts of this document; see **Implementation status** below.
**Source PRD:** `docs/Aggregator Product Note.pdf` (Draft 2)
**Scope:** MVP (V1 beta)
**Last updated:** 2026-07-09

> **Setting up locally?** See [`SETUP.md`](SETUP.md) for the end-to-end quickstart (prereqs → docker compose → KC mappers → run apps → smoke test).
>
> **Working in the code?** [`CLAUDE.md`](CLAUDE.md) is the authoritative operational reference (apps, packages, commands, env, architecture). This README is the original PRD-derived spec and is kept for product context.

---

## Implementation status

This document was written before build and remains the product-intent spec. Where the code now differs, the code (and `CLAUDE.md` / `SETUP.md`) is authoritative. Key deltas as of 2026-07-09:

- **Stack** — the API/BFF is **Fastify** (not "Express or Fastify"); the portal is **Next.js 15 (App Router)**; a **BullMQ worker** runs bulk-upload processing; storage is **Postgres + Drizzle** + S3 + Redis. It is a **pnpm + Turbo** monorepo (`apps/api`, `apps/web`, `apps/worker`, `packages/*`).
- **Identity & auth** — authentication is **Keycloak** (realm `aggregator`, OIDC Authorization-Code + PKCE) with a custom **email/phone OTP** authenticator SPI, not a bespoke local JWT service. Portal sessions are Redis-backed signed cookies. `aggregator_id` is still asserted server-side on every request and never trusted from the client.
- **Registration & approval** — approval is an **in-app, token-based email flow** (signed approval-token link → approver page → atomic compare-and-set on the row → Keycloak user enable + role assignment), with expired-link regeneration, resubmit-reclaim of a pending/rejected registration, and a service-auth endpoint that prunes stale pending registrations. It is no longer a purely manual/external process (§4.1 / §6.1).
- **Org → coordinator hierarchy** — an optional parent-organisation → coordinator hierarchy sits behind the per-instance **`ORG_HIERARCHY_ENABLED`** flag (default off = the flat flow described here). When on, a parent org registers/approves separately (system-of-record `aggregator_orgs` table + mirrored Keycloak group + `org_owner` realm role), and each coordinator is bound to an active org (`aggregators.parent_org_id`).
- **Consent** — registration now **captures consent** (§7.3): a required consent checkbox + read-only Terms/Privacy popup on both registration forms, with document text managed as versioned config-as-code (`config/**/consent.json`, per `org` / `aggregator` audience) and every acceptance written to an append-only `aggregator_consent_record` ledger (fail-closed — no subject is provisioned without a consent row).
- **Profile is a read-only registration form** — the `/profile` page renders the **same** `registration.v1` schema as the public registration page (single source via `apps/web/src/lib/aggregator-schema.server.ts`), populated and fully disabled — not the edit-in-place form described in §4.2. Changes are raised through a **"Request an update"** panel that lists the schema-flagged (`x-updatable`) fields; the admin-approval flow behind the submit is a stub (backend tracked separately), so it only acknowledges "coming soon" today.
- **Contact support** — an authenticated coordinator can send a support message from the portal (Sidebar → "Contact support"). The BFF forwards to the API's `POST /v1/support`, which emails the submission via the aggregator's own mailer (`getMailer()`) with **Reply-To set to the submitting coordinator**. The feature is gated by the per-instance **`SUPPORT_EMAIL`** env: when unset, `GET /v1/support/config` reports `enabled: false`, the Sidebar entry is hidden, and `POST /v1/support` returns `503 SUPPORT_NOT_CONFIGURED` (a failed send is `502 SUPPORT_SEND_FAILED`).
- **Consent-gated bulk onboarding** — bulk-uploaded accounts are not discoverable until the participant consents at first contact; the upload success message reflects this: _"Accounts will be live once the user logs in on the platform or via the call."_
- **Not yet built** — the standalone **Signal Processing Service** (§2.3, §5.2) is not implemented; derived/dashboard metrics are served by the API reading upstream. Treat §5.2 and the two-service diagram as target architecture, not current state.

---

## 1. Purpose and Scope

This document translates the Aggregator Product Note (Draft 2) into an engineering specification for the Aggregator platform within the Blue Dot ecosystem. It covers the Aggregator-facing web application, the Signal Processing Service that feeds it, and the integrations with the upstream Signals Stack (UBI backend) and the existing Jobs Stack.

**In scope for MVP** — the JTBDs marked `MVP = Yes` in the PRD:

| ID    | Job                                                           |
| ----- | ------------------------------------------------------------- |
| AG-0  | Register as an Aggregator (external approval flow)            |
| AG-0b | Access the participant dashboard after login                  |
| AG-0c | Update organisational profile                                 |
| AG-1  | Onboard participants via links/QR and track who joined        |
| AG-1a | Track conversion per onboarding mode                          |
| AG-1b | Act on flagged incomplete profiles                            |
| AG-1c | Bulk-onboard participants                                     |
| AG-2  | See connection activity per participant; prioritise follow-up |
| AG-6  | Share an aggregated summary with Ecosystem Manager / funder   |

**Out of scope for MVP** (tracked for later phases): AG-0a (self-service registration status tracking inside the app), AG-3/AG-4 (in-app connection notifications and direct outreach), AG-5 (Aggregator-of-Aggregators view), AG-7/AG-8 (natural-language queries and ad-hoc report generation), and the eight items in the PRD's Future Scope list (write-back of profile contact changes, unstructured bulk upload, credential issuance on bulk create, voice-call onboarding, lifecycle management, RBAC tiers).

---

## 2. System Context

### 2.1 Actors

- **Aggregator admin** — a single user per Aggregator org in MVP. Authenticates via email/phone + OTP. Operates all four app areas.
- **Ecosystem admin (external)** — handles Aggregator approval outside the platform (email + manual org creation in the Signals Stack). No UI in MVP.
- **Participant (seeker / provider)** — does not log in to the Aggregator platform. Registers into the Signals Stack via links, QR codes, or bulk upload attributed to an Aggregator.

### 2.2 External systems

| System                      | Role                                                                                    | API reference                                        |
| --------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Signals Stack (UBI backend) | Source of truth for orgs, members, seeker profiles, registration-mode attribution       | https://ubi-backend.onest.dhiway.net/api/reference/  |
| Jobs Stack                  | Source of truth for job postings and applications (provider-side + seeker applications) | https://jobs-demo.onest.dhiway.net/api/v1/reference/ |
| Ecosystem Manager platform  | Future consumer of the Signal Processing Service                                        | —                                                    |

Per the PRD: **the Aggregator platform has no write access to the Signals Stack in MVP.** All transactional writes (registrations, applications) originate upstream. The Aggregator app is a read-and-display surface plus outbound orchestration (generating onboarding links, running bulk uploads that hit upstream APIs, exporting reports).

> **Assumption to confirm with the Signals Stack team:** Source-mode attribution at participant registration (bulk / QR / link) must be recordable in the `member` table. The PRD explicitly calls this out as a dependency. If unsupported, mode-wise counts (AG-1a) cannot be delivered as specified.

### 2.3 High-level architecture

```
┌─────────────────────────┐       ┌───────────────────────────┐
│ Aggregator Web App      │◀──────│ Aggregator API (BFF)      │
│ (Next.js / React)       │       │ (Node.js/TypeScript)      │
└─────────────────────────┘       └─────────────┬─────────────┘
                                                │
                     ┌──────────────────────────┼──────────────────────┐
                     ▼                          ▼                      ▼
        ┌────────────────────────┐   ┌────────────────────────┐   ┌──────────────────┐
        │ Signal Processing Svc  │   │ Signals Stack (UBI)    │   │ Jobs Stack       │
        │ (derived signals)      │   │ orgs/members/profiles  │   │ postings/applns  │
        └───────────┬────────────┘   └────────────────────────┘   └──────────────────┘
                    │                              ▲                        ▲
                    └──────────────────────────────┴────────────────────────┘
                           reads raw events, filters by aggregator_id
```

The **Signal Processing Service** is an independent computation layer. All derived fields (profile completion %, status labels, application counts, age buckets, mode-wise registration counts) are produced there, not in the Aggregator app. This is a hard boundary from the PRD — downstream consumers (Ecosystem Manager platform later) must not replicate this logic.

---

## 3. Domain Model

### 3.1 Entities (logical)

| Entity                    | Source                                                     | Key fields used by Aggregator                                                                             |
| ------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `aggregator_org`          | Signals Stack `organisation` (filtered to aggregator type) | `organisation_id`, `name`, aggregator type, address, contact admin, verified flag                         |
| `member`                  | Signals Stack `member`                                     | `user_id`, `organisation_id` (links seeker to aggregator), `registration_source_mode`                     |
| `profile` (seeker)        | Signals Stack `profile`                                    | `profile_id`, `user_id`, `metadata`, `created_at`                                                         |
| `organisation` (provider) | Signals Stack `organisation` (filtered to provider type)   | `organisation_id`, `name`, `registration_source_mode`                                                     |
| `job_posting`             | Jobs Stack                                                 | `organization_id`, `created_at`, `metadata.positions`                                                     |
| `job_application`         | Jobs Stack                                                 | `user_id`, `application_status` (open / shortlisted / rejected), `updated_at`                             |
| `aggregator_schema_form`  | Aggregator DB                                              | Schema-driven profile form (Who I Am / What I Have / What I Want)                                         |
| `onboarding_link`         | Aggregator DB                                              | `link_id`, `aggregator_id`, `mode` (link/qr), `target_role` (seeker/provider), `created_at`, `join_count` |
| `bulk_upload_batch`       | Aggregator DB                                              | `batch_id`, `aggregator_id`, `filename`, `total`, `succeeded`, `flagged`, `created_at`                    |

### 3.2 Derived signals (computed in Signal Processing Service)

Per PRD Flow 3 and the field mapping tables:

**Per-participant (seeker):**

- `profile_age` = `today − profile.created_at`
- `last_applied_age` = `today − MAX(job_application.updated_at WHERE application_status IN (shortlisted, rejected))` per `user_id`
- `profile_completion_pct` = filled required fields ÷ total required fields (averaged across all `profile_id`s per `user_id`)
- `application_count`, `shortlisted_count`, `rejected_count`, `pending_count` (open) per `user_id`
- `profile_status` ∈ {Complete (≥ 75%), Incomplete (< 75%)}
- `seeker_status` ∈ {New, Active, At Risk, Inactive} per PRD rules:
  - New: `profile_age ≤ 7`
  - Active: `last_applied_age ≤ 30`
  - At Risk: `profile_age > 7 AND 31 ≤ last_applied_age ≤ 90`
  - Inactive: `profile_age > 7 AND (last_applied_age > 90 OR 0)`

**Per-participant (provider):**

- `job_post_age`, `shortlisted_age`, `rejected_age` per `organization_id`
- `openings` = Σ `job_posting.metadata.positions`
- `shortlisted_count`, `rejected_count` across all jobs per `organization_id`
- `provider_status` ∈ {New, Satisfied, Active, At Risk, Inactive} per the compound rules in the PRD (§ "My Blue Dots" bullets).

**Per-aggregator:**

- Total seekers (unique `user_id`s under the aggregator)
- Average profile completion across user_ids
- Seekers with ≥ 1 application, and average applications per seeker
- New seekers in last 7 days
- Mode-wise registration counts (bulk / QR / link) — seeker-side and provider-side
- Follow-up label — derived flag where `seeker_status`/`provider_status` is At Risk / Inactive or `profile_status = Incomplete`

These feed the "aggregate network summary" cards and the per-participant list on **My Blue Dots**.

### 3.3 Schema-driven profile

The Aggregator profile form (AG-0c) is **configurable** per the Profile schema in the PRD (Who I Am / What I Want / What I Have framework, with `Required`, `Type`, and `Options/Allowed Values` columns). The app renders fields dynamically from this schema; the schema is stored in the Aggregator DB as versioned JSON and is the single source of truth for form rendering and completion-percentage calculation.

---

## 4. User-facing surfaces

Four areas, matching PRD § 4:

### 4.1 Registration (pre-login)

- **New member request** — short form (org name, aggregator type, admin name, email, phone) + T&Cs + consent checkbox. On submit, POSTs to Aggregator API, which emails the dedicated admin address. Approval is manual/external; the admin creates the org entry in the Signals Stack. An approval confirmation email is sent to the requester.
- **Existing member login** — email-or-phone + OTP. On OTP verify, the Aggregator API looks up the org in the Signals Stack by email/phone, issues a session JWT.

### 4.2 Profile

- **As built (supersedes the edit-in-place intent below):** the page renders the shared `registration.v1` schema **read-only** (same form as `/register`, every field disabled). Edits are not made in place — they are raised through a "Request an update" panel over the `x-updatable` fields; the approval flow behind the submit is a stub today. See **Implementation status**.
- _Original intent:_ dynamic form rendered from the Aggregator profile schema, edit-in-place, save writes to the Aggregator DB. A "Verified" badge is shown when the upstream org carries the verified flag.
- **MVP constraint:** updates to org contact details (email/phone) do _not_ write back to the Signals Stack org entry. This is deferred to Future Scope item 2.

### 4.3 Onboard

- **Overall health** card — total registered / verified / discoverable (from Signal Processing Service).
- **Bulk upload** — upload CSV against a seeker or provider template; Aggregator API validates rows, calls Signals Stack bulk-create endpoints, records a `bulk_upload_batch` row, shows per-row success/flag status. Bulk-created accounts are consent-gated: the success message tells the coordinator that "Accounts will be live once the user logs in on the platform or via the call" (discoverability is unlocked only after the participant consents at first contact).
- **Link & QR generation** — Aggregator fills required fields (role, campaign label), system generates a signed link and QR image. Link carries `aggregator_id` and `mode` as query params; target registration page records the source mode. Join count per link is pulled from Signal Processing Service (mode-wise counts filtered by `link_id`, assuming the Signals Stack supports `link_id` attribution; see open item in § 8.1).
- **Flagged profiles** — list of profiles with `profile_completion_pct < threshold` or format errors from the most recent bulk upload. Action = trigger a follow-up (logged as intent in MVP; actual outreach is out of scope).

### 4.4 My Blue Dots

- **Aggregate summary cards** — status counts (New / Active / At Risk / Inactive for seekers; New / Satisfied / Active / At Risk / Inactive for providers), participation metrics, new-in-last-7-days.
- **Participant list** — paginated, searchable by name, filterable by status. Each row: name, date of joining, profile completion, application status counts (applied / shortlisted / rejected / pending), computed status, recommended follow-up.
- **Detail drawer** — read-only participant detail from Signal Processing Service output.
- **CSV export** — export of the current filtered list for offline follow-up and reporting.

For AG-6 (reporting), the summary view itself is the report in MVP; the export feeds stakeholder sharing.

---

## 5. Backend services

### 5.1 Aggregator API (BFF)

Node.js + TypeScript, **Fastify** (as built). Stateless, deployed behind the platform's ingress. Responsibilities:

- Session and OTP (integrates with existing Signals Stack auth if available; otherwise issues JWTs locally against email/phone verified via OTP provider).
- Orchestrates reads from Signal Processing Service + Signals Stack + Jobs Stack and shapes them for the UI.
- Owns Aggregator-only writes: schema versions, onboarding links, bulk upload batches, export jobs.
- Enforces aggregator-scope on every request (`aggregator_id` is derived from the session; never accepted from the client).

#### Endpoint sketch (REST, all JSON)

| Method    | Path                             | Purpose                                           |
| --------- | -------------------------------- | ------------------------------------------------- |
| POST      | `/v1/auth/otp/request`           | Request OTP to email/phone                        |
| POST      | `/v1/auth/otp/verify`            | Exchange OTP for session JWT                      |
| POST      | `/v1/registration-requests`      | Submit new-aggregator request (pre-login)         |
| GET       | `/v1/me`                         | Current aggregator org + verified flag            |
| GET       | `/v1/profile/schema`             | Current profile schema (versioned)                |
| GET/PATCH | `/v1/profile`                    | Read/update aggregator profile                    |
| GET       | `/v1/onboard/summary`            | Registered / verified / discoverable counts       |
| POST      | `/v1/onboard/links`              | Create onboarding link (returns URL + QR payload) |
| GET       | `/v1/onboard/links`              | List links with join counts per mode              |
| POST      | `/v1/onboard/bulk-uploads`       | Multipart CSV upload; returns batch id            |
| GET       | `/v1/onboard/bulk-uploads/:id`   | Batch status + per-row outcomes                   |
| GET       | `/v1/onboard/flagged-profiles`   | Incomplete/flagged profile list                   |
| GET       | `/v1/blue-dots/summary`          | Aggregate status + participation metrics          |
| GET       | `/v1/blue-dots/participants`     | Paginated participant list with filters & search  |
| GET       | `/v1/blue-dots/participants/:id` | Participant detail                                |
| GET       | `/v1/blue-dots/export`           | CSV export of current filter                      |

Every listing endpoint accepts `aggregator_id` implicitly from the session and applies it as a hard filter at query time.

### 5.2 Signal Processing Service

Separate service per PRD out of scope in current implementation. Responsibilities:

- Ingests raw events from Signals Stack and Jobs Stack (timestamps, application events, profile fields, registration mode).
- Computes all derived signals listed in § 3.2.
- Exposes a read API scoped by `aggregator_id` (and, where relevant, `user_id` / `organization_id`).
- Serves multiple consumer platforms (Aggregator today, Ecosystem Manager tomorrow). **No consumer re-implements computation.**

**Implementation options** (to decide; see § 10):

- **Option A — Pull/materialised:** a scheduled job (e.g., every N minutes) materialises per-aggregator aggregates and per-participant rows into a read-optimised store (Postgres materialised views, or a columnar store). Read API serves from the materialised tables. Simpler; bounded freshness.
- **Option B — Stream/on-demand:** consume change events from the Signals Stack and Jobs Stack via a message bus, update signals online. Fresher; more infrastructure.

MVP recommendation: **Option A with a 5–15 minute refresh cadence.** The PRD's status labels use day-scale thresholds; minute-scale staleness is acceptable. Revisit as the Ecosystem Manager platform comes online.

#### Endpoint sketch

| Method | Path                                       | Purpose                                                             |
| ------ | ------------------------------------------ | ------------------------------------------------------------------- |
| GET    | `/v1/aggregators/:id/onboard-summary`      | Totals by mode, flagged counts                                      |
| GET    | `/v1/aggregators/:id/participants`         | Rows with all computed columns; supports pagination, filter, search |
| GET    | `/v1/aggregators/:id/participants/:userId` | Detail row                                                          |
| GET    | `/v1/aggregators/:id/blue-dots-summary`    | Status-bucket counts + participation metrics                        |

### 5.3 Aggregator DB

Single logical database, owned by the Aggregator API. Suggested tables:

```
aggregator_profile_schema      (id, version, schema_json, active, created_at)
aggregator_profile             (aggregator_id PK, schema_version, values_json, updated_at)
onboarding_link                (id PK, aggregator_id, mode, target_role, label, created_at, expires_at, revoked_at)
bulk_upload_batch              (id PK, aggregator_id, filename, total, succeeded, flagged, created_at, created_by)
bulk_upload_row                (id PK, batch_id FK, row_number, raw_row_json, outcome, error_code, error_message)
registration_request           (id PK, org_name, aggregator_type, admin_name, email, phone, consent_at, status, created_at)
export_job                     (id PK, aggregator_id, filter_json, status, file_url, created_at)
audit_log                      (id PK, aggregator_id, user_id, action, entity, entity_id, payload_json, at)
```

Recommended store: **PostgreSQL**. Indexes on `(aggregator_id, created_at)` for list endpoints; partial indexes on active schemas and non-revoked links.

### 5.4 Frontend

- **Framework:** Next.js (React + TypeScript). Server components for data-heavy list views, client components for the schema-driven form.
- **UI library:** pick one; not specified in PRD. Recommend a design-system-grade library (e.g., Radix + Tailwind, or MUI) for form controls and tables.
- **State:** server-driven; TanStack Query for cache. No client-side derivation of status labels — the UI renders whatever the API returns.
- **QR rendering:** client-side from a data URI returned by the API, or a QR image URL.
- **Charts (summary cards):** lightweight (Recharts or similar).

---

## 6. Key flows (implementation view)

Diagrams in the PRD (Flows 1–4) are authoritative. Implementation notes:

### 6.1 Registration (Flow 1)

1. Browser → `POST /v1/registration-requests` with consent payload.
2. API persists `registration_request` (status = `pending`), sends email to admin alias.
3. External approval: admin creates org entry in Signals Stack (org name, admin name, phone, email).
4. External system sends confirmation email to requester.
5. Requester logs in via OTP; API resolves `aggregator_id` by email/phone against Signals Stack.

### 6.2 Onboarding — link/QR (Flow 2)

1. Aggregator creates link via API → receives `link_url` + QR data URI.
2. Participant opens `link_url` → lands on Signals Stack registration page (UBI), which records `aggregator_id` and `mode=link|qr` on the new `member` row.
3. Signal Processing Service attributes the registration to the source mode and updates mode-wise counts.
4. Aggregator's Onboard view pulls counts from the service.

### 6.3 Bulk upload

1. Aggregator uploads CSV → API validates against template schema (seeker or provider).
2. For each valid row, API calls the Signals Stack bulk-create endpoint; failures are recorded with `error_code`.
3. `bulk_upload_batch` and `bulk_upload_row` rows persisted; summary shown immediately on completion.
4. Profile-completeness flags surface later via the Signal Processing Service (because completion % is a computed signal).

### 6.4 My Blue Dots list

1. API calls Signal Processing Service `/participants` endpoint with the aggregator's id, filters, and pagination.
2. Response includes all computed columns (status, counts, ages) — no client-side computation.
3. Participant detail uses the same service's `/participants/:userId` endpoint.

### 6.5 Export

1. Aggregator triggers export with current filter.
2. API creates `export_job`, computes CSV from the Signal Processing Service stream, stores to object storage, returns a signed URL.
3. Done synchronously for small result sets (< 10k rows); async for larger.

---

## 7. Cross-cutting

### 7.1 Authentication and session

- Email-or-phone + OTP for login. OTP provider is a pluggable integration (same as Signals Stack's, ideally).
- Session = short-lived JWT (15 min access) + refresh token (7 days, rotating). Tokens bound to `aggregator_id`.
- Every API handler asserts: `session.aggregator_id === requested_aggregator_id` (or infers from session). No client-supplied `aggregator_id` is trusted.

### 7.2 Authorisation

- MVP has a single portal role: the aggregator/coordinator admin. All four areas accessible.
- A parent-org tier now exists behind `ORG_HIERARCHY_ENABLED` (see **Implementation status**): an `org_owner` Keycloak realm role approves the coordinators bound to that org. Broader RBAC tiers (admin / super-admin) remain Future Scope item 8.

### 7.3 DPDP and consent

> **Implemented:** registration now captures consent. Both registration forms carry a required consent checkbox plus a read-only Terms/Privacy popup; the document text is versioned config-as-code (`config/**/consent.json`, per `org` / `aggregator` audience) and every acceptance is written to an append-only `aggregator_consent_record` ledger (subject, network/brand, terms/privacy version, timestamp). The write is fail-closed — a subject is never provisioned without a consent record. The two items below remain open policy questions.

Two open items from the PRD:

1. **Consent scope for Signal Processing Service** — participant consent at registration must cover processing by a centralised shared service consumed by multiple downstream platforms. Retention periods and minimisation rules are pending legal review.
2. **PII access for follow-ups** — legal basis for Aggregator/Ecosystem Manager access to participant PII (name, phone, email) for outreach on stalled connections / incomplete profiles is not yet established.

Engineering controls required regardless of how these resolve:

- The Signal Processing Service must expose aggregated computations _without_ returning raw PII where not needed (e.g., summary endpoints).
- The participant-detail endpoint — which does return PII — must be gated by a separate policy check and fully audit-logged (who, when, which participant, which fields).
- Export jobs must log the filter and the viewer.
- Retention: configurable, with a default that errs short until legal finalises.

### 7.4 Observability

- Structured logs with `request_id`, `aggregator_id`, `user_id` (admin), `route`, `latency_ms`, `status`.
- Metrics: per-endpoint latency (p50/p95/p99), error rate, Signal Processing Service cache-hit ratio, bulk upload success rate.
- Alerting: upstream 5xx rate from Signals Stack/Jobs Stack, Signal Processing Service refresh failures, OTP delivery failures.

### 7.5 Performance targets (proposed; confirm with stakeholders)

| Surface                                         | Target                                                 |
| ----------------------------------------------- | ------------------------------------------------------ |
| Dashboard load (Blue Dots summary + first page) | < 2.0 s at p95 for aggregators with ≤ 10k participants |
| Participant list page (50 rows)                 | < 800 ms at p95                                        |
| Bulk upload of 1,000 rows                       | < 60 s end-to-end; async above that                    |
| Export of 10k rows                              | < 30 s synchronous; async above                        |
| Signal Processing Service freshness             | ≤ 15 minutes                                           |

### 7.6 Security

- TLS-only; HSTS on.
- CSRF protection on state-changing endpoints if cookies are used; otherwise bearer-only.
- Rate limits on OTP request/verify and registration-request submission.
- CSV upload: virus scan, MIME and size limits, streaming parse.
- Signed URLs (short TTL) for export downloads.

### 7.7 Internationalisation and accessibility

- Content in English for MVP; copy externalised via i18n so Hindi and regional languages can be added without code changes (consistent with the PRD examples spanning PwD / Farming / Welfare / MSME use cases).
- UI meets WCAG 2.1 AA — keyboard-navigable, screen-reader labels on all form fields in the dynamic profile form, contrast ≥ 4.5:1.

#### i18n implementation (`apps/web`)

**Library:** [next-intl](https://next-intl-docs.vercel.app/). Locale selection is cookie-based (`NEXT_LOCALE` cookie); no locale-prefixed URLs (e.g. `/en/dashboard`).

**Message catalogs:** `apps/web/src/i18n/messages/<code>.json` — one file per locale. `en.json` is the canonical source of truth. `kn.json` and `hi.json` must mirror the full key tree; a parity test in the web package enforces this.

**Runtime language switcher:** controlled by the `NEXT_PUBLIC_ENABLED_LANGUAGES` env var (comma-separated locale codes, e.g. `en,kn,hi`). Only codes listed here appear in the UI switcher; `en` is always included as the fallback. If the var is unset all supported locales are shown.

**Adding a new language:**

1. Add `apps/web/src/i18n/messages/<code>.json` with every key present in `en.json`.
2. Add the locale code to `SUPPORTED_LOCALES` and a display name to `LOCALE_NAMES` in `apps/web/src/i18n/config.ts`.
3. Include the code in `NEXT_PUBLIC_ENABLED_LANGUAGES` in your `.env` (dev) or as a Docker build arg (prod — see Docker section below).

**Scope:** UI chrome only (navigation, labels, headings, status text). RJSF form field labels, API response strings, and transactional emails are **not** localised.

**Docker / production note:** `NEXT_PUBLIC_ENABLED_LANGUAGES` is baked into the client bundle at `next build` time, not at runtime. When building the `web` Docker image you must pass it as a build arg:

```bash
docker build \
  --build-arg NEXT_PUBLIC_ENABLED_LANGUAGES=en,kn,hi \
  -f apps/web/Dockerfile .
```

With `docker compose` the value flows automatically from `.env` via the `build.args` entry in `docker-compose.yml`; override it in `.env` before running `make up` or `docker compose up -d --build`.

---

## 8. Open items and assumptions

### 8.1 Carried over from the PRD

1. **DPDP consent scope for the Signal Processing Service** — blocks finalising data contracts and retention.
2. **PII access legal basis for follow-ups** — affects how participant detail and export are gated.
3. **Mode-wise registration attribution** — depends on the Signals Stack recording source mode per registration. Needs confirmation with that team.
4. **Signal Processing Service placement** — stated in the PRD as possibly becoming a microservice within the Signals Stack. Assume standalone for MVP; architect the API contract so placement can change without consumer changes.

### 8.2 Raised by this document

5. **OTP provider** — reuse the Signals Stack's provider vs. integrate our own. Cost and operational coupling trade-off.
6. **Compute model (Option A vs B in § 5.2)** — recommendation is A; needs sign-off.
7. **Profile-completion threshold** — PRD uses ≥ 75% for "Complete" in one place. Confirm and make configurable if it will vary by use case (PwD, Farming, etc.).
8. **Multi-admin per aggregator** — MVP assumes one admin identity per org. Confirm. If multiple, the session-to-aggregator binding in § 7.1 generalises to a membership lookup.
9. **Link and QR lifecycle** — expiry, revocation, and single-use vs. multi-use are not specified. Recommend multi-use with optional expiry.
10. **Export size cap and retention** — retention of generated CSVs in object storage; default 7 days, purge thereafter.

---

## 9. Phased delivery

### Phase 0 — Foundations (1–2 weeks)

- Repository scaffolding (monorepo or split).
- Aggregator DB schema and migrations.
- Auth skeleton (OTP request/verify, JWT).
- CI/CD, observability baseline.

### Phase 1 — Registration & Profile (2 weeks)

- AG-0 registration request + email to admin.
- Login + session.
- AG-0c schema-driven profile view/edit.
- Verified flag surfacing.

### Phase 2 — Onboarding (2–3 weeks)

- Link & QR generation and listing (AG-1).
- Per-link/mode counts (AG-1a) — dependent on Signals Stack attribution.
- Bulk upload (AG-1c) with per-row outcomes.
- Flagged profiles list and intent logging (AG-1b).

### Phase 3 — My Blue Dots (3 weeks)

- Signal Processing Service MVP (Option A materialisation).
- Summary cards (AG-0b).
- Participant list, search, filter, detail (AG-2).
- CSV export (AG-6).

### Phase 4 — Hardening (1–2 weeks)

- Performance against targets in § 7.5.
- DPDP controls per final legal guidance.
- Accessibility audit and fixes.
- Beta rollout.

Total indicative: **9–12 weeks** of engineering time, assuming two full-stack engineers and one backend engineer on the Signal Processing Service, plus design and QA support.

---

## 10. Decisions needed before build

1. Sign-off on Option A for the Signal Processing Service compute model.
2. Confirmation from the Signals Stack team on source-mode attribution at registration.
3. Resolution (or interim policy) on the two DPDP open items.
4. Stack choices: Next.js + Node API + Postgres is the recommendation; confirm.
5. OTP provider choice.
6. Deployment target (Kubernetes cluster, managed service, etc.) — not covered by the PRD.

---

## Appendix A — Field mapping (from PRD)

The PRD's "Field Mapping between Job Stack & Aggregator" table (pages 20–22) is the authoritative contract between the Jobs Stack, the Signal Processing Service, and the Aggregator Platform. It is reproduced by reference; see the PRD directly. Every field shown in the Aggregator UI maps to one row of that table.

## Appendix B — Status computation rules (from PRD)

Reproduced verbatim for engineering convenience.

**Seeker status:**

- New — `profile_age ≤ 7`, regardless of `last_applied_age`
- Active — `last_applied_age ≤ 30`
- At Risk — `profile_age > 7` AND `31 ≤ last_applied_age ≤ 90`
- Inactive — `profile_age > 7` AND (`last_applied_age > 90` OR `last_applied_age = 0`)

**Provider status:**

- New — `job_post_age ≤ 7`
- Satisfied — `applications > 0` AND `(shortlisted + rejected) ≥ openings`
- Active — `applications > 0` AND `min(shortlisted_age, rejected_age) ≤ 30`
- At Risk —
  - `applications > 0` AND `31 ≤ min(shortlisted_age, rejected_age) ≤ 90` AND `(shortlisted + rejected) < openings`, OR
  - `7 ≤ job_post_age ≤ 30` AND `applications = 0`
- Inactive —
  - `applications > 0` AND `min(shortlisted_age, rejected_age) > 90` AND `(shortlisted + rejected) < openings`, OR
  - `31 ≤ job_post_age ≤ 90` AND `applications = 0`

**Profile status:** Complete if `profile_completion_pct ≥ 75%`, else Incomplete.
