# Admin approval endpoint auth — design note

Follow-up for GITHUB-ISSUES-COMPILATION.md Issue #2 ("Replace HS256 symmetric authentication with Keycloak-backed RS256" on `/admin/v1/aggregator-registrations/*`).

## Why the literal fix doesn't apply as written

The three admin routes in `apps/api/src/routes/aggregator-approvals.ts` (`read/:id`, `decision/:id`, `renew/:id`) are reached by a human clicking a signed link **from an email**, not by an authenticated API client. They render/accept plain HTML (`renderConfirmPage`/`renderResultPage`), and the only identity check today is `verifyTokenForId()` — an HS256 JWT bound to one specific aggregator id (see `services/approval-token.ts`).

This repo's existing Keycloak verifier (`services/auth/access-token.ts`'s `authenticate`/`requireApproved`) validates an **aggregator's own** session — it requires an `aggregator_id` claim minted for that applicant's login. There is no Keycloak client, login page, or session mechanism anywhere in this repo for a distinct "platform admin / reviewer" persona. Applying `authenticate()` to these routes as-is would require the admin clicking the email link to already be logged in _as an aggregator applicant_, which is incoherent — it doesn't gate anything.

Closing this issue properly means building a **new** admin identity system:

1. A new confidential Keycloak client (e.g. `aggregator-admin`) with its own realm role (e.g. `platform_reviewer`) and human accounts for the ops team who currently just receive the approval emails.
2. A login flow for that client — either a small standalone login page in `apps/api` (server-rendered, matching the existing HTML-page style of these routes) or a new authenticated area in `apps/web`.
3. A session mechanism for the admin browser tab (a signed cookie, following the pattern `apps/web/src/lib/session/` already uses for coordinators) so the admin doesn't have to bearer-auth on every click.
4. Keeping the existing link-token check **in addition** — it still proves "this decision was sent to this specific reviewer for this specific aggregator," which the Keycloak login alone wouldn't.

This is comparable in scope to the org-invite-token design deferred separately (see Issue #13/#18) — a multi-day feature requiring a product/security decision on the login UX, not a middleware wire-up.

## What shipped now instead

`aggregator-approvals.ts` gained structured audit logging (`operation: 'aggregator-approval.audit'`) on all three routes, recording the aggregator id, action, decision (where applicable), request id, and client IP — with an explicit `identity_verified: false` field so the audit trail itself documents that no admin identity is attributable yet, rather than implying stronger attribution than the system has. MFA enforcement mentioned in the original issue is also blocked on the same missing admin-identity system.

## Recommendation

Decide with the security/product team whether to build the admin-SSO system above, or accept the residual risk (link-token possession + audit logging + the rate limiting landing in a separate PR) as sufficient, given the email recipient list is small and internally controlled. If building it, scope it as its own epic under `docs/issues/platform/P-15-security-baseline.md`.
