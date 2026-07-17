# CLAUDE.md — apps/api

Guidance specific to working inside `apps/api`. Read the root `CLAUDE.md` first (product/architecture overview) — this file covers what's non-obvious once you're actually editing files here.

## Auth is consistent but per-file, not framework-enforced

There is no global Fastify `preHandler` hook wired at `app.ts` level. All verification logic lives in one shared module, `services/auth/access-token.ts` (`authenticate`, `requireApproved`, `authenticateAny`), but **each route file re-declares its own thin local wrapper** around it — e.g. `requireAuth()` in `bulk-uploads.ts:769`, `requireApprovedAuth()` + `requireAuth()` in `dashboard.ts:589,610`. Every handler in a file calls its wrapper as its first statement (verified across all route files — no handler currently skips it), so today's code is consistent. But **nothing prevents a new route from omitting the call** — the build succeeds either way. If you add a route file, copy an existing wrapper rather than inventing a new pattern, and call it first in every handler.

Service-account-only endpoints additionally gate on `subject.startsWith('service-account-')` (`aggregator-maintenance.ts:145`) — `authenticateAny` alone accepts both end-user and service-account tokens and doesn't distinguish privilege level.

## Registration status has no documented state machine — here it is

`AggregatorStatus = 'pending' | 'active' | 'inactive' | 'retired'` (`packages/db-schema/src/schema-types.ts:17`) is a bare type union in code with no transition diagram anywhere. In practice:

- **Approve** (`pending → active`) is CAS-guarded: `aggregatorStore.approveFromPending()` (`services/aggregator-store/postgres.ts:189`) does `UPDATE ... WHERE id=? AND status='pending'` — a concurrent double-approve is a no-op on the second call, not a double-provision.
- **Reject** uses a plain `updateStatus` write (no CAS) — safe because rejection has no provisioning side effects to double-fire; a `prior = decisionFromStatus(...)` read-then-check guard runs before either branch regardless.
- `retired` exists in the type but its transition path isn't in the approval routes above — check `aggregator-maintenance.ts` before assuming where it's set.

## Consent-ledger write is fail-closed and ordered before provisioning

`recordAggregatorConsent()` (`routes/aggregator-registrations.ts:310`) calls `getConsentLedger().recordRegistrationConsent(...)` (line 456) **before** Keycloak/profile provisioning. On failure (config load throws, or the ledger write returns `!success`), the caller (`:315-319`) **deletes the just-created aggregator row** (`aggregatorStore.deleteById`) and throws `CONSENT_WRITE_FAILED` — a real rollback, not a log-and-continue. Same pattern in `aggregator-orgs.ts:375`. **Do not reorder this** — provisioning before consent would let a subject exist without a consent record, which is exactly what "fail-closed" is designed to prevent.

## Known gap: Keycloak calls have timeout but no retry — flagged, not fixed here

`.claude/rules/error-handling.md` requires "retry transient failures at least once with exponential backoff" on every external call. `services/idp-admin/keycloak.ts` (582 lines) routes every admin call through `safeFetch` (`:530`), which applies `AbortSignal.timeout(HTTP_TIMEOUT_MS)` uniformly — but **there is no retry loop anywhere in this file**. This is a real, verified deviation from the repo-wide rule, not a doc gap. If you're touching this file for an unrelated reason, don't assume retry exists; if you're adding retry, be aware Keycloak admin calls (user enable, role assign) are not all naturally idempotent — check each call site's side effects before wrapping it in a blind retry.

## Org→coordinator hierarchy: routes 404, not 403, when the flag is off

`routes/aggregator-orgs.ts:74` and `aggregator-org-approvals.ts:66` both `if (!orgHierarchyEnabled()) return;` **before registering any route** — so with the flag off, `/v1/orgs*` and `/admin/v1/orgs*` return Fastify's default 404, not an explicit 403. If you're debugging "why does this org endpoint 404 in this environment," check `ORG_HIERARCHY_ENABLED` before assuming a routing bug. The token↔`parent_org_id` binding is enforced unconditionally regardless of the flag (`aggregator-approvals.ts:190-201`, comment: "independent of the runtime flag") — a data-level invariant, not gated by the feature flag.

## Bulk-upload: the API only validates, reserves, and enqueues

Streaming CSV parsing is entirely `apps/worker`'s job (see `apps/worker/CLAUDE.md`). The API side (`routes/bulk-uploads.ts`) does: presigned S3 PUT → `/start` validates the object exists via `headObject` (size-0 check + `BULK_UPLOAD_MAX_BYTES` as belt-and-braces, since a presigned PUT can't itself cap size) → `store.markUploaded` → `enqueueBulkFileProcess` (`services/bulk-queue/index.ts`, `jobId = uploadId` for idempotent enqueue — a retry of `/start` can't double-enqueue). If enqueue fails after `markUploaded` succeeds, the row is left `uploaded` with no active job — recovery relies on the worker's stuck-job watchdog (`cron-watchdog.ts`, see `apps/worker/CLAUDE.md`), not a retry here.

## Tests

Mixed convention within this app: most route/service files have a sibling `*.test.ts` (e.g. `aggregator-approvals.test.ts`), but several service subpackages use a `__tests__/` folder instead (`services/idp-admin/__tests__/`, `services/aggregator-store/__tests__/`). Either is fine here; match whichever convention the file you're touching already uses. One `.integration.test.ts` exists (`services/idp-admin/keycloak.integration.test.ts`), excluded from `pnpm -w test` per the repo-wide rule.
