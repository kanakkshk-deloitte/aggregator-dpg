# Campaign PII Export API — Design (interim)

- **Ticket:** aggregator-dpg#579 (`[campaign-manager] Full participant PII export`)
- **Umbrella:** Blue-Dots-Economy/signals-dpg#237 (Raya & email integrations for campaign management)
- **Date:** 2026-08-07
- **Status:** Approved design, implemented; revised 2026-08-11.
- **Scope:** interim / prototype-grade. Deliberately time-boxed; several production controls are consciously deferred (see §11).

> **Revision — 2026-08-11.** Two of the "clean seams" called out in the original
> §10/§11 have now been taken:
>
> 1. **Auth → Keycloak token (#576, shipped).** The interim `x-org-id` header is
>    gone; the caller org id is the validated token's `signalstack_org_id` claim.
>    Sections referencing `x-org-id` / `MISSING_ORG_ID` below are annotated with
>    the shipped behaviour.
> 2. **Execution → durable BullMQ worker (this revision).** The inline,
>    un-awaited fire-and-forget task is replaced by an enqueue on a dedicated
>    `campaign-export` queue consumed by `apps/worker`. The API now only
>    validates + enqueues and returns `202`; the export runs in the worker with
>    the standard retry/backoff. See §4, §10, §11. **The export _contents_ are
>    unchanged by this revision** — the pending name/email/phone+actions
>    narrowing (the #579 comment) is orthogonal and handled separately.

## In Plain Terms

An external "campaign manager" prototype needs to pull the full participant data
(including personal details) for a set of profiles it owns, so a network admin
can review it. This adds one API to the aggregator: the caller sends a list of
profile ids, the aggregator fetches and decrypts those profiles from Signals,
writes them to a CSV in private cloud storage, and emails a short-lived download
link to a configured network-admin address. The personal data never travels in
the email itself — only a time-limited link — and the caller never receives the
personal data directly.

## 1. Context & existing building blocks

Everything this feature needs already exists in `aggregator-dpg`; nothing new is
required on the Signals side.

- **Signals decrypt** — `POST /api/v1/admin/participant/decrypt` returns the
  **decrypted `item_state`** (public + private fields merged) for a set of
  `item_ids`, scoped by the item creator's `onboarded_by_org_id`. It is reached
  through the aggregator's `signalstack-writer.fetchDecryptedProfiles({ actingOrgId, itemIds })`
  (`packages/signalstack-writer`), which holds the Signals admin key server-side.
  It returns `{ profiles, skipped }` — `skipped` holds ids not found / not owned
  / undecryptable, with **no distinction** (no existence leak).
- **A working sibling** — `POST /v1/dashboard/export/profiles`
  (`apps/api/src/routes/dashboard.ts`) already decrypts selected items and streams
  a CSV to the caller synchronously, using `buildDecryptedProfilesCsv`
  (`apps/api/src/services/profile-csv.ts`). This feature is the async, S3-delivered,
  network-admin-routed evolution of that route.
- **S3** — `apps/api/src/services/object-storage/index.ts` already does presigned
  PUT/GET, `putObject`, and HEAD against the configured `S3_BUCKET` (real S3 in
  prod, MinIO locally).
- **Mailer** — `apps/api/src/services/mailer/` (`getMailer()`, SMTP + SES adapters)
  is the aggregator's own mail path (not the notification-service). Migration to
  notification-service is a separate, later effort.

## 2. Ownership & auth model

> **Shipped (#576):** the interim `x-org-id` header described below was replaced
> by Keycloak Bearer-token auth. The route calls `authenticate(req)` and derives
> the caller org from the token's **`signalstack_org_id`** claim (→ `actingOrgId`);
> a missing/invalid token is `401`, a valid token without the claim is `403`.
> The ownership-scoping guarantee (next bullet) is unchanged — the org id is now
> sourced from a validated claim instead of a trusted header.

- The **only** thing that proves ownership is the Signals decrypt scoping: called
  with `x-acting-org-id = <org's Signals org id>`, Signals returns **only** items
  that org onboarded; everything else lands in `skipped`. So a request can never
  retrieve another org's data.
- **Interim auth** is the `x-org-id` request header carrying the caller's
  **Signals org id**, passed straight through as `actingOrgId`. There is no token
  and no shared secret in the interim. Accepted, recorded risk: anyone who knows a
  valid `org_id` can export **that org's own** data. This is acceptable only for
  local/prototype testing and **must not** ship to production without the Keycloak
  token model (aggregator-dpg#576), at which point the org id comes from the
  validated token claim instead of the header — only the auth preHandler changes.

## 3. Endpoint contract

`POST /v1/campaign/export` (behind the `/backend` ingress prefix). Registered as
its **own route group**, outside the session-auth hook (the external caller has
no session).

**Request**

- Header: `x-org-id: <signals org id>` (required).
- Header (optional): `x-request-id` — propagated to the `signalstack-writer` call
  for cross-service tracing (per the observability rule).
- Body (Zod):
  ```jsonc
  {
    "item_ids": ["<uuid>", "..."], // min 1, max EXPORT_MAX_ITEM_IDS
    "purpose": "campaign audit", // optional free-text
  }
  ```

**Responses (synchronous)**

| Status | Code                    | When                                                                            |
| ------ | ----------------------- | ------------------------------------------------------------------------------- |
| `202`  | —                       | Accepted; export **job enqueued**. Body: `{ "status": "queued", "message": … }` |
| `400`  | `BAD_REQUEST`           | Malformed body, non-uuid ids, empty list, or over `EXPORT_MAX_ITEM_IDS`         |
| `401`  | `UNAUTHORIZED`          | Missing/invalid Bearer token _(shipped; was `MISSING_ORG_ID` / `x-org-id`)_     |
| `403`  | `FORBIDDEN`             | Valid token without a `signalstack_org_id` claim                                |
| `503`  | `EXPORT_NOT_CONFIGURED` | A required dependency is unconfigured (admin email, S3, Signals, or mailer)     |

After `202` the caller receives **no further status** — the export runs in the
worker (with retry) and the only delivery signal is the email to the network
admin. The `202` now means "durably queued" rather than "started in-process".

## 4. Execution model — enqueue (API) → durable worker job

**Revised (2026-08-11): durable BullMQ, not inline fire-and-forget.**

The aggregator already runs this exact split for bulk-upload (_"the API only
validates, reserves, and enqueues"_, `apps/api/CLAUDE.md`); campaign export now
follows the same shape:

- **API side.** After auth + Zod validation, the handler calls
  `enqueueCampaignExport({ orgId, itemIds, purpose?, requestId? })` — a thin
  BullMQ enqueue surface mirroring `services/bulk-queue` — and returns `202`
  immediately. It does **not** touch S3, the mailer, or Signals. The request/
  response contract in §3 is unchanged (still a bare `202 { status, message }`).
- **Queue.** A dedicated `campaign-export` queue + `CampaignExportJob` payload
  in `@aggregator-dpg/queue`. Uses the shared `DEFAULT_JOB_OPTS`
  (**`attempts: 3`, exponential backoff, `removeOnComplete/​Fail` retention**),
  so a transient decrypt / S3 / mail failure is retried rather than silently
  lost. No `jobId` dedup key — repeated calls are intentionally distinct
  exports (§11 idempotency note).
- **Worker side.** A new `export` role in `apps/worker` (see `worker-roles.ts`;
  unset `WORKER_ROLES` still = all roles, so it runs by default) registers a
  `Worker<CampaignExportJob>` whose processor runs `runExport(payload, deps)` —
  the same orchestrator as before, now hosted in the worker and wired with the
  worker's real collaborators (its own S3 client + new presign, the shared
  mailer, its `signalstack` client).

`runExport(params, deps)` itself is unchanged in shape — pure orchestration with
injected collaborators so it stays unit-testable with fakes:
`{ fetchDecryptedProfiles, putObject, signDownloadUrl, sendMail, networkAdminEmail, log }`.
A thrown error from a `deps` collaborator now **propagates out of the job** so
BullMQ records the attempt and retries (previously it was swallowed by the
route's `.catch`); the handled/early-return branches (decrypt `Err`, empty,
mixed-type) still log-and-return without throwing — those are terminal, not
retryable, and must not burn all 3 attempts.

Steps (run in the worker):

1. **Resolve + decrypt** — `ss.fetchDecryptedProfiles({ actingOrgId: orgId, itemIds, requestId })`
   → `{ profiles, skipped }`. On `Err`: log failure, abort (no email).
2. **Empty guard** — `profiles.length === 0` (nothing owned/found): log, **no file,
   no email**, done.
3. **Homogeneity check** — collect distinct `(item_domain, item_type)` across
   resolved profiles. If more than one distinct pair → log error, abort, no email.
   (Only detectable post-decrypt, so it is an async abort. A well-formed request
   from a single aggregator/coordinator is inherently single-domain.)
4. **Build CSV** — `buildDecryptedProfilesCsv(profiles)` (reused). Homogeneous type
   ⇒ stable columns.
5. **Upload** — `putObject('campaign-exports/{orgId}/{ISO-timestamp}.csv', buffer, 'text/csv')`
   into the existing `S3_BUCKET`.
6. **Presign** — new `signExportDownloadUrl(key)` — GET presign, TTL
   `EXPORT_URL_TTL_SECONDS`.
7. **Email** — `mailer.send()` to `EXPORT_NETWORK_ADMIN_EMAIL` (§6 shape).
8. **Log success** — counts + S3 key only. **Never** log `item_state`, PII, or the
   presigned URL.

## 5. CSV format

Straight reuse of `buildDecryptedProfilesCsv`: columns `item_id, item_network,
item_domain, item_type, created_at, updated_at` plus the flattened `item_state`
fields. Single item_type per file ⇒ consistent columns.

## 6. Email format

- **To:** `EXPORT_NETWORK_ADMIN_EMAIL` (may be a comma-separated list).
- **Subject:** `PII export ready — <domain> (<n> records)`.
- **Body (HTML + plain text):**
  - Requested by org: `{orgId}`
  - Purpose: `{purpose || "—"}`
  - Records exported: `{profiles.length}`
  - Skipped (not found / not owned): `{skipped.length}`
  - Download (expires `{expiresAt}`): `{presignedUrl}`
  - Note: the link is time-limited and the file contains personal data.

## 7. Configuration (new env, read once at startup via config)

| Var                          | Meaning                           | Default                                 |
| ---------------------------- | --------------------------------- | --------------------------------------- |
| `EXPORT_NETWORK_ADMIN_EMAIL` | Recipient(s) of the download link | — (unset ⇒ `503 EXPORT_NOT_CONFIGURED`) |
| `EXPORT_MAX_ITEM_IDS`        | Max ids accepted per request      | `500`                                   |
| `EXPORT_URL_TTL_SECONDS`     | Presigned-GET link TTL            | `3600`                                  |

Reused as-is: `S3_BUCKET`, `SIGNALSTACK_BASE_URL` / `SIGNALSTACK_ADMIN_KEY`, the
existing mailer config. The S3 prefix `campaign-exports/` is a code constant.

**Revised (2026-08-11):** because the export now runs in `apps/worker`, these
vars must be present in the **worker's** environment, not the API's:
`EXPORT_NETWORK_ADMIN_EMAIL`, `EXPORT_URL_TTL_SECONDS`, the mailer config
(`MAIL_PROVIDER` + `SMTP_*` / `SES_*`), and the Signals admin creds (the worker
already reads `S3_*` and `SIGNALSTACK_*` for bulk-upload). The **API** keeps only
what the request path needs — `EXPORT_MAX_ITEM_IDS` (request validation) and
`REDIS_URL` (enqueue). Set the `EXPORT_*`/`MAIL_*` vars on **both** if a single
process runs both in dev.

## 8. Error handling

- External calls keep the repo rules (timeout + retry + typed errors). The
  `signalstack-writer` already applies them; `object-storage` / `mailer` use their
  existing wrappers.
- **Sync** failures → `400 / 401 / 503`.
- **Async** failures → structured `logger.error` (`operation`, `status: 'failure'`,
  `error`, `error_type`, `latency_ms`), never re-thrown to the top, never containing
  PII. No retry, no persistence (interim).

## 9. Testing (Vitest)

Service tests inject fakes (`SignalStackWriterFake` seeded with profiles; fake
`storage` and `mailer`):

- Happy path — CSV built, uploaded, email sent with correct counts.
- Partial — some ids `skipped`; skipped count appears in the email; resolved rows
  still exported.
- Empty — 0 resolved ⇒ no upload, no email.
- Mixed type/domain — abort, no email.
- Decrypt `Err` — abort, no email.

Route tests: `202` on valid input; `400` on bad/empty/over-limit body; `401`
missing `x-org-id`; `503` when a dependency is unconfigured. No real network/S3.

## 10. File / module layout (revised 2026-08-11)

The move to the worker forces two things that used to be app-local `apps/api`
services to become shared packages, because the worker cannot import from
`apps/api/src`:

- **`packages/mailer`** — the mailer transport (interface + SMTP + SES + factory
  - `./testing` fake) extracted from `apps/api/src/services/mailer`. It has **no
    app coupling** (reads `process.env` directly), so extraction is mechanical.
    Consumed by `apps/api` (`support`, `aggregator-approvals`, was `campaign-export`)
    **and** `apps/worker`.
- **`packages/profile-csv`** — `buildDecryptedProfilesCsv` extracted from
  `apps/api/src/services/profile-csv`. Still used by `apps/api` `dashboard.ts`
  (the synchronous `/dashboard/export/profiles` route) **and** now the worker job.

```
# shared
packages/queue/src/index.ts                            # + QueueName.CampaignExport + CampaignExportJob
packages/mailer/**                                     # extracted mailer (was apps/api/src/services/mailer)
packages/profile-csv/**                                # extracted CSV builder (was apps/api/src/services/profile-csv)

# API — validate + enqueue only
apps/api/src/routes/campaign-export.ts                 # auth + Zod + enqueueCampaignExport + 202 (no S3/mail/Signals)
apps/api/src/services/campaign-export-queue/index.ts   # enqueueCampaignExport (mirrors services/bulk-queue)
apps/api/src/routes/__tests__/campaign-export.test.ts  # route tests: 202 enqueues, 400/401/403/503
apps/api/src/config.ts                                 # EXPORT_MAX_ITEM_IDS stays; EXPORT_NETWORK_ADMIN_EMAIL/URL_TTL move to worker

# Worker — consume + run the export
apps/worker/src/jobs/campaign-export-process.ts        # processor: build deps → runExport
apps/worker/src/services/campaign-export/index.ts      # runExport orchestrator + renderExportEmail (moved from apps/api)
apps/worker/src/services/campaign-export/__tests__/…   # orchestrator unit tests (moved from apps/api)
apps/worker/src/object-storage.ts                      # + putExportObject() + signExportDownloadUrl() (presign)
apps/worker/src/worker-roles.ts                        # + 'export' role
apps/worker/src/main.ts                                # register Worker<CampaignExportJob> under the export role
apps/worker/src/config.ts (+ env)                      # EXPORT_*, MAIL_*/SMTP_*/SES_*
```

Remaining clean seam: notification-service migration (§11) — swap
`packages/mailer` for the notification client without touching the orchestrator.

## 11. Deferred / out of scope

- **S3 lifecycle auto-delete** — owned by `bluedots-automation` (infra). Until it
  exists, exported objects **persist** in S3 (the presigned link still expires on
  its TTL). Recorded, accepted for interim.
- ~~**Keycloak-token auth** (#576)~~ — **done** (shipped). Org id from the
  `signalstack_org_id` token claim; see §2.
- ~~**Durable execution**~~ — **done** (this revision). The export runs as a
  durable `campaign-export` BullMQ job with 3 attempts + backoff; a worker crash
  mid-export re-runs the job rather than losing it. (Each attempt re-decrypts and
  re-uploads a fresh CSV — acceptable; the object key is timestamped so a retry
  never overwrites a prior attempt's file.)
- **Audit table** — a single unified metadata-audit table is planned later; this
  feature writes no audit row for now.
- **Idempotency key** — still none. No `jobId` dedup on the queue: two identical
  requests enqueue two distinct exports (matches the interim "no persistence to
  dedupe against" stance; revisit with the audit table).
- **Consent / OTP gate** — not required for export in the interim.
- **notification-service** migration — this feature uses the aggregator's own
  mailer.
