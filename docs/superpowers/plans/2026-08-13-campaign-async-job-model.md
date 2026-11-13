# Campaign Async Job Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the durable campaign async-job engine (shared request envelope, two Postgres tables, unified `campaign-process` queue/worker, and job-status poll endpoints) in PR #602, migrating the existing PII export onto it so the email (#578) and voice (#577) PRs can build on the same groundwork.

**Architecture:** A campaign request (`POST /v1/campaign/export`) validates a shared envelope `{item_ids, metadata[], content{}}`, deduplicates via an `Idempotency-Key`, passes an ingress rate-limit, then in one transaction inserts a `campaign_job` row plus one `campaign_job_item` row per item and enqueues a single `campaign-process` BullMQ job carrying `{jobId}`. The worker's unified `campaign` role loads the job + its items, runs the channel handler (export = decrypt → CSV → S3 → email link), writes per-item terminal statuses and a heartbeat as it goes, and rolls the job status up from derived item counts. Two GET endpoints project job + item status back to the caller. Counts are always derived (`COUNT(*) GROUP BY status`) — never stored counters — so they can't drift.

**Tech Stack:** TypeScript, Fastify (apps/api), BullMQ + ioredis (apps/worker, packages/queue), Drizzle ORM + Postgres (packages/db-schema, drizzle-kit migrations under apps/api/drizzle/migrations), Zod, Vitest.

## Global Constraints

