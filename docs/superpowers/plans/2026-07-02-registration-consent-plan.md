# Aggregator Registration Consent — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** Versioned, readable, recorded registration consent on **both** aggregator registration forms (Org + Coordinator/aggregator): clickable Terms/Privacy links → read-only popup; per-audience versioned content; append-only `aggregator_consent_record` ledger keyed by `subject_type`+`subject_id`; fixes the org route silently discarding consent.

**Spec:** `docs/superpowers/specs/2026-07-02-registration-consent-design.md`
**Branch:** `feat/registration-consent` (rebased on `feat/aggregator-org-coordinator`).

## Global Constraints (repo rules — non-negotiable)

- **Base-class pattern:** every cross-package contract is an `abstract class` (not a TS `interface`); concrete impls preserve exact signatures. Service packages export `./interface`, `./postgres`|`./memory`, `./testing`; consumers import only `./interface` + `./testing`. `pnpm dep-check` enforces boundaries.
- **Errors:** service-boundary methods return `Result<T, BaseError>` (from `@aggregator-dpg/shared-primitives`) — never throw across a boundary. Every external call: explicit timeout + ≥1 retry + typed error; no empty catches.
- **Logging:** `logger` from `@aggregator-dpg/observability` with `operation`/`status`/`latency_ms`/`error`; **no bare `console.log`**. Never log PII.
- **Config discipline:** no hardcoded env/domain values; read via `@aggregator-dpg/config-loader` / config files.
- **Zod naming:** `<Entity>Schema`, request `<Action>RequestSchema`, `z.infer` type same name w/o `Schema`.
- **Testing:** Vitest; unit tests use in-memory fakes from `./testing` (no real DB/network); integration tests `*.integration.test.ts` excluded from `pnpm -w test`; ≥70% line coverage; fakes extend the in-memory impl + provide `seed()`/`build<Entity>()`.
- **TSDoc** on every public class/method. **Conventional Commits**; do **not** `--no-verify` (husky/lint-staged runs prettier+eslint).
- Node ≥24, pnpm. DB owned by `apps/api`: `pnpm --filter @aggregator-dpg/api db:generate` + `db:migrate`.
- **Audience↔subject mapping:** config `audiences.org` → ledger `subject_type: 'org'` (subject = `aggregator_orgs.id`); config `audiences.aggregator` → `subject_type: 'aggregator'` (subject = `aggregators.id`, the "coordinator" form).

---

## Authored content (operator-facing) — to seed in Task 1

Two audiences × Terms + Privacy. Network/brand display name is interpolated by the seeder (`{{brand}}` → e.g. "Purple Dots"). Markdown, sanitized on render (no raw HTML). v1 = version 1.

### `org` audience

**Terms of Service (org):**

```markdown
## Terms of Service

These terms govern your organisation's registration on **{{brand}}** as a partner organisation. By registering you confirm you are authorised to act for the organisation and that the details you provide are accurate.

### 1. What registration means

Registering creates an organisation account. Your application is reviewed by the {{brand}} team; once approved, your organisation's owner signs in via {{brand}} SSO and can add coordinators/aggregators under the organisation.

### 2. Your responsibilities

- Keep the organisation's details and owner contact accurate.
- Ensure coordinators you add are authorised and use the platform lawfully.
- Do not misuse the platform or the data it makes available.

### 3. Review, suspension & termination

Registration does not guarantee approval. We may decline, suspend, or remove an organisation for inaccurate information, misuse, or activity that harms the network or its participants.

### 4. Service "as is"

The platform is provided on an "as is" and "as available" basis, without warranties, while in active development.

### 5. Governing law

These terms are governed by the laws of India. Questions or grievances: **hello@bluedotseconomy.org**.
```

**Privacy Policy (org):**

```markdown
## Privacy Policy

This explains what **{{brand}}** collects when your organisation registers, why, and your choices.

### What we collect

- **Organisation details** — name, state, and other registration fields you provide.
- **Owner contact** — the registering owner's name, email, and phone (used to create the SSO account and to contact you about the application).

### Why we use it

To review and manage your organisation's participation, create the owner's sign-in account, and let you coordinate aggregators under the organisation.

### Sharing

We do not sell your data. Organisation details are shared only as needed to operate the network (e.g. with the reviewing team and the underlying Signal Stack).

### Your control & retention

To update or remove your organisation's information, contact **hello@bluedotseconomy.org**. We keep it for as long as the organisation participates, except where limited records must be retained to meet legal obligations.

### Grievances

For any privacy question or request, contact **hello@bluedotseconomy.org**.
```

### `aggregator` (coordinator) audience

**Terms of Service (aggregator):**

