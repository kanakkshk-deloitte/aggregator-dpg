# Aggregator App — Technical Design & Architecture

> Last updated: 2026-04-27
> Status: Draft for review

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [Background & Problem Statement](#2-background--problem-statement)
3. [Key Design Problems](#3-key-design-problems)
4. [Design](#4-design)
   - [4.1 Technical Design](#41-technical-design)
   - [4.2 Architecture](#42-architecture)
   - [4.3 API Specification](#43-api-specification)
5. [Conclusion](#5-conclusion)
6. [Appendix](#6-appendix)

---

## 1. Introduction

### 1.1 Signal Stack

**Signal Stack** is the underlying platform that powers the Blue Dot ecosystem — a network of **Seekers** (demand-side participants looking for opportunities), **Providers** (supply-side participants offering opportunities), and the **Aggregators** who steward them. The stack provides the building blocks — identity, profile, signal exchange, telemetry, and reporting — that allow these actors to discover one another, exchange intent, and be measured at the ecosystem level.

The platform is designed to be **ecosystem-agnostic** (Jobs, PwD support, Welfare, Farming, MSME, etc.) and **deployment-agnostic** (state, district, theme). Configuration — not code — is what specialises a deployment for a use case.

### 1.2 Aggregator App

The **Aggregator App** is the first user-facing application built on Signal Stack. It serves the **Aggregator** actor — the organisation, network, or intermediary that identifies, onboards, and represents groups of Seekers and Providers within an ecosystem.

The app delivers the Aggregator stewardship loop:

> **Register → Add → Track & Operate → Report**

In the MVP scope (jobs use case, web only, English only), an Aggregator can:

- Register as a Seeker or Provider Aggregator and obtain credentials after admin approval
- Set up an organisational profile (Who I Am / What I Want / What I Have)
- Onboard participants via bulk CSV upload, contextual registration links, and QR codes
- Track participants on a dashboard ("My Blue Dots") with system-derived status labels and recommended actions
- Export and share an aggregated network summary

This document specifies the technical design and architecture that realises those requirements at MVP scope.

### 1.3 Scope Within the Blue Dots Architecture

The Blue Dots / NFH Fabric Architecture describes Signal Stack as four functional layers — **Application Layer**, **Network Services**, **Common Services**, and **Global Services**. This document aligns to the Functional View of that architecture and implements components across all four layers at the scope required by the Aggregator App MVP:

- **Application Layer** — the Aggregator App and a thin Public Registration page used by Seekers and Providers via aggregator-issued links.
- **Common Services** — Auth, Notifications, Telemetry, and consent capture.
- **Network Services** — Onboarding (aggregator-facing slice), Configuration (schemas and status rules), and Network Observability (telemetry pipeline and reporting analytics).
- **Global Services** — local Registry persistence and a Catalog publication entry point.

> **Note.** All components are implemented at MVP scope only — the minimum surface needed for the Aggregator App's Register → Add → Track & Operate → Report loop. Broader functionality across the architecture is addressed in subsequent iterations of the platform.

---

## 2. Background & Problem Statement

This document is self-contained. The MVP context that drives the design — actors, lifecycles, status definitions, in-scope features, and registration link semantics — is captured in this section so the rest of the document does not depend on any external requirements file.

### 2.1 Actors

The MVP serves a strict subset of the actors in the Blue Dots architecture v1.0 (Network Facilitator, Ecosystem Manager, Aggregator, Seeker, Provider, Service Provider). The mapping is:

| Actor in this doc | Maps to (Blue Dots Architecture)                                                                          | Direct user?           | What the system does for them                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------- |
| **Aggregator**    | Aggregator                                                                                                | Yes (full UI)          | Registration, profile, bulk onboarding, link/QR generation, participant tracking, reporting export |
| **Seeker**        | Seeker                                                                                                    | Partial                | Self-registers via link/QR; profile maintained on their behalf; status computed from activity      |
| **Provider**      | Provider                                                                                                  | Partial                | Self-registers via link/QR; job posting metadata maintained; status computed from activity         |
| **Admin**         | **Ecosystem Manager** (boundary owner who onboards aggregators within their geography or policy boundary) | No (out-of-band email) | Approves/rejects aggregator registration requests; issues credentials                              |
| **Funder**        | (Outside Blue Dots actor model)                                                                           | No                     | Receives exported reports                                                                          |

### 2.2 Lifecycles

**Aggregator lifecycle.** `registration submitted` → `under_review` (pending admin) → `approved` (credentials emailed; can log in) **or** `rejected` (read-only error). After approval the aggregator can complete its profile, generate registration links, onboard participants, and view dashboards. `aggregator_type` (Seeker or Provider) is selected at registration time on a single shared registration form and is fixed for the life of the account.

**Participant (Seeker / Provider) lifecycle.** `registered` (via bulk upload, public link, or aggregator-driven entry) → derived **status** computed from activity facts (profile age, last applied date, application counts, job-post age, openings filled, etc.). Status is one of `New`, `Active`, `At Risk`, `Inactive`, `Satisfied` and is recomputed on every activity event and on a nightly snapshot for reporting roll-ups.

### 2.3 MVP Feature Scope

The features below are in MVP scope and drive every design decision in §3 and §4.

- **Aggregator registration** — a **single web form** serving both Seeker and Provider aggregator types. The form captures common fields plus type-specific fields surfaced conditionally based on the chosen `aggregator_type`. Submission goes through admin approval before the account becomes usable.
- **Login & Identity** — two paths: OTP (email or phone) and password. Both required at MVP. Session persistence across visits; standard token-rotation behaviour.
- **Aggregator profile** — "Who I Am / What I Want / What I Have" structure. JSON Schema-driven so non-engineers can evolve it without code change.
- **Onboard via bulk CSV upload** — asynchronous, partial-success, error report; **maximum 50 rows per upload** at MVP. Valid rows persist, invalid rows surface in an error report; duplicates (by normalised E.164 phone within the owning aggregator) are skipped.
- **Onboard via public registration link / QR** — each link carries context (state, district, source/sub-source, campaign) that is denormalised onto every downstream record and emitted on every telemetry event.
- **My Blue Dots dashboard** — list of all participants under the aggregator with system-derived status labels and recommended next actions ("Update Location" etc.) computed from missing-field rules.
- **Reporting** — aggregated network summary export (CSV at MVP). Counts and percentages by participant type and status; gaps and outcomes.
- **First-time experience** — guided onboarding for a freshly approved aggregator: profile completion → first link / first bulk upload → first dashboard view.
- **Consent** — DPDP-aligned consent capture at aggregator registration and at participant-level entry; consent record stored alongside profile data.
- **Navigation** — single web app, English only at MVP. i18n hooks must be present from day one.

### 2.4 Status Definitions and Thresholds (MVP)

Thresholds and rules are expressed as configuration so they can be modified without code change. Rules are evaluated first-match-wins, top to bottom.

| Status        | Applies to       | Rule                                                                                  |
| ------------- | ---------------- | ------------------------------------------------------------------------------------- |
| **New**       | Seeker, Provider | `profile_age_days ≤ 7`                                                                |
| **Active**    | Seeker           | `last_applied_age_days ≤ 30`                                                          |
| **Active**    | Provider         | `last_job_post_age_days ≤ 30`                                                         |
| **At Risk**   | Seeker           | `profile_age_days > 7` AND `31 ≤ last_applied_age_days ≤ 90`                          |
| **At Risk**   | Provider         | `profile_age_days > 7` AND `31 ≤ last_job_post_age_days ≤ 90`                         |
| **Inactive**  | Seeker           | (`profile_age_days > 7` AND `last_applied_age_days > 90`) OR `applications_count = 0` |
| **Inactive**  | Provider         | (`profile_age_days > 7` AND `last_job_post_age_days > 90`) OR `job_posts_count = 0`   |
| **Satisfied** | Seeker           | `shortlisted_count ≥ 1` in trailing 30 days                                           |
| **Satisfied** | Provider         | `openings_filled / openings ≥ 0.8`                                                    |

Recommended-action labels are derived from missing or stale profile fields ("Update Location", "Add Phone", "Renew Job Post", etc.) and are configured the same way.

### 2.5 Registration Link Context

Every link carries a context blob denormalised onto every downstream registration and emitted with every telemetry event derived from that link:

| Field               | Example               | Purpose                              |
| ------------------- | --------------------- | ------------------------------------ |
| `instance_state`    | `"Karnataka"`         | Geographic roll-up                   |
| `district`          | `"Hubli"`             | Geographic roll-up                   |
| `signal_source`     | `"ITI"`               | Source classification                |
| `source_full_name`  | `"Krishna ITI Hubli"` | Human-readable source                |
| `signal_sub_source` | `"Welding Trade"`     | Sub-source classification (optional) |
| `campaign`          | `"AY2026 Spring"`     | Optional campaign tag                |

These fields are the smallest set that makes "registrations per source", "completion % per district", and "campaign attribution" derivable from the telemetry corpus alone.

### 2.6 Key Functional Constraints

The constraints below are load-bearing for the design — they shape the technology choices in §4.

- **Single registration form for both aggregator types** — the same form serves Seeker and Provider aggregator registrations; type-specific fields are conditional, not separate flows.
- **Two login paths** — OTP (email/phone) and password — both required at MVP.
- **External approval flow** — admin actions happen in email, not in-app. The system must hold a registration in `under_review` and accept a side-channel approval signal.
- **Self-registration via shareable link / QR** — public, unauthenticated entry point that resolves to a context-bound form (state, district, domain, source/sub-source, campaign).
- **Bulk CSV upload, asynchronous, partial-success** — up to 50 rows per file, valid rows register, invalid rows surface in an error report. Nothing is deduplicated locally — each row's outcome is Signals' verdict, and a Signals rejection such as `DOMAIN_LOCKED` or `USER_ALREADY_EXISTS` is reported in the error report under the `duplicate` category.
- **System-derived participant status** — New / Active / At Risk / Inactive / Satisfied — computed from time-window rules expressed as configuration.
- **Recommended actions** — system-generated suggestions (e.g. "Update Location") derived from missing fields on a participant's profile.
- **Telemetry on every action** — every meaningful UX or backend event emits a structured telemetry event conformant to the **Sunbird Telemetry Spec v3** (https://telemetry.sunbird.org/learn/specification), carrying the originating context (link metadata, actor, action) so reporting metrics can be computed downstream.
- **Web-only, English-only, jobs-only at MVP** — but the surface area must not bake any of those in.

### 2.7 Non-Functional Constraints

| Dimension                   | MVP target                                     | Notes                                                           |
| --------------------------- | ---------------------------------------------- | --------------------------------------------------------------- |
| Concurrent Aggregators      | ~10 aggregators initially                      | Small early cohort; architecture should not block scaling later |
| Participants per Aggregator | A few hundred to low thousands                 | Bulk uploads dominate write load                                |
| API latency (p95)           | < 400ms for read, < 1s for non-bulk write      | Bulk upload is async — no UI latency budget                     |
| Bulk upload size            | 50 rows / file                                 | Hard cap from PRD                                               |
| Availability                | 99.5% (best-effort, no SLA)                    | Single region, single AZ acceptable for MVP                     |
| Compliance                  | DPDP-aligned consent capture; PII minimisation | Two open legal items — design must not block resolution         |
| Languages                   | English only at MVP                            | i18n hooks present from day one                                 |

### 2.8 Out of Scope (MVP)

Real-time push alerts, in-app messaging to participants, sub-aggregator hierarchies, role-based access control, AI/NL querying of the network, mobile apps, multi-language support, multi-ecosystem switching at runtime.

### 2.9 Architecture Layer Scope

This section maps the components implemented in this design to the layers of the Blue Dots architecture. Every component below is **In MVP** — implemented at the scope required by the Aggregator App's Register → Add → Track & Operate → Report loop.

> **Note.** All components listed below are implemented at MVP scope only — covering the surface area the Aggregator App needs to function end-to-end, not the full feature surface of the corresponding architecture component. The MVP is useful end-to-end inside a single network instance.

| Architecture Layer    | Component                   | MVP Scope                                                                                                                         |
| --------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Application Layer** | Aggregator app              | Full UI for the MVP loop: registration, profile, links, bulk onboarding, My Blue Dots, reporting                                  |
| Application Layer     | Public Registration page    | Seeker / Provider self-registration via aggregator-issued link                                                                    |
| Application Layer     | Ecosystem Manager surface   | Email-based signed-link review flow with a single decision endpoint (§4.1.4)                                                      |
| Application Layer     | Network Facilitator surface | Schemas, rules, and config artefacts version-controlled under `config/`                                                           |
| **Common Services**   | Auth                        | Keycloak for OTP / password / sessions / JWT                                                                                      |
| Common Services       | Notifications               | SMTP + SMS adapter behind a single port                                                                                           |
| Common Services       | Telemetry                   | Sunbird Telemetry Spec v3, SDK on FE, ingestion endpoint, NDJSON corpus                                                           |
| Common Services       | Consent Manager             | Consent JSONB stamped on aggregator and participant records; PII reads scoped to the owning aggregator                            |
| **Network Services**  | Onboarding Service          | Aggregator-facing slice (registration, verification, dedup) implemented as the Onboarding & Bulk module of the Aggregator Service |
| Network Services      | Configuration Service       | Schemas + rules served by the Aggregator Service's Schema & Rules module via `GET /v1/schemas/read/{actor}/{action}`              |
| Network Services      | Network Observability       | Telemetry pipeline + DuckDB over NDJSON for reporting                                                                             |
| Network Services      | Management Service          | Decision endpoint behind the signed-link admin email                                                                              |
| Network Services      | Discovery Service           | Participant-list and search APIs scoped to the owning aggregator (§4.3 — `/v1/participants/list/...`)                             |
| Network Services      | Matching Service            | Status-rule and recommended-action engine over participant facts (§4.1.3)                                                         |
| **Global Services**   | Registry                    | Aggregators and participants persisted locally                                                                                    |
| Global Services       | Catalog Service             | Catalog publication entry point on the Onboarding & Bulk module (no-op at MVP)                                                    |

---

## 3. Key Design Problems

The MVP boils down to the design problems below. Each is stated here in one paragraph; options and the recommended approach for each are in §4.1.

### 3.1 Identity & Access Management (IAM)

Two login modes (OTP via email/phone, and password), an external approval gate before credentials are issued, and session persistence across visits.

### 3.2 Configurable Schemas (Per Actor, Per Action)

Aggregator registration (a single schema serving both Seeker and Provider aggregator types via conditional fields keyed off `aggregator_type`), Aggregator profile, Seeker profile, Provider profile, Registration Link — each has its own field set and validations. Schemas live as configuration, not code.

### 3.3 Configurable Status Rules

Seeker and Provider status (New / Active / At Risk / Inactive / Satisfied) depends on multiple time-window thresholds and field conditions. Thresholds and the rules that compute them live as configuration.

### 3.4 External Admin Approval

Admin approves registrations out-of-band via email. The platform must hold the request in `under_review`, accept a side-channel approval signal, and only then enable login.

### 3.5 Public Self-Registration via Link / QR

Each registration link carries context (state, district, domain, source/sub-source, campaign) that must be embedded in every downstream registration record and telemetry event. The link is unauthenticated and must dedupe re-submissions.

### 3.6 Asynchronous Bulk Upload

50 rows per file, partial-success semantics, error report, duplicate detection. Synchronous processing would tie up API workers and risk timeouts.

### 3.7 Telemetry-First Eventing

Every action — UI click, API call, status change, link generation, registration, upload — must emit a telemetry event conformant to the **Sunbird Telemetry Spec v3** (https://telemetry.sunbird.org/learn/specification), carrying the originating context so reporting metrics can be derived without re-querying transactional tables.

---

## 4. Design

### 4.1 Technical Design

For each design problem in §3, this section enumerates the realistic options, compares them, and states the recommended approach.

#### 4.1.1 Identity & Access Management

**Options considered (open-source only):**

| Option                                  | Pros                                                                                                                                                     | Cons                                                                                                                                                                                           |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Keycloak**                         | OIDC/OAuth2 + OTP + password + sessions out of the box; mature SPI for custom flows; admin REST API; very large community                                | Java runtime to operate; heavier resource footprint; admin UI is functional but dated                                                                                                          |
| **B. Authentik**                        | Modern Python-based IdP; clean admin UI; flexible "flows + stages" for custom auth; OAuth2/OIDC/SAML; built-in MFA primitives; lighter ops than Keycloak | Smaller community than Keycloak; fewer reference patterns for custom OTP delivery via an external Notification provider; multi-tenant isolation is by tenant, less mature than Keycloak realms |
| **C. Ory Kratos + Hydra**               | Headless, Go, OSS; clean separation of identity and OAuth2 server                                                                                        | Two services to wire; OTP requires a custom flow node; smaller ecosystem; thinner admin UX                                                                                                     |
| **D. Custom auth on Passport.js + JWT** | Full control; minimal dependencies                                                                                                                       | Reinvents OTP, lockout, refresh, password reset, audit; significant engineering and security risk                                                                                              |

**Recommendation: Option A — Keycloak.**

The two real contenders are Keycloak and Authentik. Both are open-source, self-hostable, and cover OIDC + OTP + password + sessions. Authentik wins on admin UX and operational lightness; Keycloak wins on maturity, the SPI ecosystem, and the explicit needs of this MVP:

- The custom OTP authenticator that delegates code delivery to our Notification adapter has a long-established Keycloak SPI pattern with reference implementations; Authentik's equivalent (a custom stage) is doable but less battle-tested for SMS-via-third-party flows.
- Keycloak's direct-grant flow is the standard fit for the `password` login path the PRD calls out; Authentik supports it but with slightly more wiring.

**Configuration:**

- Realm: `signal-stack`. Clients: `aggregator-web` (public, OIDC, PKCE) and `aggregator-api` (confidential, bearer-only).
- User attributes: `aggregator_id`, `aggregator_type` (`seeker` | `provider`), `org_slug`, `approval_status` (`pending` | `approved` | `rejected`).
- Pending users are created with `enabled=false`; the approval endpoint flips them to `enabled=true`.
- JWT access tokens (5 min) carry `sub`, `aggregator_id`, `aggregator_type`, `org_slug` — used for path-scoping and audit on every API call.
- Sessions: idle 30 min, max 12 hours, refresh-token rotation on.

Authentik should be revisited if Keycloak's operational footprint becomes a constraint or if a future deployment prefers Python-based infrastructure.

#### 4.1.2 Configurable Schemas

**Options considered:**

| Option                                          | Pros                                                                                                                                                                          | Cons                                                                                                      |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **A. JSON Schema (Draft 2020-12) + Ajv + RJSF** | Industry standard, declarative, portable; same schema serialises to FE form, API validation, and CSV-row validation; rich tooling (RJSF auto-renders forms with conditionals) | Requires explicit handling for non-trivial conditionals (`if/then/else`)                                  |
| **B. Code-defined schemas (Yup / Zod)**         | Excellent DX in TypeScript, single language                                                                                                                                   | Not declarative; can't be served from a config store as data; can't be edited by non-engineers            |
| **C. OpenAPI 3.1 as the schema source**         | API + form share a contract                                                                                                                                                   | OpenAPI is API-shape-oriented; awkward to express UX-only concerns like ordering and grouping             |
| **D. Custom DSL**                               | Tailored to the domain                                                                                                                                                        | Reinvents JSON Schema badly — every team that goes down this path eventually rebuilds the same primitives |

**Recommendation: Option A — JSON Schema 2020-12 with Ajv + RJSF.**

- One schema, three consumers: React form (RJSF), API request validation (Ajv middleware), CSV row validation in the bulk-upload worker (same Ajv compile).
- Schemas are stored as versioned files in a `config/schemas/` directory, served by the Aggregator Service via `GET /v1/schemas/read/{actor}/{action}`. Cached with ETag + `max-age`.
- Layout:

```
config/
  schemas/
    aggregator/
      registration.v1.json    # unified — covers Seeker and Provider aggregator types
      profile.v1.json
    seeker/
      profile.v1.json
    provider/
      profile.v1.json
    registration-link/
      create.v1.json
```

- The unified `aggregator/registration.v1.json` defines a top-level `aggregator_type: "seeker" | "provider"` enum and uses JSON Schema 2020-12 `if/then/else` (or `allOf` + `dependentSchemas`) to surface type-specific fields conditionally. RJSF renders the conditional fields in the same form. The form also captures consent.
- Schemas are immutable per version; bumping `v1 → v2` is the only way to change a published schema. The schema version is stamped onto every record at write time.

#### 4.1.3 Configurable Status Rules

**Options considered:**

| Option                                                                     | Pros                                                                                                 | Cons                                                                             |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **A. Declarative JSON rules + lightweight evaluator (in-house, ~200 LOC)** | Fully fits the use case; first-match-wins is easy to reason about; rules are config; trivial to test | Built and owned in-house                                                         |
| **B. `json-rules-engine` (npm)**                                           | Off-the-shelf rule engine; maintained; supports nesting and operators we need                        | Slightly heavier API; less control over evaluation order semantics               |
| **C. Hard-coded with feature flags**                                       | Fastest to ship                                                                                      | PRD requires configurability; rework guaranteed                                  |
| **D. Drools / full Rete engine**                                           | Enterprise-grade; fact-network reasoning                                                             | Massive overkill for a flat set of time-window thresholds; adds a JVM dependency |

**Recommendation: Option B — `json-rules-engine`** (with Option A as the fallback if a constraint emerges that the library can't express).

- Rules stored at `config/rules/seeker.status.v1.json` and `config/rules/provider.status.v1.json`.
- Evaluation strategy: ordered list, first match wins. The "fact bag" is a derived object (e.g. `profile_age_days`, `last_applied_age_days`, `applications_count`) computed from the participant record at evaluation time.
- Recommended-action labels (e.g. "Update Location") follow the same pattern in `config/rules/recommended-actions.v1.json`, with the right-hand side being a label string.
- Triggers: lazily on participant-list reads (cached 60s per participant); proactively on any status-affecting domain event (new application, profile edit) which invalidates the cache; nightly snapshot for reporting roll-ups.

**Rule format (illustrative, for Seeker status):**

```json
{
  "actor": "seeker",
  "version": 1,
  "rules": [
    {
      "status": "New",
      "when": { "all": [{ "fact": "profile_age_days", "op": "lte", "value": 7 }] }
    },
    {
      "status": "Active",
      "when": { "all": [{ "fact": "last_applied_age_days", "op": "lte", "value": 30 }] }
    },
    {
      "status": "At Risk",
      "when": {
        "all": [
          { "fact": "profile_age_days", "op": "gt", "value": 7 },
          { "fact": "last_applied_age_days", "op": "between", "value": [31, 90] }
        ]
      }
    },
    {
      "status": "Inactive",
      "when": {
        "any": [
          {
            "all": [
              { "fact": "profile_age_days", "op": "gt", "value": 7 },
              { "fact": "last_applied_age_days", "op": "gt", "value": 90 }
            ]
          },
          { "fact": "applications_count", "op": "eq", "value": 0 }
        ]
      }
    }
  ]
}
```

#### 4.1.4 External Admin Approval

**Options considered (open-source only):**

| Option                                          | Pros                                                                                       | Cons                                                                                  |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| **A. Signed-link in admin email (no admin UI)** | Tiny surface; matches PRD's "approval via email" verbatim; auditable via single-use tokens | No bulk operations; admin must trust the email channel                                |
| **B. Lightweight admin web UI**                 | Bulk approve/reject; richer view of the queue                                              | Out of MVP scope; extra screens, auth, RBAC                                           |
| **C. Reply-to-approve email parser**            | Zero-click for admins                                                                      | Brittle (HTML signatures, forwards); spoofing risk; harder to make idempotent         |
| **D. CLI-driven admin workflow**                | Simple script over the admin REST API; auditable                                           | Requires the admin to install / run tooling; less accessible for non-technical admins |

**Recommendation: Option A — Signed-link in admin email.**

- Submission creates a `pending` Aggregator row, a Keycloak user (`enabled=false`), and a signed approval token (JWT, 7-day TTL, single-use).
- Admin email contains two pre-filled deep links (`Approve`, `Reject`) that both land on `GET /admin/v1/aggregator-registrations/read/{registration_id}?token=…&intent=approve|reject`. The server-rendered review page reads the `intent` to highlight the corresponding button (so the admin can confirm or change their mind). Confirming submits to the single decision endpoint `POST /admin/v1/aggregator-registrations/decision/{registration_id}` with body `{decision, reason?, token}`.
- Approve flips Keycloak `enabled=true`, sets `approval_status=approved`, and triggers a credentials email to the aggregator. Reject sets `approval_status=rejected` and records the reason. The token is consumed on first decision regardless of outcome.
- Admin email recipient is a deployment configuration value.

#### 4.1.5 Public Self-Registration via Link / QR

**Options considered:**

| Option                                                       | Pros                                                                                 | Cons                                                                          |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| **A. Slug + DB lookup (`/join/{city}/{org}`)**               | Human-readable URLs; aggregator can recognise their own links; trivial to deactivate | Requires uniqueness checks at create time                                     |
| **B. Signed token in URL with embedded context**             | Stateless; tamper-evident                                                            | Long URLs; rotating context (e.g. fixing a typo) requires reissuing all links |
| **C. Short hash (e.g. `/r/abc123`) with full context in DB** | Compact URLs; QR-friendly                                                            | Not human-readable; users can't tell which link is which from the URL alone   |

**Recommendation: Option A — Slug + DB lookup**, with a short hash (Option C) as a transparent fallback for very long slugs.

- `RegistrationLink` is a first-class entity owned by an Aggregator with a stable slug, a domain (`seeker` / `provider`), and a `context` JSONB blob (state, district, source/sub-source, campaign).
- Public flow:
  1. `GET /public/v1/links/resolve/{slug}` resolves to `{domain, context, schema_url}` (404 if inactive). Rate-limited by IP at 60 req/min.
  2. Frontend fetches the schema and renders the participant form via RJSF.
  3. `POST /public/v1/registrations/create/{slug}` validates body against the schema, dedupes against existing participants under the owning aggregator (key: normalised E.164 phone), and creates the participant with the link's `context` denormalised onto the record so a later deactivation doesn't lose history.
  4. A telemetry pair is emitted: an `INTERACT` (form submit, `edata.type = "SUBMIT"`, `edata.subtype = "public-registration"`) followed by an `AUDIT` (`edata.state = "registered"`, `object.type = "Participant"`), both carrying the link slug in `cdata = [{type: "RegistrationLink", id: <slug>}]`.
- QR codes are generated server-side via `qrcode` (Node) at link-creation time, persisted to MinIO as PNG and SVG, and surfaced as signed `qr_url_png` / `qr_url_svg` fields on the `create` and `read` link responses. There is no separate QR-fetch endpoint — clients render the QR by referencing the persisted asset URL directly.

#### 4.1.6 Asynchronous Bulk Upload

**Options considered (open-source only):**

| Option                                                   | Pros                                                                                                 | Cons                                                                                       |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **A. Pre-signed upload to object store + BullMQ worker** | API never streams large files; standard Redis-backed queue; retries/rate-limit built-in; trivial ops | Need an object store + Redis (already in use)                                              |
| **B. `pg-boss` (Postgres-backed queue)**                 | One fewer dependency (no Redis)                                                                      | Mixes OLTP and queue load on the same DB; lower throughput ceiling                         |
| **C. Kafka with a streaming consumer**                   | Industrial-strength; replayable; durable; horizontal scale                                           | Operational burden far exceeds the MVP volumes; cluster + ZooKeeper / KRaft to operate     |
| **D. Synchronous chunked processing**                    | Simplest code                                                                                        | Ties up API workers; bad UX (long blocking call); can't provide error report incrementally |

**Recommendation: Option A — Pre-signed upload + BullMQ worker.** The volumes and concurrency at MVP do not justify Kafka's operational footprint. BullMQ on the Redis we already run is right-sized for the 50-row per-upload cap.

**MVP flow:**

- `POST /v1/bulk-uploads/create/{aggregator_id}` body `{participant_type: "seeker"|"provider"}` creates a `BulkUploadJob` row in `awaiting_upload` and returns `{job_id, upload_url, expires_at}`.
- Frontend `PUT`s the CSV directly to object storage (MinIO).
- A MinIO bucket-notification (`s3:ObjectCreated:Put`) fans out to a small notification handler in the Aggregator Service, which validates the row count (rejects > 50 rows), flips the job to `queued`, and enqueues a BullMQ job. Removing the explicit `start` call eliminates the race window where the client could call `start` before the upload completes.
- The Bulk Upload Worker (a separate process from the same codebase) streams the CSV via Papaparse, validates each row with Ajv against the active profile schema, deduplicates against existing participants for the aggregator, and either persists the row or appends to the error report.
- `BulkUploadJob` record holds `status`, `rows_total`, `rows_ok`, `rows_failed`, and `error_report` (entry per failed row, capped at the 50-row file size).
- Watchdog requeues jobs that stall for >5 min.

#### 4.1.7 Telemetry Pipeline

**Spec: Sunbird Telemetry Spec v3** (https://telemetry.sunbird.org/learn/specification, event details at https://telemetry.sunbird.org/learn/v3_event_details) — mandated by the platform. No alternatives evaluated; the spec is a fixed input. Producers (frontend SDK + backend middleware) emit envelopes that conform to the v3 event shape — `eid`, `ets`, `ver`, `mid`, `actor`, `context`, `object`, `edata`, `tags`.

- **Frontend Telemetry SDK:** the official **Sunbird Telemetry SDK** (`@project-sunbird/telemetry-sdk`, https://www.npmjs.com/package/@project-sunbird/telemetry-sdk) — handles batching, retries with exponential backoff, IndexedDB offline persistence, and pdata/context injection out of the box. The Aggregator Web App initialises the SDK once at boot with `pdata`, `channel`, and `dispatcher` config; module code calls `Telemetry.start/end/impression/interact/audit/error/...` directly.
- **Backend middleware** mirrors the SDK contract for server-originated events (NestJS interceptor that builds the envelope and pushes to the same buffer the SDK posts to).
- **Ingestion endpoint** `POST /v1/telemetry` accepts the SDK's batch shape `{id, ver, ets, params, events: [...]}`. Buffer in Redis; flush to object storage (MinIO) as NDJSON.
- **Analytical store: DuckDB** — runs scheduled queries over the NDJSON corpus to materialise reporting outputs. Cheap, embedded, no extra service to operate.

**Event types at MVP — aligned to Sunbird v3 `eid` enumeration** (https://telemetry.sunbird.org/learn/v3_event_details). We do **not** invent custom `eid`s; domain semantics ride in `edata.type` / `edata.subtype` / `cdata`, which is the Sunbird convention.

| eid          | When                              | Key edata fields                                                                        | Examples in this app                                                                                                                                                                                                             |
| ------------ | --------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `START`      | Session or activity begins        | `type` (`session`, `app`, `job`), `mode`, `dspec`                                       | Successful login (`type=session`); bulk upload job picked up by worker (`type=job`)                                                                                                                                              |
| `END`        | Session or activity ends          | `type`, `mode`, `duration`, `summary[]`                                                 | Logout (`type=session`); bulk upload job complete with row counts in `summary[]`                                                                                                                                                 |
| `IMPRESSION` | Page or screen view               | `type` (`view`, `detail`, `list`), `subtype`, `pageid`, `uri`                           | "My Blue Dots" page view, public registration page view                                                                                                                                                                          |
| `INTERACT`   | UI interaction of significance    | `type` (`CLICK`, `SUBMIT`, `DOWNLOAD`, `DRAG`, `SELECT`), `subtype`, `pageid`, `target` | Aggregator registration submit, link create click, CSV template download, public registration form submit                                                                                                                        |
| `AUDIT`      | Any persisted state change        | `state`, `prevstate`, `props[]` (changed field names), `duration`                       | Aggregator approval (`pending → approved`), participant created (`"" → registered`), participant status flip (`Active → At Risk`), link deactivation (`live → inactive`), bulk job state machine (`queued → running → complete`) |
| `SEARCH`     | Server-side filter / search query | `type`, `query`, `filters[]`, `size`                                                    | Participant list filter, dashboard query                                                                                                                                                                                         |
| `ERROR`      | Handled error path                | `err`, `errtype`, `stacktrace`, `pageid`                                                | Validation failure, upstream timeout, OTP delivery failure                                                                                                                                                                       |
| `LOG`        | Diagnostic / operational          | `type`, `level`, `message`, `params[]`                                                  | Queue depth, cache miss, rate-limit trip                                                                                                                                                                                         |

**Domain events expressed as Sunbird v3:**

- _Aggregator registration form submit_ → `INTERACT` with `edata = {type: "SUBMIT", subtype: "aggregator-registration", pageid: "public-aggregator-registration"}`; persistence emits `AUDIT` with `edata = {state: "pending", prevstate: ""}` and `object = {id: registration_id, type: "AggregatorRegistration"}`.
- _Aggregator approval / rejection_ → `AUDIT` with `edata = {state: "approved" | "rejected", prevstate: "pending"}`.
- _Public link participant registration_ → `INTERACT` (form submit) followed by `AUDIT` with `edata = {state: "registered", prevstate: ""}`, `object = {type: "Participant"}`, and `cdata = [{type: "RegistrationLink", id: <slug>}]`.
- _Participant status flip_ → `AUDIT` with `edata = {state: "At Risk", prevstate: "Active", props: ["last_applied_age_days"]}`.
- _Bulk upload lifecycle_ → `START` (worker picks up) → `AUDIT` per state transition → `END` with `edata.summary = [{rows_total, rows_ok, rows_failed}]`.

**Context attached to every event:**

- `channel` — deployment id (e.g. `signal-stack-prod`)
- `pdata` — `{id: "aggregator-app", ver: "1.x.y", pid: "web" | "api"}`
- `env` — module (`onboarding`, `auth`, `bluedots`, …)
- `cdata` — correlation refs. For any event triggered through a registration link, this includes `[{type: "RegistrationLink", id: <slug>}]` — the single most important field for downstream reporting.
- `rollup` — `{l1: org_slug, l2: aggregator_type}` for aggregator-level group-bys.

### 4.2 Architecture

The architecture deliberately keeps the runtime footprint small. The system is one application — the **Aggregator Service** — built as a modular monolith, with one background-worker process for bulk uploads, plus a few foundational dependencies (Keycloak for IAM, Postgres, Redis, object storage). This keeps deployment, on-call, and reasoning simple while the internal module boundaries leave room to split components out as load demands.

#### 4.2.1 Component Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                  CLIENTS                                     │
│  ┌──────────────────────┐                 ┌──────────────────────────────┐  │
│  │  Aggregator Web App  │                 │  Public Registration Page    │  │
│  │  (Next.js + RJSF)    │                 │  (Next.js, unauthenticated)  │  │
│  └──────────┬───────────┘                 └──────────────┬───────────────┘  │
└─────────────┼─────────────────────────────────────────────┼─────────────────┘
              │ HTTPS                                       │ HTTPS
┌─────────────┼─────────────────────────────────────────────┼─────────────────┐
│             ▼                                             ▼                  │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                    API Gateway (NGINX)                               │    │
│  │   - TLS termination, JWT validation, rate limits, request id        │    │
│  └─────────────────────────────────┬─────────────────────────────────────┘  │
│                                    │                                         │
│  ┌─────────────────────────────────▼─────────────────────────────────────┐  │
│  │                       AGGREGATOR SERVICE                               │  │
│  │                  (Node.js / NestJS — modular monolith)                 │  │
│  │                                                                        │  │
│  │   ┌────────────┐  ┌──────────────┐  ┌──────────────┐  ┌────────────┐  │  │
│  │   │   Auth &   │  │  Aggregator  │  │   Links &    │  │ Onboarding │  │  │
│  │   │ Approval   │  │   Profile    │  │  Public Reg  │  │  & Bulk    │  │  │
│  │   │  Module    │  │   Module     │  │   Module     │  │   Module   │  │  │
│  │   └────────────┘  └──────────────┘  └──────────────┘  └────────────┘  │  │
│  │                                                                        │  │
│  │   ┌────────────┐  ┌──────────────┐  ┌──────────────┐  ┌────────────┐  │  │
│  │   │ Participants│  │  Schema &    │  │  Telemetry  │  │Notification│  │  │
│  │   │ & Reporting │  │   Rules      │  │  Ingestion  │  │   Adapter  │  │  │
│  │   │   Module    │  │   Module     │  │   Module    │  │  (email,   │  │  │
│  │   │             │  │              │  │             │  │  SMS)      │  │  │
│  │   └────────────┘  └──────────────┘  └──────────────┘  └────────────┘  │  │
│  └─────────────────────────────────┬─────────────────────────────────────┘  │
│                                    │                                         │
│  ┌─────────────────────────────────▼─────────────────────────────────────┐  │
│  │                      Bulk Upload Worker                                │  │
│  │              (same codebase, separate process, BullMQ)                 │  │
│  └─────────────────────────────────┬─────────────────────────────────────┘  │
│                                    │                                         │
│  ┌─────────────────────────────────▼─────────────────────────────────────┐  │
│  │                          Foundations                                   │  │
│  │   Keycloak  │  YugabyteDB (YSQL)  │  Redis  │  MinIO  │  DuckDB        │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### 4.2.2 Component Responsibilities

| Component                    | Tech                                                        | Responsibility                                                                                                                                                                                                                                                                                                                           |
| ---------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Aggregator Web App**       | Next.js 14 (App Router), TypeScript, Tailwind, `@rjsf/core` | Aggregator-facing UI: registration, profile, onboarding, my blue dots, reporting                                                                                                                                                                                                                                                         |
| **Public Registration Page** | Next.js (same monorepo, separate route group)               | Unauthenticated participant self-registration via link / QR                                                                                                                                                                                                                                                                              |
| **API Gateway**              | NGINX                                                       | TLS termination, JWT validation, rate limits, request id injection, routing                                                                                                                                                                                                                                                              |
| **Aggregator Service**       | Node.js (NestJS) — single deployable                        | All business logic. Internally organised as modules: Auth & Approval, Aggregator Profile, Links & Public Registration, Onboarding & Bulk, Participants & Reporting, Schema & Rules, Telemetry Ingestion, Notification Adapter                                                                                                            |
| **Bulk Upload Worker**       | Node.js + BullMQ                                            | Same codebase as Aggregator Service, run as a separate process. Streams CSVs from object storage, validates rows, writes participants, builds error reports                                                                                                                                                                              |
| **Keycloak**                 | Keycloak (Java)                                             | OIDC provider — OTP login, password login, session, JWT issuance, user lifecycle for the approval flow                                                                                                                                                                                                                                   |
| **YugabyteDB**               | YugabyteDB (YSQL — Postgres-compatible API)                 | Primary transactional store (aggregators, participants, links, jobs). YSQL preserves the Postgres wire protocol and SQL surface, so application code, drivers, and migration tooling are written against Postgres. **Local and dev environments use stock Postgres**; staging and production use YugabyteDB for horizontal scale and HA. |
| **Redis**                    | Redis 7                                                     | Session cache, OTP store, BullMQ queues, telemetry buffer, status cache                                                                                                                                                                                                                                                                  |
| **Object Store**             | MinIO                                                       | CSV uploads, raw telemetry NDJSON, generated QR PNGs, reporting exports                                                                                                                                                                                                                                                                  |
| **DuckDB**                   | DuckDB                                                      | Analytical queries over telemetry NDJSON for reporting. Cheap, embedded, no extra service to operate.                                                                                                                                                                                                                                    |
| **Notification adapter**     | Module within Aggregator Service                            | Email and SMS delivery — concrete provider is a deployment-configurable, open-source-friendly SMTP server / SMS gateway adapter                                                                                                                                                                                                          |

#### 4.2.3 Data Model (Core Tables)

```
aggregator
  id PK
  org_slug UNIQUE
  type CHECK (type IN ('seeker','provider'))
  registration_status CHECK IN ('pending','approved','rejected')
  created_at, updated_at

registration_link
  id PK
  aggregator_id FK
  slug UNIQUE
  domain CHECK IN ('seeker','provider')
  context JSONB
  status CHECK IN ('live','inactive')
  created_at, deactivated_at

participant   -- NOTE: never built as specified; the local participants table
              -- that did exist was removed (migration 0024). Signals is the
              -- store of record for participant profiles.
  id PK
  aggregator_id FK
  registration_link_id FK NULL
  type CHECK IN ('seeker','provider')
  schema_version
  data JSONB  -- validated against the active profile schema
  link_context_snapshot JSONB
  phone_normalised  -- dedup key, partial UNIQUE (aggregator_id, phone_normalised)
  email_normalised
  consent JSONB    -- captured at registration
  created_at, updated_at

participant_activity   -- denormalised for status computation
  participant_id FK
  applications_count
  shortlisted_count
  rejected_count
  pending_count
  last_applied_at
  job_post_at         -- providers only
  openings, filled    -- providers only
  status              -- computed; refreshed on activity events
  recommended_action  -- computed
  computed_at

bulk_upload_job
  id PK
  aggregator_id FK
  type CHECK IN ('seeker','provider')
  status CHECK IN ('awaiting_upload','queued','running','complete','failed')
  rows_total, rows_ok, rows_failed
  error_report JSONB    -- {row_index, errors[]}[]
  created_at, completed_at
```

JSONB blobs hold the schema-validated payload; the schema version is stamped on each row so a schema bump can be migrated incrementally.

#### 4.2.4 Deployment

- **Three Docker images:** `aggregator-web` (Next.js), `aggregator-service` (NestJS API), `aggregator-worker` (NestJS worker entrypoint, same codebase as the service).
- **Single Kubernetes cluster** at MVP (Docker Compose for local dev).
- **One namespace per environment** (`dev`, `staging`, `prod`).
- **Database** — stock **Postgres 16** for local and dev (single instance, easy to operate). **YugabyteDB (YSQL)** for staging and production, deployed via the YugabyteDB Operator. The application connects via the Postgres protocol in all environments; the only difference is the connection string.
- **Redis** self-hosted in the cluster at dev; managed equivalent in production.
- **Object storage** — **MinIO** in all environments. Self-hosted, S3-API compatible, runs in-cluster.
- **Keycloak** runs in the same cluster, backed by the same database (separate logical DB).
- **Secrets** in Kubernetes Secrets (Vault when scope grows).
- **Observability** — Prometheus + Grafana for metrics, Loki for logs, OpenTelemetry traces optional at MVP.

### 4.3 API Specification

#### 4.3.1 Conventions

- **Path shape:** `/{audience}/{version}/{resource}/{sub-resource?}/{action}/{id1?}/{id2?}`
  - **The action verb is in the URL itself.** Every endpoint name carries the verb — `list`, `read`, `create`, `update`, `delete`, plus specific verbs like `decision`, `deactivate`, `login`, `logout`, `verify`, `request`, `track`, `resolve`. The intent of the call is readable directly from the URL, independent of the HTTP method.
  - **All path variables (IDs) are placed at the end of the path.** Static segments — resource, sub-resource, action — come first; variables are tail.
  - `audience` ∈ `public` (unauth), `v1` (authenticated), `admin` (admin-only).
  - The owning aggregator is the first ID variable for any aggregator-scoped endpoint, e.g. `/v1/links/list/{aggregator_id}` for the list of an aggregator's links, `/v1/links/read/{aggregator_id}/{link_id}` for one link, `/v1/links/deactivate/{aggregator_id}/{link_id}` for the deactivate action.
  - `aggregator_id` may also be passed as the literal string `me` — the API resolves it to the JWT's `aggregator_id` claim. UX convenience for the aggregator's own UI.
- **HTTP method:** `GET` for `read` and for simple `list` calls with at most a couple of optional query parameters; `POST` for `list` when filters are non-trivial (multi-field, array filters, free-text search) so criteria ride in a JSON body and a single endpoint covers both narrow lookups and complex filtered queries; `POST` for everything else (`create`, `update`, `delete`, and any specific verbs). The method is a transport detail; the action in the path is the source of truth.
- **Auth:**
  - Authenticated endpoints require `Authorization: Bearer <jwt>` issued by Keycloak; `aggregator_id` in the JWT must match the path segment (or be `me`).
  - Public endpoints are unauthenticated, rate-limited per IP.
  - Admin endpoints require a one-time signed token (link-based).
- **Content type:** `application/json` for all bodies; CSV uploads use a pre-signed URL into MinIO, not multipart.
- **Errors:** RFC 7807 `application/problem+json`.
- **Pagination:** cursor-based (`?cursor=…&limit=…`).
- **Idempotency:** mutating endpoints accept `Idempotency-Key` header; replays return the original response within 24h.

#### 4.3.2 Endpoints by Actor & Action

##### Auth & Aggregator Registration

| Method | Path                                                            | Actor                      | Description                                                                                                                                                                                                                                                                                                      |
| ------ | --------------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/public/v1/aggregator-registrations/create`                    | Anonymous                  | Submit a registration request via the **single shared form** for both Seeker and Provider aggregator types. Body validated against `aggregator/registration.v1.json` (`aggregator_type` is a body field). Creates `pending` Keycloak user, dispatches admin approval email. Returns `{registration_id, status}`. |
| `GET`  | `/admin/v1/aggregator-registrations/read/{registration_id}`     | Admin (token)              | View a registration request (server-rendered approval page with Approve / Reject buttons).                                                                                                                                                                                                                       |
| `POST` | `/admin/v1/aggregator-registrations/decision/{registration_id}` | Admin (token)              | Single decision endpoint. Body: `{decision: "approve"\|"reject", reason?, token}`. Approve enables the Keycloak user and sends the credentials email. Reject leaves the user `enabled=false` and records the optional reason. The token is consumed on first use.                                                |
| `POST` | `/public/v1/auth/otp/request`                                   | Anonymous                  | `{identifier: <email\|phone>}`. Generates OTP, dispatches via Notification Adapter.                                                                                                                                                                                                                              |
| `POST` | `/public/v1/auth/otp/verify`                                    | Anonymous                  | `{identifier, code}`. On success, returns Keycloak token pair.                                                                                                                                                                                                                                                   |
| `POST` | `/public/v1/auth/password/login`                                | Anonymous                  | `{aggregator_type, org_slug, password}`. Returns Keycloak token pair.                                                                                                                                                                                                                                            |
| `POST` | `/v1/auth/logout`                                               | Aggregator                 | Revokes the Keycloak refresh token.                                                                                                                                                                                                                                                                              |
| `POST` | `/v1/auth/refresh`                                              | Aggregator (refresh token) | Token rotation.                                                                                                                                                                                                                                                                                                  |

##### Aggregator Profile

| Method | Path                                            | Actor      | Description                                                                                                                                                                                                                                                  |
| ------ | ----------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET`  | `/v1/aggregator-profile/read/{aggregator_id}`   | Aggregator | Returns the aggregator's profile (with consent + verified status).                                                                                                                                                                                           |
| `POST` | `/v1/aggregator-profile/update/{aggregator_id}` | Aggregator | Body validated against `aggregator/profile.v1.json`.                                                                                                                                                                                                         |
| `GET`  | `/v1/schemas/read/{actor}/{action}`             | Aggregator | Returns the active JSON Schema. Default response is the schema JSON; `?format=csv` returns a CSV template whose header row is derived from the same schema (used by the bulk-upload UI). ETag-cached. Schemas are platform-scope (no aggregator id in path). |

##### Registration Links

| Method | Path                                             | Actor      | Description                                                                                                                                                                                                            |
| ------ | ------------------------------------------------ | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/v1/links/list/{aggregator_id}`                 | Aggregator | List the aggregator's links. Filter: `?domain=seeker\|provider&status=live\|inactive`.                                                                                                                                 |
| `POST` | `/v1/links/create/{aggregator_id}`               | Aggregator | Create a link under this aggregator. Body validated against `registration-link/create.v1.json`. Server generates QR (PNG and SVG), persists both to MinIO, and returns `{link_id, slug, url, qr_url_png, qr_url_svg}`. |
| `GET`  | `/v1/links/read/{aggregator_id}/{link_id}`       | Aggregator | View link with stats (`registrations_count`, `verified_count`, `last_used_at`) plus the persisted `qr_url_png` and `qr_url_svg`.                                                                                       |
| `POST` | `/v1/links/deactivate/{aggregator_id}/{link_id}` | Aggregator | Deactivate the link.                                                                                                                                                                                                   |

##### Public Registration (Self-Service)

| Method | Path                                     | Actor     | Description                                                                                                                                                                                   |
| ------ | ---------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/public/v1/links/resolve/{slug}`        | Anonymous | Resolves slug → `{aggregator_id, domain, context, schema_url}`. 404 if inactive. Rate-limited 60/min/IP.                                                                                      |
| `POST` | `/public/v1/registrations/create/{slug}` | Anonymous | Body validated against domain's profile schema. Dedupes by phone within the owning aggregator. Emits `INTERACT` (form submit) and `AUDIT` (`state=registered`) with the link slug in `cdata`. |

##### Onboarding — Bulk Upload

| Method | Path                                             | Actor      | Description                                                                                                                                                                                                                                                                                                                                    |
| ------ | ------------------------------------------------ | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/v1/bulk-uploads/create/{aggregator_id}`        | Aggregator | `{participant_type: seeker\|provider}`. Returns `{job_id, upload_url, expires_at}`. The `BulkUploadJob` row is created in `awaiting_upload` state. Processing kicks off automatically on a MinIO bucket-notification event when the CSV finishes uploading — no separate `start` call. Server enforces the 50-row file cap on the worker side. |
| `GET`  | `/v1/bulk-uploads/read/{aggregator_id}/{job_id}` | Aggregator | Returns `{status, rows_total, rows_ok, rows_failed, error_report}`.                                                                                                                                                                                                                                                                            |

##### My Blue Dots — Participants

| Method | Path                                                     | Actor      | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------ | -------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/v1/participants/list/{aggregator_id}`                  | Aggregator | Filtered list. Request body carries the filter set: `{type, status, q, flagged, missing_fields, cursor, limit}` (all optional except `aggregator_id` from the path). Setting `flagged: true` (or supplying `missing_fields: [...]`) is what was previously `/v1/participants/flagged/list`. The same body shape covers future filter additions without new endpoints. CSV export at MVP is a frontend-only render of this result; a server-side export endpoint can be added later if volumes warrant it. |
| `GET`  | `/v1/participants/read/{aggregator_id}/{participant_id}` | Aggregator | Detail view with computed status and recommended action.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

##### Reporting

| Method | Path                                               | Actor      | Description                                                                                                                                                                                                                                                       |
| ------ | -------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/v1/reports/network-summary/read/{aggregator_id}` | Aggregator | Aggregated summary — counts and percentages by participant type and status, plus outcome and gap breakdowns. Single source of truth for the dashboard summary widget and the reporting CSV (`?format=csv`). Replaces the earlier `/v1/participants/summary/read`. |

##### Telemetry

| Method | Path            | Actor                                           | Description                                                                                                                                                                                                                                                                                                     |
| ------ | --------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/v1/telemetry` | Aggregator / Service / Anonymous (rate-limited) | Sunbird Telemetry Spec v3 batch posted by the **Sunbird Telemetry SDK** (`@project-sunbird/telemetry-sdk`): `{id, ver, ets, params, events: [...]}`. The `aggregator_id` is carried in `context.rollup.l1` rather than in the path because telemetry is fire-and-forget and may originate from anonymous flows. |

#### 4.3.3 Sample Request / Response

**Submit aggregator registration (single form, both types):**

```http
POST /public/v1/aggregator-registrations/create
Content-Type: application/json

{
  "aggregator_type": "seeker",
  "data": {
    "department": "Skill Development",
    "institution": "Govt ITI Hubli",
    "contact_name": "Asha Rao",
    "email": "asha@itihubli.gov.in",
    "phone": "+919876543210",
    "password": "<plaintext-tls-encrypted>"
  },
  "consent": { "version": "v1", "accepted_at": "2026-04-27T09:12:00Z" }
}

200 OK
{
  "registration_id": "8f2a1b3c-...",
  "status": "pending",
  "message": "Registration submitted. You will receive credentials by email after approval."
}
```

**Resolve a public link:**

```http
GET /public/v1/links/resolve/join/hubli/krishna-iti

200 OK
{
  "slug": "join/hubli/krishna-iti",
  "aggregator_id": "5b9e1a40-...",
  "domain": "seeker",
  "context": {
    "instance_state": "Karnataka",
    "district": "Hubli",
    "signal_source": "ITI",
    "source_full_name": "Krishna ITI Hubli"
  },
  "schema_url": "/v1/schemas/read/seeker/profile?version=1"
}
```

**List a specific aggregator's links:**

```http
GET /v1/links/list/me?domain=seeker&status=live
Authorization: Bearer <jwt>

200 OK
{
  "items": [
    {
      "link_id": "c1d2...",
      "slug": "join/hubli/krishna-iti",
      "domain": "seeker",
      "status": "live",
      "registrations_count": 142,
      "verified_count": 121,
      "last_used_at": "2026-04-26T18:14:02Z"
    }
  ],
  "next_cursor": null
}
```

**Telemetry batch (public registration submit) — Sunbird Telemetry Spec v3, posted by the Sunbird Telemetry SDK to `POST /v1/telemetry`:**

```json
{
  "id": "api.signal.telemetry",
  "ver": "3.0",
  "ets": 1745740800000,
  "params": { "msgid": "uuid-..." },
  "events": [
    {
      "eid": "INTERACT",
      "ets": 1745740800000,
      "ver": "3.0",
      "mid": "uuid-...",
      "actor": { "id": "anonymous", "type": "User" },
      "context": {
        "channel": "signal-stack-prod",
        "pdata": { "id": "aggregator-app", "ver": "1.0.0", "pid": "web" },
        "env": "onboarding",
        "cdata": [{ "type": "RegistrationLink", "id": "join/hubli/krishna-iti" }],
        "rollup": { "l1": "krishna-iti", "l2": "seeker" }
      },
      "object": { "id": "join/hubli/krishna-iti", "type": "RegistrationLink", "ver": "1" },
      "edata": {
        "type": "SUBMIT",
        "subtype": "public-registration",
        "pageid": "public-registration-form",
        "target": { "id": "submit-button", "type": "button" }
      }
    },
    {
      "eid": "AUDIT",
      "ets": 1745740800100,
      "ver": "3.0",
      "mid": "uuid-...",
      "actor": { "id": "system", "type": "System" },
      "context": {
        "channel": "signal-stack-prod",
        "pdata": { "id": "aggregator-app", "ver": "1.0.0", "pid": "api" },
        "env": "onboarding",
        "cdata": [{ "type": "RegistrationLink", "id": "join/hubli/krishna-iti" }],
        "rollup": { "l1": "krishna-iti", "l2": "seeker" }
      },
      "object": { "id": "<participant-id>", "type": "Participant", "ver": "1" },
      "edata": {
        "state": "registered",
        "prevstate": "",
        "props": ["phone", "name", "domain"]
      }
    }
  ]
}
```

---

## 5. Conclusion

The design above resolves every load-bearing requirement from the MVP PRD with off-the-shelf components and a small amount of bespoke glue. In Blue Dots architecture terms (§1.3, §2.9), it implements components across all four functional layers — **Application**, **Common Services**, **Network Services**, and **Global Services** — at the scope required by the Aggregator App's Register → Add → Track & Operate → Report loop.

**Summary of choices:**

- **Keycloak** for IAM — covers OTP, password, sessions, and JWT issuance with one custom authenticator for OTP delivery via the Notification adapter.
- **JSON Schema (Draft 2020-12) + Ajv + RJSF** — one schema definition drives the form, the API validation, and the bulk-upload validator. Schemas live in a versioned config repo and are served by the Aggregator Service's Schema & Rules module.
- **Declarative JSON rule engine** — first-match-wins evaluator over time-window facts. Status thresholds and recommended-action labels are configuration, not code.
- **Signed-link admin approval** — minimal admin surface with auditability.
- **Public registration links + QR + context cdata** — link metadata is denormalised onto every downstream record and emitted on every telemetry event so reporting metrics ("registrations per link", "completion % per source type") are trivial to derive.
- **Async bulk upload via BullMQ** — pre-signed URL upload, streaming worker, partial-success error reports. Right-sized for the 50-row per-upload cap.
- **Telemetry-first eventing on the Sunbird Telemetry Spec v3** — every action emits a typed envelope with rich context. Analytics run on object-store NDJSON via DuckDB.

**What this buys us:**

- A web app that ships in the MVP window without owning identity, validation, or rules infrastructure that someone else has solved.
- A telemetry corpus that powers reporting from day one.
- A schema and rules layer that lets product evolve registration forms, profile fields, and status policies without engineering work.

**Open items (for product/legal sign-off before build):**

1. Trust-anchor dropdown options (PRD calls these "TBD") — unblocks the Aggregator profile schema v1.
2. Full Seeker and Provider profile field lists — unblocks the public registration schemas.
3. DPDP consent scope and PII access for follow-ups — drives the consent JSONB shape and audit retention policy.
4. Admin email address(es) for the approval flow — deployment config.
5. SMS gateway selection for OTP delivery — the Notification Adapter's interface is fixed; a deployment-time decision selects an SMS gateway behind it. Email is delivered via SMTP (any standard SMTP server) and does not need a separate procurement.

### 5.1 Dev Environment — Prerequisites

Everything below is required before the first product story can be built and run end-to-end against a developer environment. These show up as engineering stories in §5.2.

**Source control & branching**

- Single GitHub mono-repo `signal-stack/aggregator-app` containing the Next.js web app, the NestJS Aggregator Service, the Bulk Upload Worker, JSON Schemas, rule files, and infrastructure code.
- Branch model: trunk-based; PRs to `main`; `dev` environment auto-deploys from `main`.

**CI/CD (GitHub Actions)**

- `ci.yml` — runs on every PR: lint (ESLint/Prettier), typecheck (`tsc --noEmit`), unit tests (Jest), schema validation (every schema in `config/schemas/` parses as Draft 2020-12), API contract tests against an in-memory Postgres.
- `build.yml` — on merge to `main`: builds Docker images for the web app, the API service, and the worker; tags with the short SHA and `dev`; pushes to an OCI-compliant container registry (GitHub Container Registry by default; any registry behind the cluster works).
- `deploy-dev.yml` — on successful `build.yml`: applies the dev-environment Helm release, runs DB migrations, runs smoke tests against the dev URL.
- Required secrets: `REGISTRY_TOKEN`, `KEYCLOAK_ADMIN_PASSWORD`, `DB_PASSWORD`, `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`, `SMTP_PASSWORD`, `SMS_GATEWAY_KEY`. Stored in GitHub Actions environment-scoped secrets.

**Container images**

- Three images: `aggregator-web` (Next.js standalone build), `aggregator-service` (NestJS), `aggregator-worker` (NestJS, different process entry).
- Multi-stage Dockerfiles; non-root user; minimal Alpine / Distroless runtime; image scan via Trivy in `build-images.yml`.

**Infrastructure**

- Provisioned via Terraform in an `infra/` directory of the repo.
- Dev environment: a single Kubernetes cluster (any conformant Kubernetes distribution) with a `dev` namespace.
- In-cluster services at dev: **Postgres 16** (single instance, the same wire protocol as the production YugabyteDB), **Redis 7**, **MinIO**, **Keycloak**. All deployed by the same Helm release.
- Domain: `dev.aggregator.bluedots.in` with TLS via cert-manager + Let's Encrypt.
- Helm charts in `deploy/charts/aggregator-app/` for the three application workloads and the foundational services.

**Configuration & secrets**

- Environment configuration via Helm values (`values-dev.yaml`).
- Runtime secrets via Kubernetes Secrets, populated by the deploy workflow from GitHub Actions secrets.
- Schema and rule config baked into the image at build time (versioned in repo); a runtime overlay path allows hot-swap for ops drills.

**Local developer setup**

- `docker-compose.yml` at the repo root: brings up Postgres, Redis, Keycloak, MinIO, MailHog (local SMTP capture). One command to run.
- `make dev` — runs migrations, seeds a sample aggregator, starts the web app and the API in watch mode.

**Observability (dev)**

- Logs to stdout; collected by **Loki** running in-cluster.
- **Prometheus + Grafana** dashboards: API latency, queue depth, telemetry ingestion rate, DB connections.
- **GlitchTip** (OSS, Sentry-compatible) in-cluster for frontend + backend error tracking.

### 5.2 Story Sequence — to a Working Dev Environment

This is the build order, expressed as engineering stories. Each story is sized to land independently and includes the user-visible acceptance criteria where relevant. There are no fixed timelines — sequencing is what's load-bearing.

**Phase 0 — Foundations**

1. **Repo bootstrap** — mono-repo scaffold (Next.js app, NestJS service, worker entrypoint), shared TypeScript config, ESLint/Prettier, commit hooks.
2. **CI pipeline** — GitHub Actions `ci.yml`: lint, typecheck, unit tests, schema validation. PR checks required.
3. **Dockerise the three services** — multi-stage Dockerfiles for web, service, worker. Local build verified.
4. **Image build & publish workflow** — GitHub Actions `build.yml` pushing tagged images to the OCI registry on every merge to `main`.
5. **Local dev stack** — `docker-compose.yml` with Postgres, Redis, Keycloak, MinIO, MailHog. `make dev` runs the full stack locally.
6. **Terraform: dev infra** — Kubernetes cluster (any conformant distribution), DNS, TLS, namespaces. Output kubeconfig consumed by `deploy-dev.yml`.
7. **Helm charts + dev deploy workflow** — Helm release deploys the three application workloads plus Keycloak, Postgres, Redis, MinIO into the `dev` namespace. `deploy-dev.yml` runs on every successful build. Smoke test passes (`/health` returns 200).

**Phase 1 — Identity & Schemas**

8. **Keycloak realm bring-up** — `signal-stack` realm, `aggregator-web` and `aggregator-api` clients, baseline session policy. Provisioned via the Keycloak admin REST API on first deploy.
9. **Custom OTP authenticator** — Keycloak SPI plug-in that delegates code delivery to the Aggregator Service's Notification adapter. Unit tests + integration test against the local Keycloak.
10. **Schema & Rules module** — `GET /v1/schemas/{actor}/{action}` and rule loader. Schemas and rule files committed under `config/`.
11. **Database migrations** — initial schema for `aggregator`, `registration_link`, `participant`, `participant_activity`, `bulk_upload_job`. Migration runner wired into `deploy-dev.yml`. Migrations run identically against Postgres (local/dev) and YugabyteDB YSQL (staging/prod).

**Phase 2 — Registration, Approval, Login**

12. **Public aggregator registration** — `POST /public/v1/aggregator-registrations/create` validating against the unified `aggregator/registration.v1.json` JSON Schema (single form serving both Seeker and Provider aggregator types); creates `pending` Keycloak user; persists `RegistrationRequest`.
13. **Admin approval flow** — signed-link review page (`GET /admin/v1/aggregator-registrations/read/{id}`) and single decision endpoint (`POST .../decision/{id}`); "credentials ready" email on approve, reason capture on reject.
14. **OTP login** — `POST /public/v1/auth/otp/request` + `…/verify`; integration with the custom Keycloak authenticator.
15. **Password login** — `POST /public/v1/auth/password/login` over Keycloak direct grant.
16. **Logout / refresh** — token rotation and session revocation.

**Phase 3 — Profile, Links, Public Registration**

17. **Aggregator profile** — `GET /v1/aggregator-profile/read/{aggregator_id}` and `POST /v1/aggregator-profile/update/{aggregator_id}` validated against `aggregator/profile.v1.json`.
18. **Registration link CRUD + QR** — list, create, view, deactivate. QR (PNG and SVG) is generated server-side at create time, persisted to MinIO, and surfaced as `qr_url_png` / `qr_url_svg` on the create and read responses (no separate fetch endpoint).
19. **Public link resolve + submit** — `GET /public/v1/links/resolve/{slug}` + `POST /public/v1/registrations/create/{slug}`; dedup on E.164 phone within the owning aggregator; link context denormalised onto the participant record.
20. **Notification adapter** — wraps the configured SMTP server (email) and SMS gateway (SMS); used by OTP, approval emails, credentials emails.

**Phase 4 — Onboarding & Participants**

21. **Bulk upload — create + status APIs** — `POST /v1/bulk-uploads/create/{aggregator_id}` (pre-signed MinIO URL issuance) and `GET /v1/bulk-uploads/read/{aggregator_id}/{job_id}` (job lookup). No separate `start` call — see story 22.
22. **MinIO event-driven enqueue + Bulk upload worker** — wire MinIO `s3:ObjectCreated:Put` notifications to a small handler that flips the job to `queued` and enqueues a BullMQ job. Worker streams CSV parse, per-row validation, dedup, error report; emits telemetry per row outcome.
23. **Schema-driven CSV template** — `GET /v1/schemas/read/{actor}/{action}?format=csv` returns the header row derived from the active schema (no dedicated template endpoint).
24. **Participants list + detail** — single filter-driven `POST /v1/participants/list/{aggregator_id}` (filters: type, status, free-text `q`, `flagged`, `missing_fields`, cursor, limit) plus `GET /v1/participants/read/{aggregator_id}/{participant_id}`. Frontend handles client-side CSV download from list results.
25. **Status & recommended-action engine** — `json-rules-engine` integration; lazy compute on read with cache; invalidation on activity events.

**Phase 5 — My Blue Dots & Reporting**

26. **Network summary endpoint** — `GET /v1/reports/network-summary/read/{aggregator_id}` returns counts and percentages by status and participant type plus outcome and gap breakdowns. Powers both the dashboard summary widget and the CSV export (`?format=csv`).
27. **My Blue Dots UI** — Seeker and Provider tabs, search, filter, table with system-derived recommended actions; client-side CSV download from the participants list; summary widget hits the reports endpoint.

**Phase 6 — Telemetry & Hardening**

28. **Telemetry SDK (frontend)** — integrate the **Sunbird Telemetry SDK** (`@project-sunbird/telemetry-sdk`); initialise once at boot with `pdata`, `channel`, and dispatcher; expose helpers that wrap `Telemetry.impression`, `Telemetry.interact`, `Telemetry.start`, `Telemetry.end`, `Telemetry.error` for the app's pageids and interaction targets.
29. **Telemetry middleware (backend)** — NestJS interceptor that emits `AUDIT` on every persisted state change (aggregator approval, participant registered, link deactivation, bulk job state machine, status flip), `START`/`END` for sessions and bulk jobs, and `ERROR` from the global exception filter. Domain semantics ride in `edata.type`/`edata.state` and `cdata`, not in custom `eid`s.
30. **Telemetry ingestion endpoint + buffer + persistence** — `POST /v1/telemetry` accepting the SDK's Sunbird Telemetry Spec v3 batch shape, Redis buffer, NDJSON persistence to MinIO.
31. **DuckDB report queries** — first set of canonical queries (registrations per link, completion % by source) materialised for the Reporting endpoint.

The dev environment is considered "ready" once stories 1–7 are complete (a deployable empty system) and "feature-complete for MVP" once 1–31 land. Promotion to staging/prod is deliberately out of scope for this story sequence.

---

## 6. Appendix

### 6.1 Technology Choices — One-Line Justifications

| Layer                      | Choice                                  | Why                                                                                                 |
| -------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Web framework              | Next.js 14 (App Router) + TypeScript    | SSR for public registration (SEO + first paint), SPA for authenticated app, single deploy unit      |
| Form rendering             | `@rjsf/core`                            | JSON Schema-native; conditional fields supported; widget customisation via React                    |
| Backend framework          | NestJS (Node.js)                        | Convention over configuration, decorators map cleanly to "actor + action" route shape, easy to test |
| Identity                   | Keycloak (Authentik considered)         | Production-grade OIDC, OTP via custom SPI, mature SPI ecosystem                                     |
| Schema validation          | Ajv (Node)                              | Fastest JSON Schema validator in JS, runs on FE and BE                                              |
| DB (local / dev)           | Postgres 16                             | Stock Postgres for the simplest possible local and dev experience                                   |
| DB (staging / prod)        | YugabyteDB (YSQL — Postgres-compatible) | Drop-in Postgres protocol with horizontal scale and HA for production                               |
| Cache / queue / OTP store  | Redis                                   | One dependency for three jobs                                                                       |
| Background jobs            | BullMQ                                  | Redis-backed, retries + rate limits + observability                                                 |
| Object storage             | MinIO                                   | OSS, S3-API compatible, runs in-cluster                                                             |
| CSV parsing                | Papaparse                               | Streaming, mature                                                                                   |
| QR                         | `qrcode` (Node)                         | Tiny, server-renders SVG and PNG                                                                    |
| Telemetry analytical store | DuckDB                                  | Embedded, cheap, sufficient for MVP volumes                                                         |
| Observability              | Prometheus + Grafana + Loki             | OSS, container-native                                                                               |

### 6.2 Glossary

| Term                | Meaning                                                                                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Aggregator          | Organisation onboarding and representing a group of Seekers or Providers                                                                                  |
| Seeker              | Demand-side participant (e.g. job seeker)                                                                                                                 |
| Provider            | Supply-side participant (e.g. employer)                                                                                                                   |
| Blue Dot            | A participant on the Signal Stack ecosystem                                                                                                               |
| Signal Stack        | The underlying multi-actor platform                                                                                                                       |
| Aggregator App      | The MVP application built on Signal Stack for the Aggregator actor                                                                                        |
| Schema              | A JSON Schema document that defines the fields and validation rules for an actor + action                                                                 |
| Rule                | A declarative condition + outcome used to compute participant status or recommended action                                                                |
| Telemetry           | Structured event data emitted by every meaningful action, conformant to the Sunbird Telemetry Spec v3                                                     |
| `cdata`             | Correlation data — array of `{type, id}` references attached to telemetry context for downstream joins                                                    |
| Blue Dots           | The umbrella programme of domain-specific networks (Blue Dot, Pink Dot, Purple Dot, …) built on the Signal Stack platform                                 |
| Network Facilitator | (Blue Dots architecture) Owns schemas, actor types, interaction rules, and UI rendering rules across a network. Authored under `config/` for MVP          |
| Ecosystem Manager   | (Blue Dots architecture) Owns a boundary within a network (geographic or policy) and onboards aggregators within it. Mapped to "Admin" in this MVP design |
| Service Provider    | (Blue Dots architecture) Third-party service participant (assessment agency, certification body) connecting to either Seekers or Providers                |
| Beckn Fabric        | The shared Global Services rail — Catalog Service, DeDi (Decentralised Directory), Discovery — that enables cross-network discoverability                 |
| DeDi                | Decentralised Directory — the global registry component of Beckn Fabric                                                                                   |
| Onix                | The Beckn protocol client embedded in apps that participate in the Beckn protocol flow (search, connect, fulfill)                                         |

### 6.3 References

- Beckn Protocol Specification — https://becknprotocol.io/
- Sunbird Telemetry Specification v3 — https://telemetry.sunbird.org/learn/specification
- Sunbird Telemetry v3 Event Details (eid enumeration) — https://telemetry.sunbird.org/learn/v3_event_details
- Sunbird Telemetry SDK (npm) — https://www.npmjs.com/package/@project-sunbird/telemetry-sdk
- JSON Schema 2020-12 — https://json-schema.org/draft/2020-12/release-notes
- Keycloak Documentation — https://www.keycloak.org/documentation
- React JSON Schema Form — https://rjsf-team.github.io/react-jsonschema-form/
- BullMQ — https://docs.bullmq.io/
- YugabyteDB YSQL — https://docs.yugabyte.com/preview/api/ysql/
- Sunbird-Obsrv — https://github.com/Sunbird-Obsrv