- **Land everything in PR #602 / branch `feat/579-campaign-pii-export`.** Email (#578) and voice (#577) PRs consume this; do not modify their routes here.
- **Audit log (#617) is OUT OF SCOPE** — deferred to a later PR. Do not add audit tables/handlers.
- **Never log raw contact PII** (name/email/phone values or decrypted item_state). Log counts, ids, and status only.
- **Derived counts only** — never persist a `total`/`succeeded`/`failed` counter column; always `COUNT(*) ... GROUP BY status`.
- **Backwards-compatible response for export** — the export still emails the pre-signed link (existing behaviour) *in addition to* returning `202 {job_id}` and exposing poll endpoints.
- **Commit messages describe WHAT changed** (never "review fixes"). Wrap commit bodies at 100 cols (commitlint `body-max-line-length`).
- **Follow existing store pattern**: base-class + `interface.ts` / `postgres.ts` / `memory.ts` / `testing.ts`, mirroring `apps/api/src/services/bulk-uploads-store/`.
- **Envelope shape (verbatim from the api-contract spec):** `{ "item_ids": string[], "metadata": [{ "key": string, "value": string }], "content": {} }`. For export, `content` is `{}` (no channel content). `metadata` is a free-form list of `{key,value}` pairs — **all pairs sent are stored** as-is on the job (`campaign_job.metadata jsonb`); there is no fixed allow-list.
- **Ordering must be preserved** for stacked branches: no history rewrite on `feat/579-campaign-pii-export`; only add commits.
- **Config knobs (all new, with defaults):** `CAMPAIGN_EXPORT_MAX_ITEMS=5000`, `CAMPAIGN_SUBMIT_WINDOW_SECONDS=60`, `CAMPAIGN_SUBMIT_MAX=10`, `CAMPAIGN_MAX_ACTIVE_PER_ORG=3`, `CAMPAIGN_EXPORT_ATTEMPTS=3`, `CAMPAIGN_EXPORT_DEDUP=false`, `CAMPAIGN_DECRYPT_CHUNK=500`, `CAMPAIGN_CONCURRENCY=2`, `CAMPAIGN_EXPORT_FIELDS=contact` (`contact|full`), `CAMPAIGN_EXPORT_RECIPIENT` (optional override), `EXPORT_NETWORK_ADMIN_EMAIL` (optional fallback recipient).

---

## File Structure

**packages/db-schema/src/**
- `schema.ts` — add `campaignJobStatusEnum`, `campaignJobItemStatusEnum`, `campaignChannelEnum`, `campaignJob`, `campaignJobItem` tables.
- `schema-types.ts` — export inferred `CampaignJob`, `NewCampaignJob`, `CampaignJobItem`, `NewCampaignJobItem`, and the `CampaignMetadataPair` json type.

**apps/api/drizzle/migrations/** — one generated SQL migration (`drizzle-kit generate`).

**apps/api/src/services/campaign-job-store/** (new; mirrors bulk-uploads-store)
- `interface.ts` — `CampaignJobStore` base class + DTOs (`CreateJobInput`, `JobView`, `JobItemView`, `JobStatusCounts`).
- `postgres.ts` — `PostgresCampaignJobStore` (real Drizzle impl; transactional create; derived counts).
- `memory.ts` — `InMemoryCampaignJobStore` (tests/dev).
- `testing.ts` — factory + fixtures.
- `index.ts` — barrel + `getCampaignJobStore()` selector.

**apps/api/src/campaign/** (new; shared envelope)
- `envelope.ts` — `campaignEnvelopeSchema` (Zod) + `parseEnvelope`.
- `errors.ts` re-exports — add codes to `apps/api/src/errors/codes.ts`.

**apps/api/src/routes/campaign-export.ts** — rewrite: envelope parse, idempotency, ingress rate-limit, txn create job+items, enqueue `campaign-process`, `202 {job_id}`.
**apps/api/src/routes/campaign-jobs.ts** (new) — `GET /v1/campaign/export/:job_id` and `GET /v1/campaign/export`.

**packages/queue/src/index.ts** — add `CampaignProcess` queue + `CAMPAIGN_PROCESS_JOB_OPTS`; keep `CampaignExport` export as a deprecated alias only if still referenced, else remove.

**apps/worker/src/**
- `roles.ts` / worker bootstrap — register unified `campaign` role consuming `campaign-process`.
- `services/campaign-process/index.ts` (new) — `runCampaignJob(jobId, deps)`: load job+items, dispatch by channel, write item statuses + heartbeat, roll up job status.
- `services/campaign-process/export-handler.ts` — wraps existing `runExport` logic (moved from `services/campaign-export/`), now item-status aware + chunked decrypt + field-set switch.
- `services/campaign-export/` — deleted (logic moved); update `jobs/campaign-export-process.ts` accordingly.
- `cron-watchdog.ts` — stalled-job sweep via `last_progress_at`.
- `config.ts` — new campaign config knobs.

**infra/env.template**, **apps/*/.env.example**, **local-setup/** compose env — new knobs with defaults.
**openapi.json** — regenerate.

---

## Task 1: Schema — campaign_job + campaign_job_item tables

**Files:**
- Modify: `packages/db-schema/src/schema.ts`
- Modify: `packages/db-schema/src/schema-types.ts`
- Test: `packages/db-schema/src/schema.test.ts` (add cases)
- Generate: `apps/api/drizzle/migrations/NNNN_*.sql` (via drizzle-kit)

**Interfaces:**
- Produces:
  - `campaignJobStatusEnum` values: `'pending' | 'processing' | 'succeeded' | 'partially_failed' | 'failed'`.
  - `campaignJobItemStatusEnum` values: `'pending' | 'resolved' | 'submitted' | 'failed'`.
  - `campaignChannelEnum` values: `'export' | 'email' | 'voice'`.
  - `campaignJob` columns: `id uuid pk`, `aggregatorId uuid notNull`, `signalstackOrgId text notNull`, `channel campaignChannelEnum notNull`, `status campaignJobStatusEnum notNull default 'pending'`, `idempotencyKey text` (nullable), `metadata jsonb $type<CampaignMetadataPair[]> notNull default []`, `content jsonb notNull default {}`, `requestedBy text notNull`, `requestId text`, `errorReason text`, `lastProgressAt timestamptz`, `createdAt`/`updatedAt timestamptz notNull default now()`. Unique index on `(idempotencyKey)` where not null.
  - `campaignJobItem` columns: `id uuid pk`, `jobId uuid notNull references campaignJob(id) on delete cascade`, `itemId text notNull`, `action text` (nullable; export = NULL), `status campaignJobItemStatusEnum notNull default 'pending'`, `errorReason text`, `createdAt`/`updatedAt timestamptz notNull default now()`. Partial unique index `campaign_job_item_active_dedup` on `(itemId, action)` WHERE `status IN ('pending','resolved','submitted') AND action IS NOT NULL`. Index on `(jobId, status)`.
  - Types in schema-types.ts: `CampaignJob`, `NewCampaignJob`, `CampaignJobItem`, `NewCampaignJobItem`, `CampaignMetadataPair = { key: string; value: string }`.

- [ ] **Step 1: Write the failing test** — extend `schema.test.ts`:

```ts
import { campaignJob, campaignJobItem, campaignJobStatusEnum, campaignJobItemStatusEnum, campaignChannelEnum } from './schema.js';
import { getTableConfig } from 'drizzle-orm/pg-core';

describe('campaign_job schema', () => {
  it('exposes the job status + channel enums', () => {
    expect(campaignJobStatusEnum.enumValues).toEqual(['pending','processing','succeeded','partially_failed','failed']);
    expect(campaignJobItemStatusEnum.enumValues).toEqual(['pending','resolved','submitted','failed']);
    expect(campaignChannelEnum.enumValues).toEqual(['export','email','voice']);
  });
  it('campaign_job has the expected columns and defaults', () => {
    const t = getTableConfig(campaignJob);
    const cols = Object.fromEntries(t.columns.map((c) => [c.name, c]));
    expect(cols).toHaveProperty('id');
    expect(cols).toHaveProperty('aggregator_id');
    expect(cols).toHaveProperty('signalstack_org_id');
    expect(cols).toHaveProperty('channel');
    expect(cols).toHaveProperty('status');
    expect(cols).toHaveProperty('idempotency_key');
    expect(cols).toHaveProperty('metadata');
    expect(cols).toHaveProperty('content');
    expect(cols).toHaveProperty('last_progress_at');
    expect(cols.status!.notNull).toBe(true);
  });
  it('campaign_job_item references the job and carries a nullable action', () => {
    const t = getTableConfig(campaignJobItem);
    const cols = Object.fromEntries(t.columns.map((c) => [c.name, c]));
    expect(cols).toHaveProperty('job_id');
    expect(cols).toHaveProperty('item_id');
    expect(cols.action!.notNull).toBe(false);
    expect(cols.status!.notNull).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `pnpm --filter @aggregator-dpg/db-schema test -- schema.test` → FAIL (`campaignJob` not exported).
- [ ] **Step 3: Implement** the enums + two `pgTable` definitions in `schema.ts` (follow the `aggregators`/`bulkUploads` idiom for uuid pk, jsonb `$type`, timestamps, indexes; add the partial-unique index via `.where(sql\`...\`)` in the table's index callback). Add inferred types to `schema-types.ts`.
- [ ] **Step 4: Run test to verify it passes** — same command → PASS.
- [ ] **Step 5: Generate the migration** — `pnpm --filter @aggregator-dpg/api db:generate`; inspect the emitted SQL for both tables, the FK cascade, and the two partial/normal indexes (hand-edit the partial-unique `WHERE` clause into the SQL if drizzle-kit omits it).
- [ ] **Step 6: Commit** — `git add packages/db-schema apps/api/drizzle/migrations && git commit -m "feat(db): add campaign_job and campaign_job_item tables"`.

---

## Task 2: campaign-job-store — interface + in-memory impl

**Files:**
- Create: `apps/api/src/services/campaign-job-store/interface.ts`
- Create: `apps/api/src/services/campaign-job-store/memory.ts`
- Create: `apps/api/src/services/campaign-job-store/testing.ts`
- Test: `apps/api/src/services/campaign-job-store/memory.test.ts`

**Interfaces:**
- Consumes: `CampaignJob`, `CampaignJobItem`, `CampaignMetadataPair` (Task 1).
- Produces:
  - `interface CreateJobInput { aggregatorId; signalstackOrgId; channel: 'export'|'email'|'voice'; metadata: CampaignMetadataPair[]; content: Record<string,unknown>; requestedBy: string; requestId?: string; idempotencyKey?: string; items: Array<{ itemId: string; action: string | null }>; }`
  - `interface JobItemView { itemId: string; action: string | null; status: 'pending'|'resolved'|'submitted'|'failed'; errorReason: string | null; }`
  - `interface JobStatusCounts { total: number; pending: number; resolved: number; submitted: number; failed: number; }`
  - `interface JobView { id; channel; status; metadata; content; errorReason; createdAt; updatedAt; counts: JobStatusCounts; }`
  - `abstract class CampaignJobStore` with:
    - `createJob(input: CreateJobInput): Promise<{ job: CampaignJob; created: boolean }>` — idempotent on `idempotencyKey` (returns existing job + `created:false` on a key hit).
    - `getJob(jobId, orgId): Promise<JobView | null>` — org-scoped.
    - `listJobs(orgId, { channel?, limit?, cursor? }): Promise<{ jobs: JobView[]; nextCursor: string | null }>`.
    - `getJobItems(jobId, orgId): Promise<JobItemView[] | null>`.
    - `markItem(jobId, itemId, status, errorReason?): Promise<void>`.
    - `heartbeat(jobId): Promise<void>` — sets `last_progress_at = now()`.
    - `setJobStatus(jobId, status, errorReason?): Promise<void>`.
    - `rollUpStatus(jobId): Promise<CampaignJob['status']>` — derives status from item counts (all resolved/submitted → `succeeded`; any failed + any success → `partially_failed`; all failed → `failed`; else `processing`).
    - `claimStalledJobs(olderThanSeconds): Promise<string[]>` — processing jobs with stale `last_progress_at`.

- [ ] **Step 1: Write the failing test** (`memory.test.ts`):

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryCampaignJobStore } from './memory.js';
import type { CreateJobInput } from './interface.js';

const base = (): CreateJobInput => ({
  aggregatorId: 'agg-1', signalstackOrgId: 'org-1', channel: 'export',
  metadata: [{ key: 'purpose', value: 'audit' }], content: {},
  requestedBy: 'user@org', items: [{ itemId: 'a', action: null }, { itemId: 'b', action: null }],
});

describe('InMemoryCampaignJobStore', () => {
  let store: InMemoryCampaignJobStore;
  beforeEach(() => { store = new InMemoryCampaignJobStore(); });

  it('creates a job with one item row per item, all pending', async () => {
    const { job, created } = await store.createJob(base());
    expect(created).toBe(true);
    const view = await store.getJob(job.id, 'org-1');
    expect(view!.counts).toEqual({ total: 2, pending: 2, resolved: 0, submitted: 0, failed: 0 });
  });

  it('is idempotent on idempotencyKey (returns the same job, created:false)', async () => {
    const a = await store.createJob({ ...base(), idempotencyKey: 'k1' });
    const b = await store.createJob({ ...base(), idempotencyKey: 'k1' });
    expect(b.created).toBe(false);
    expect(b.job.id).toBe(a.job.id);
  });

  it('scopes getJob to the owning org', async () => {
    const { job } = await store.createJob(base());
    expect(await store.getJob(job.id, 'other-org')).toBeNull();
  });

  it('marks items and rolls up to succeeded when all resolve', async () => {
    const { job } = await store.createJob(base());
    await store.markItem(job.id, 'a', 'resolved');
    await store.markItem(job.id, 'b', 'resolved');
    expect(await store.rollUpStatus(job.id)).toBe('succeeded');
  });

  it('rolls up to partially_failed on mixed outcomes', async () => {
    const { job } = await store.createJob(base());
    await store.markItem(job.id, 'a', 'resolved');
    await store.markItem(job.id, 'b', 'failed', 'not owned');
    expect(await store.rollUpStatus(job.id)).toBe('partially_failed');
    const items = await store.getJobItems(job.id, 'org-1');
    expect(items!.find((i) => i.itemId === 'b')!.errorReason).toBe('not owned');
  });

  it('rolls up to failed when every item fails', async () => {
    const { job } = await store.createJob(base());
    await store.markItem(job.id, 'a', 'failed', 'x');
    await store.markItem(job.id, 'b', 'failed', 'y');
    expect(await store.rollUpStatus(job.id)).toBe('failed');
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter @aggregator-dpg/api test -- campaign-job-store/memory` → FAIL.
- [ ] **Step 3: Implement** `interface.ts` (abstract base with the DTOs above; concrete `rollUpStatus` computed from `getJobItems` counts so both impls share it — make `rollUpStatus` non-abstract calling abstract `getJobItems` + `setJobStatus`) and `memory.ts` (Map-backed).
- [ ] **Step 4: Run to verify it passes** — same → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(api): add campaign-job-store interface and in-memory impl"`.

---

## Task 3: campaign-job-store — Postgres impl

**Files:**
- Create: `apps/api/src/services/campaign-job-store/postgres.ts`
- Create: `apps/api/src/services/campaign-job-store/index.ts`
- Test: `apps/api/src/services/campaign-job-store/postgres.test.ts` (gated on a test DB; mirror how bulk-uploads-store/postgres is tested — if that uses a pg-mem/testcontainer harness, reuse it; otherwise unit-test the query builders against the in-memory contract via a shared conformance suite).

**Interfaces:**
- Consumes: Task 1 tables, Task 2 `CampaignJobStore` base + DTOs.
- Produces: `PostgresCampaignJobStore extends CampaignJobStore`; `getCampaignJobStore(): CampaignJobStore` selector (env-driven, mirroring `bulk-uploads-store/index.ts`).

- [ ] **Step 1:** Write a **shared conformance suite** `conformance.ts` exporting `runStoreConformance(makeStore)` containing the Task-2 behavioural tests, and have `memory.test.ts` + `postgres.test.ts` both call it. Write `postgres.test.ts` first (failing).
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** `postgres.ts`: `createJob` in a Drizzle transaction (insert job → insert items → on `idempotencyKey` conflict `DO NOTHING` then re-select); derived counts via `db.select({ status, n: count() }).from(campaignJobItem).where(eq(jobId)).groupBy(status)`; `markItem` guarded so terminal statuses aren't overwritten (`WHERE status NOT IN ('resolved','submitted','failed')` for forward-only, but allow explicit `failed`); `rollUpStatus` reuses base; `claimStalledJobs` selects `status='processing' AND last_progress_at < now() - interval`.
- [ ] **Step 4: Run to verify it passes** (against the test-DB harness).
- [ ] **Step 5: Commit** — `git commit -m "feat(api): add Postgres campaign-job-store with transactional create and derived counts"`.

---

## Task 4: Shared campaign envelope (Zod) + error codes

**Files:**
- Create: `apps/api/src/campaign/envelope.ts`
- Modify: `apps/api/src/errors/codes.ts`
- Test: `apps/api/src/campaign/envelope.test.ts`

**Interfaces:**
- Produces:
  - `campaignEnvelopeSchema` (Zod) validating `{ item_ids: string[] (1..MAX), metadata: {key,value}[] default [], content: object default {} }`.
  - `type CampaignEnvelope = z.infer<...>`.
  - `parseEnvelope(body, { maxItems }): Result<CampaignEnvelope, EnvelopeError>`.
  - New codes in `errors/codes.ts`: `CAMPAIGN_ENVELOPE_INVALID`, `CAMPAIGN_TOO_MANY_ITEMS`, `CAMPAIGN_RATE_LIMITED`, `CAMPAIGN_JOB_NOT_FOUND`, `CAMPAIGN_ACTIVE_LIMIT`, plus keep `AGGREGATOR_INACTIVE`, `RECIPIENT_UNRESOLVED`.

- [ ] **Step 1: Write failing test** — valid envelope parses; empty `item_ids` rejected; `> maxItems` → `CAMPAIGN_TOO_MANY_ITEMS`; duplicate `item_ids` de-duplicated (preserve order); metadata coerces missing → `[]`; non-string metadata value rejected.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** `envelope.ts` + add codes.
- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat(api): add shared campaign request envelope and error codes"`.

---

## Task 5: packages/queue — CampaignProcess queue

**Files:**
- Modify: `packages/queue/src/index.ts`
- Test: `packages/queue/src/index.test.ts`

**Interfaces:**
- Produces: `CampaignProcess` queue name/const, `CampaignProcessJobData = { jobId: string }`, `CAMPAIGN_PROCESS_JOB_OPTS` (attempts from `CAMPAIGN_EXPORT_ATTEMPTS`, backoff exponential, `removeOnComplete`/`removeOnFail` bounded). Remove the old `CampaignExport` queue export (grep shows only the export route + worker use it — both are rewritten in this plan).

- [ ] **Step 1:** test asserts `CampaignProcess` const + job-opts shape + that `CampaignExport` is gone (or aliased). Run → fail.
- [ ] **Step 2–4:** implement, run → pass.
- [ ] **Step 5: Commit** — `git commit -m "feat(queue): add campaign-process queue, retire campaign-export queue"`.

---

## Task 6: Rewrite POST /v1/campaign/export onto the engine

**Files:**
- Modify: `apps/api/src/routes/campaign-export.ts`
- Modify: `apps/api/src/routes/campaign-export.test.ts`

**Interfaces:**
- Consumes: envelope (Task 4), store (Task 2/3), queue (Task 5), rate-limiter `consume()`.
- Produces: `POST /v1/campaign/export` returning `202 { job_id }`.

Flow: authenticate (azp gate + `aggregator_id`/`signalstack_org_id`/`email` claims) → active-aggregator gate (`AGGREGATOR_INACTIVE`) → `parseEnvelope` → ingress rate-limit `consume(orgId, CAMPAIGN_SUBMIT_MAX, CAMPAIGN_SUBMIT_WINDOW_SECONDS)` → active-job cap (`CAMPAIGN_MAX_ACTIVE_PER_ORG`) → `store.createJob({ channel:'export', items: itemIds.map(id => ({ itemId:id, action:null })), idempotencyKey: header['idempotency-key'], metadata, content:{}, requestedBy: email, ... })` → if `created` enqueue `CampaignProcess {jobId}` → `202 { job_id: job.id }`.

- [ ] **Step 1:** Rewrite the route test: asserts 202 body `{ job_id }`; asserts a `campaign_job` created with one item per id (via injected in-memory store); asserts idempotency-key replay returns the same `job_id` and does **not** enqueue twice; asserts `> CAMPAIGN_EXPORT_MAX_ITEMS` → 400 `CAMPAIGN_TOO_MANY_ITEMS`; asserts rate-limit → 429 `CAMPAIGN_RATE_LIMITED`; asserts inactive aggregator → 403 `AGGREGATOR_INACTIVE`; asserts active-job cap → 429 `CAMPAIGN_ACTIVE_LIMIT`. Run → fail.
- [ ] **Step 2–4:** implement, run → pass.
- [ ] **Step 5: Commit** — `git commit -m "feat(api): route campaign export through the async job engine"`.

---

## Task 7: GET /v1/campaign/export/:job_id + GET /v1/campaign/export

**Files:**
- Create: `apps/api/src/routes/campaign-jobs.ts`
- Register in the api route index.
- Test: `apps/api/src/routes/campaign-jobs.test.ts`

**Interfaces:**
- `GET /v1/campaign/export/:job_id` → `200 { job_id, channel, status, counts, items: [{ item_id, status, error_reason }], metadata, created_at, updated_at }` (org-scoped; 404 `CAMPAIGN_JOB_NOT_FOUND` when not owned/absent).
- `GET /v1/campaign/export?channel=&limit=&cursor=` → `200 { jobs: [{ job_id, channel, status, counts, created_at, updated_at }], next_cursor }` (only the requesting org's jobs).

- [ ] **Step 1:** tests — item-level status + error_reason surfaced on detail; list returns multiple jobs newest-first with counts; cross-org 404 / empty list. Run → fail.
- [ ] **Step 2–4:** implement, run → pass.
- [ ] **Step 5: Commit** — `git commit -m "feat(api): add campaign job status and list endpoints"`.

---

## Task 8: Config knobs (api + worker)

**Files:**
- Modify: `apps/api/src/config.ts`, `apps/worker/src/config.ts`
- Test: add config-parse cases in each app's config test.

**Interfaces:** the Global-Constraints knob list with the stated defaults; validate ranges (positive ints; `CAMPAIGN_EXPORT_FIELDS` ∈ `{contact,full}`; `CAMPAIGN_EXPORT_DEDUP` boolean).

- [ ] **Step 1–5:** failing test for defaults + enum validation → implement → pass → `git commit -m "feat(config): add campaign async-job knobs"`.

---

## Task 9: Worker campaign-process handler + export migration

**Files:**
- Create: `apps/worker/src/services/campaign-process/index.ts`
- Create: `apps/worker/src/services/campaign-process/export-handler.ts`
- Move: `apps/worker/src/services/campaign-export/index.ts` logic into `export-handler.ts` (keep the existing `runExport` unit tests, re-pointed).
- Modify: `apps/worker/src/jobs/campaign-export-process.ts` → `campaign-process.ts` consuming `CampaignProcess`.
- Modify: worker role registration.
- Test: `apps/worker/src/services/campaign-process/index.test.ts` + keep `export-handler` tests.

**Interfaces:**
- Consumes: `CampaignProcessJobData {jobId}`, a worker-side job-store client (read job+items, `markItem`, `heartbeat`, `rollUpStatus`, `setJobStatus`).
- Produces: `runCampaignJob(jobId, deps)`:
  1. load job; if not `pending`/`processing` (already terminal) → return (retry guard).
  2. `setJobStatus(jobId, 'processing')`; dispatch by `job.channel` (`export` → export-handler; email/voice → not-implemented stubs that throw `CHANNEL_NOT_IMPLEMENTED` — those channels' PRs fill them).
  3. export-handler: chunk `itemIds` by `CAMPAIGN_DECRYPT_CHUNK`, decrypt each chunk (field-set from `CAMPAIGN_EXPORT_FIELDS`: `contact` → `fields:[],contact:[name,email,phone]` + `buildContactExportCsv`; `full` → omit `fields` + `buildDecryptedProfilesCsv`), `heartbeat()` per chunk, `markItem(resolved|failed)` per item (skipped/not-owned → `failed` with reason), concat CSV → S3 put → sign → email link to recipient (`CAMPAIGN_EXPORT_RECIPIENT` || token email from `metadata`/`requestedBy` || `EXPORT_NETWORK_ADMIN_EMAIL`).
  4. `rollUpStatus(jobId)`; on thrown infra error set item(s) back appropriately and re-throw so BullMQ retries; on terminal per-item failures leave them `failed` and let roll-up produce `partially_failed`.

- [ ] **Step 1:** test `runCampaignJob`: all-resolve → job `succeeded`, one email sent, items all `resolved`, heartbeats called; mixed skip → `partially_failed` with the skipped item `failed`; decrypt infra error → throws (BullMQ retry) and job left `processing` (not falsely terminal); already-terminal job → no-op; `full` field-set uses the variable-column CSV builder. Run → fail.
- [ ] **Step 2–4:** implement, run → pass. Keep the existing 9 `runExport` tests green under `export-handler`.
- [ ] **Step 5: Commit** — `git commit -m "feat(worker): unified campaign-process handler with item-level status and chunked export"`.

---

## Task 10: Stalled-job watchdog

**Files:**
- Modify: `apps/worker/src/cron-watchdog.ts` (or create if absent)
- Test: watchdog test.

**Interfaces:** periodically `claimStalledJobs(CAMPAIGN_STALL_SECONDS)` → for each, `setJobStatus(jobId,'failed','stalled')` (or re-enqueue once, per spec — set `failed` with reason `stalled` to keep it simple and observable). No PII.

- [ ] **Step 1–5:** failing test (a job with stale `last_progress_at` gets marked `failed:stalled`; a fresh one untouched) → implement → pass → commit `git commit -m "feat(worker): mark stalled campaign jobs failed via watchdog"`.

---

## Task 11: Env templates, compose, OpenAPI regen

**Files:**
- Modify: `infra/env.template`, `apps/api/.env.example`, `apps/worker/.env.example`, `local-setup/` env, `docker-compose*.yml` env passthrough for the new knobs.
- Regenerate: `openapi.json` (new/changed export routes + GET endpoints).

- [ ] **Step 1:** add every new knob with its default + a one-line comment to `infra/env.template` and the `.env.example`s; wire worker/api service env in compose.
- [ ] **Step 2:** run the openapi generation script; verify no unintended drift (only the campaign routes change).
- [ ] **Step 3:** typecheck + full test sweep across changed packages.
- [ ] **Step 4: Commit** — `git commit -m "chore: document campaign async-job env knobs and regenerate openapi"`.

---

## Task 12: Build dist + full validation + PR description

**Files:** none new.

- [ ] **Step 1:** `pnpm --filter "./packages/*" build` (so tsx resolves subpath imports for worker/api at runtime).
- [ ] **Step 2:** `pnpm -w typecheck` and `pnpm -w test` (or per-filter) — all green.
- [ ] **Step 3:** openapi-no-drift check passes.
- [ ] **Step 4:** update the PR #602 description to describe the async-job engine + export migration + the two poll endpoints + new env knobs (WHAT changed, not "review fixes").
- [ ] **Step 5:** push `feat/579-campaign-pii-export`.

---

## Self-Review

**Spec coverage** (api-contract + async-batch specs):
- Shared envelope `{item_ids,metadata,content}` → Task 4. ✅
- 202 + poll endpoints → Tasks 6, 7. ✅
- Per-channel content / unified queue → Tasks 5, 9. ✅
- Config (recipient, field-set, limits) → Task 8. ✅
- Two tables + derived counts → Task 1; derived-count queries → Tasks 2/3. ✅
- Idempotency-Key → Tasks 2/3/6. ✅
- Item-level active dedup partial-unique → Task 1 (index) + Task 3 (create honours it). ✅
- Ingress rate-limit → Task 6. ✅
- Chunked decrypt → Task 9. ✅
- Per-item terminal-status retry guard → Tasks 3 (`markItem` guard) + 9 (already-terminal job no-op). ✅
- Stalled-job watchdog via `last_progress_at` → Tasks 1 (column) + 10. ✅
- Audit log #617 → intentionally OUT (Global Constraints). ✅

**Placeholder scan:** channel `email`/`voice` handlers are deliberate not-implemented stubs (their PRs own them) — that is scope, not a placeholder; the export path is fully specified.

**Type consistency:** `markItem(status)` values match `campaignJobItemStatusEnum`; `rollUpStatus` returns `campaignJobStatusEnum`; `JobStatusCounts` keys match item-status names; `CampaignProcessJobData.jobId` used identically in Tasks 5/6/9.

---

## Execution Handoff

Per the user's standing instruction ("execute end-to-end, no per-phase stops, review at the end"), execute with **superpowers:executing-plans (Inline, batched)** — run Tasks 1→12 in order, committing per task, and report the full result at the end rather than pausing between tasks.