```markdown
## Terms of Service

These terms govern your registration as a coordinator/aggregator on **{{brand}}** (optionally under a partner organisation). By registering you confirm the details you provide are accurate and that you are authorised to represent the aggregator.

### 1. What registration means

Registering creates an aggregator account. Your application is reviewed by the {{brand}} team; once approved you sign in via {{brand}} SSO and can onboard participants (seekers/providers) into the network.

### 2. Your responsibilities

- Keep your aggregator details and contact accurate.
- Onboard participants lawfully and with their consent; handle their data responsibly.
- Use contact details and network data only for the purpose for which they were shared.

### 3. Review, suspension & termination

Registration does not guarantee approval. We may decline, suspend, or remove an aggregator for inaccurate information, misuse, or activity that harms the network or its participants.

### 4. Service "as is"

The platform is provided on an "as is" and "as available" basis, without warranties, while in active development.

### 5. Governing law

These terms are governed by the laws of India. Questions or grievances: **hello@bluedotseconomy.org**.
```

**Privacy Policy (aggregator):**

```markdown
## Privacy Policy

This explains what **{{brand}}** collects when you register as a coordinator/aggregator, why, and your choices.

### What we collect

- **Aggregator details** — name, type, location(s), and other registration fields you provide.
- **Contact** — your name, email, and phone (used to create your SSO account and to contact you about the application).

### Why we use it

To review and manage your participation as an aggregator, create your sign-in account, and enable you to onboard and manage participants in the network.

### Sharing

We do not sell your data. Your details are shared only as needed to operate the network (the reviewing team and the underlying Signal Stack). Participant data you handle is governed by the participants' own consent captured in Signals.

### Your control & retention

To update or remove your information, contact **hello@bluedotseconomy.org**. We keep it while you participate as an aggregator, except where limited records must be retained to meet legal obligations.

### Grievances

For any privacy question or request, contact **hello@bluedotseconomy.org**.
```

---

## Task 1 — Consent content config + Zod schema + loader

**Files:** `config/<network>/consent.json` per served network (+ per-brand override dirs); a schema+loader in a suitable package (e.g. `packages/config-loader` or `packages/shared-primitives` for the Zod type + a small loader in `apps/api`/`apps/web` shared util). Test: schema validation + loader resolution.

- [ ] **Step 1:** Determine the network/brand dirs present under `config/` (mirror how `resolveSchemaPath` + brands like `purple_dot`, `onetac` resolve). List them; author `consent.json` for each using the templates above (interpolate the brand display name).
- [ ] **Step 2:** `AggregatorConsentConfigSchema` (Zod, repo naming): `{ audiences: { org: AudienceSchema, aggregator: AudienceSchema } }` where `AudienceSchema = { documents: { terms: DocSchema, privacy: DocSchema } }`, `DocSchema = { current_version: int≥1, versions: [{ version:int≥1, title, content, effective_from }] }`, superRefine: `current_version` ∈ `versions`, unique version ints. Export `parseAggregatorConsentConfig`. Put the schema where interface rules allow (only `zod`/`shared-primitives`/`node:*`).
- [ ] **Step 3:** A resolver `loadConsentConfig(network, brand)` that reads `config/<network>/consent.json` (+ brand override deep-merge per audience) and validates. Reused by both the register page (web) and the API routes.
- [ ] **Step 4:** Unit tests — valid config parses; current_version-not-in-versions rejected; brand override merges per audience.
- [ ] **Step 5:** Commit — `feat(config): per-audience versioned consent content + schema/loader`

## Task 2 — `aggregator_consent_record` table

**Files:** `packages/db-schema/src/schema.ts` (+ inferred type export); migration via `db:generate`.

- [ ] **Step 1:** Add the table (spec §5): `id` uuid pk default random; `subjectType` text `subject_type`; `subjectId` uuid `subject_id`; `termsVersion` int; `privacyVersion` int; `network` text; `brand` text null; `source` text; `acceptedAt` timestamptz `accepted_at`; `createdAt` timestamptz default now. Index `(subject_type, subject_id)`. Export the inferred type.
- [ ] **Step 2:** `pnpm --filter @aggregator-dpg/api db:generate` → new migration; `db:migrate` to apply locally.
- [ ] **Step 3:** Commit — `feat(db): aggregator_consent_record ledger table`

## Task 3 — Consent-ledger service (interface + postgres + memory + testing)

**Files:** new package or module following the base-class quartet (mirror an existing writer package, e.g. `packages/participants-writer`). E.g. `packages/consent-ledger/src/{interface,postgres,memory,testing,index}.ts`.

- [ ] **Step 1:** `interface.ts` — `abstract class ConsentLedgerBase` with `abstract recordRegistrationConsent(input: RecordConsentInput): Promise<Result<ConsentRecord, BaseError>>`. Zod: `RecordConsentInputSchema` (`subjectType: 'org'|'aggregator'`, `subjectId`, `network`, `brand?`, `termsVersion`, `privacyVersion`), `ConsentRecordSchema`. Only imports `zod`/`shared-primitives`/`node:*`.
- [ ] **Step 2:** `postgres.ts` — Drizzle impl inserting one row; wraps errors → `DomainError`/`UpstreamError`; structured logging; returns `Result`.
- [ ] **Step 3:** `memory.ts` — in-memory impl; `testing.ts` — `ConsentLedgerFake extends InMemory…` + `seed()` + `buildConsentRecord()`.
- [ ] **Step 4:** Unit tests via the fake; ≥70%. `pnpm dep-check` passes.
- [ ] **Step 5:** Commit — `feat(consent-ledger): subject-polymorphic registration consent writer`

## Task 4 — Record consent in both registration routes

**Files:** `apps/api/src/routes/aggregator-registrations.ts` (coordinator/aggregator) + `apps/api/src/routes/aggregator-orgs.ts` (org). Integration tests `*.integration.test.ts` (or the existing `.test.ts` harness with fakes).

- [ ] **Step 1:** Coordinator route: after the `aggregators` row is created, load consent config (`audiences.aggregator`) for the network/brand, and `recordRegistrationConsent({ subjectType:'aggregator', subjectId: aggregator.id, network, brand, termsVersion: aggregator.current, privacyVersion: privacy.current })`. Keep `stampConsent` → `aggregators.consent` JSONB. Log-and-continue on ledger error (never fail registration).
- [ ] **Step 2:** Org route (`aggregator-orgs.ts`): after `orgStore.create(...)` returns the org, load `audiences.org` config and `recordRegistrationConsent({ subjectType:'org', subjectId: org.id, ... })`. **This fixes the current discard.** Log-and-continue.
- [ ] **Step 3:** Tests: org register → one ledger row (`subject_type: org`); coordinator register → one row (`subject_type: aggregator`) + JSONB still written; ledger-write failure doesn't fail registration. Use the ledger fake.
- [ ] **Step 4:** Commit — `feat(api): record registration consent (org + coordinator) in ledger`

## Task 5 — Web: consent content serving + shared links-widget + ConsentModal

**Files:** `apps/web/.../register/page.tsx`, `registration-shared.ts`, a new `consent/ConsentModal.tsx` + a consent RJSF widget, `RegisterView.tsx`, `OrgRegisterForm.tsx`, `.ui.json` for both forms, i18n `apps/web/src/i18n/messages/{en,hi,kn}.json`. Add markdown renderer dep if none (`react-markdown`+`remark-gfm`).

- [ ] **Step 1:** `page.tsx` — read the resolved `consent.json`; pass `aggregator` audience content to the coordinator content and `org` audience content to `OrgRegisterForm` (via `RegisterView`).
- [ ] **Step 2:** `ConsentModal` — read-only dialog, two tabs (Privacy/Terms), current-version `title` + sanitized Markdown. Dismissible; no auto-open.
- [ ] **Step 3:** Shared consent widget/field (register via each form's `.ui.json` `consent.value.ui:widget`, or a shared field template used by both): renders the required checkbox + label "I have read and accept the [Terms of Service] and [Privacy Policy]" with the two as buttons opening `ConsentModal` for that form's audience content. Checkbox still gates Submit.
- [ ] **Step 4:** i18n keys for link labels + popup chrome (en/hi/kn); document content stays English (from config).
- [ ] **Step 5:** Wire both `RegisterView` (coordinator) + `OrgRegisterForm` to the widget with their audience content. Submit payloads unchanged.
- [ ] **Step 6:** Tests (where a web test harness exists): widget renders clickable links; popup opens on click with the right audience content; checkbox required. `pnpm --filter @aggregator-dpg/web typecheck` + tests pass.
- [ ] **Step 7:** Commit — `feat(web): consent links + read-only popup on both registration forms`

---

## Done — verification

- `pnpm -w typecheck`, `pnpm -w lint`, `pnpm dep-check` clean; affected package tests pass (≥70%).
- API integration: org + coordinator registration each write one `aggregator_consent_record` row with the correct `subject_type` + per-audience versions; org discard fixed; coordinator JSONB unchanged; ledger failure non-fatal.
- Web: both forms show clickable Terms/Privacy links opening a read-only, audience-specific popup; checkbox still required.

## Notes

- v1: no version validation, no login/signin consent, no re-consent. Table is version-ready (per-audience version columns).
- Content is authored generically with `{{brand}}` interpolation; per-network files may diverge later without code changes.
