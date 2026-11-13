# Onboarding Design — Bulk Upload & QR Link

Design reference for the two onboarding paths an aggregator uses to bring participants (seekers/providers) into the system.

> **Superseded in part — the local `participants` table has been removed.**
>
> This document describes the design as originally built, when both onboarding
> paths UPSERTed into a local `participants` roster. That table was a mirror of
> data Signals already held: it had no reader, and it did not actually prevent
> duplicates — both writers pushed to Signals regardless of the local UPSERT
> result, so a repeat bulk row reported `skipped`/`duplicate` while a second
> Signals profile was created.
>
> Signals is now the sole store of record for participants. Every reference below
> to writing, UPSERTing or deduplicating `participants` — and the
> `link_submissions.participant_id` column — no longer applies. `link_submissions`
> itself is unchanged and still feeds the `link-metrics-rollup` cron. There is
> currently **no deduplication** on either path; adding it is Signals-side work.

```
                              ┌─────────────────┐
                              │   AGGREGATOR    │
                              └────────┬────────┘
                                       │
                ┌──────────────────────┴──────────────────────┐
                │                                             │
                ▼                                             ▼
        ┌──────────────┐                            ┌──────────────────┐
        │ BULK UPLOAD  │                            │   QR / LINK      │
        │    (CSV)     │                            │  (public form)   │
        └──────┬───────┘                            └────────┬─────────┘
               │                                             │
               ▼                                             ▼
        ┌──────────────┐                            ┌──────────────────┐
        │ bulk_uploads │                            │ link_submissions │
        │  (1 row /    │                            │ (1 row / submit, │
        │    CSV)      │                            │   raw payload)   │
        └──────┬───────┘                            └────────┬─────────┘
               │                                             │
       worker: │ bulk-row-process                       │
               │ schema-validate                        │ (sync, same TX as link_submissions)
               │ per CSV row                            │ API public POST handler
               │                                        │  validate → UPSERT participants
               │                                        │
               │                                        │
               │       ╔════════════════════════════════▼══════════════╗
               │       ║                  PARTICIPANTS                 ║
               │       ║              (unified roster box)             ║
               │       ║                                               ║
               │       ║   ┌──────────────────┐   ┌─────────────────┐  ║
               └──────►║   │   participants   │   │  signal_stack   │  ║◄── (future)
                       ║   │  (dedup by agg + │   │ (future — push  │  ║   signal-stack-
                       ║   │   type + pid)    │   │   feed mirror)  │  ║   ingest
                       ║   └────────┬─────────┘   └────────┬────────┘  ║
                       ║            │                      │           ║
                       ╚════════════╪══════════════════════╪═══════════╝
                                    │                      │
                       worker:      │                      │ (future) signal-rollup
                       bulk-finalise│                      │
                       (1 row / CSV)│                      │
                                    ▼                      ▼
                                 ┌──────────────────────────┐
                                 │        onboarding        │◄── cron: link-metrics-rollup
                                 │ (unified metrics rollup) │    (SUM link_submissions
                                 │ source='bulk'|'link'|... │     by link_id + hour-bucket
                                 └──────────────┬───────────┘     — metrics-only,
                                                ▲                  never touches participants)
                                                │
                                         Dashboard reads
```

All `participants` writes are **synchronous** at the boundary that owns each source. No async promotion. Cron is for metrics aggregation only.

| Table              | Bulk writer                 | Link writer                                 | Future signal-stack writer   |
| ------------------ | --------------------------- | ------------------------------------------- | ---------------------------- |
| `bulk_uploads`     | API on `POST /bulk-uploads` | —                                           | —                            |
| `link_submissions` | —                           | API on public POST (sync, same TX as below) | —                            |
| `participants`     | worker `bulk-row-process`   | API on public POST (sync UPSERT)            | (future) signal-stack-ingest |
| `signal_stack`     | —                           | —                                           | (future) signal-stack-ingest |
| `onboarding`       | worker `bulk-finalise`      | cron `link-metrics-rollup` (metrics-only)   | (future) signal-rollup       |

---

## 1. Bulk Upload

CSV-driven, async, signed-URL S3 upload, worker-fanout processing.

### Flow

```
 User              Web             API (Fastify)        S3 (MinIO)     Worker (BullMQ)
   │                │                    │                   │                │
   │ click "Upload" │                    │                   │                │
   │ select CSV     │                    │                   │                │
   │ ──────────────►│ POST /v1/bulk-     │                   │                │
   │                │  uploads           │                   │                │
   │                │ ─────────────────► │ insert bulk_uploads                │
   │                │                    │ (status=pending)  │                │
   │                │ ◄──signed PUT URL  │                   │                │
   │                │                                        │                │
   │                │ ──── PUT raw.csv ─────────────────────►│                │
   │                │ ◄────── 200 OK (ETag) ─────────────────│                │
   │                │                                                         │
   │                │ POST /:id/start    │                                    │
   │                │ ─────────────────► │ HEAD object (verify ETag)          │
   │                │                    │ status=uploaded   │                │
   │                │                    │ enqueue file-process ─────────────►│
   │                │ ◄──202 + status    │                   │                │
   │ ◄──"processing"│                    │                   │                │
   │                │                                                         │ parse CSV
   │                │                                                         │ schema-validate
   │                │                                                         │ status=row_processing
   │                │                                                         │ enqueue N row jobs
   │                │                                                         │
   │                │                                                         │ row-process × N
   │                │                                                         │ upsert participants
   │                │                                                         │
   │ ◄──progress %──│ poll GET /:id      │                                    │
   │   (every 2s)   │ ─────────────────► │ read bulk_uploads │                │ when processed==total
   │                │ ◄──status, counts  │                   │                │  → enqueue finalise
   │                │                                                         │
   │                │                                                         │ finalise:
   │                │                                                         │  status=completed
   │                │                                                         │  errors.csv → S3
   │ ◄──"done"──────│ GET /:id returns status=completed                       │
   │   show errors  │                                                         │
   │   if any       │                                                         │
```

### Endpoints (`apps/api/src/routes/bulk-uploads.ts`)

| Method | Path                              | Purpose                                               |
| ------ | --------------------------------- | ----------------------------------------------------- |
| GET    | `/v1/bulk-uploads/template`       | Download CSV header template for a participant_type   |
| POST   | `/v1/bulk-uploads`                | Reserve row + signed S3 PUT URL                       |
| POST   | `/v1/bulk-uploads/:id/start`      | HEAD object → confirm upload → enqueue File Processor |
| GET    | `/v1/bulk-uploads`                | List per-aggregator uploads (status, counters)        |
| GET    | `/v1/bulk-uploads/:id`            | Single status read for UI polling                     |
| GET    | `/v1/bulk-uploads/:id/errors.csv` | Signed GET URL for per-row error CSV (after finalise) |

All endpoints scope by `aggregator_id` JWT claim. Cross-aggregator access → 403.

### Worker jobs (`apps/worker/src/jobs/`)

| Job                 | Trigger                 | Responsibility                                                              |
| ------------------- | ----------------------- | --------------------------------------------------------------------------- |
| `bulk-file-process` | `/start` enqueues       | Download CSV, parse, schema-validate, fan out row jobs                      |
| `bulk-row-process`  | Per row                 | Upsert `participants` row (dedup on agg+type+participant_id), bump counters |
| `bulk-finalise`     | When `processed==total` | Status=`completed`/`failed`, write errors.csv to S3                         |

### `bulk_uploads` state machine

```
pending  ───PUT───►  uploaded  ───start───►  row_processing  ───all rows done───►  completed
   │                    │                          │                                  ▲
   │                    │                          └────row fails > threshold───►  failed
   └──────PUT timeout───┴──────HEAD missing─────────►  file_failed
```

### Idempotency

- `(aggregator_id, type, participant_id)` unique on participants → re-upload same row is a no-op upsert.

---

## 2. QR / Registration Link

Aggregator creates a public link (with QR PNG); the participant fills a public form. Each submit synchronously validates the payload, UPSERTs into `participants` (dedup'd), and INSERTs a `link_submissions` row with `outcome` already set — all in a single DB transaction. The public user gets an immediate confirmation outcome. A separate batch job — the `link-metrics-rollup` cron — aggregates `link_submissions` into `onboarding` for dashboards; it does not touch `participants`.

### Flow

```
Aggregator           API                  S3              Public user            Worker
    │                 │                    │                   │                    │
    │ POST /v1/links/ │                    │                   │                    │
    │  create         │                    │                   │                    │
    │ ──────────────► │ insert link        │                   │                    │
    │                 │  (status=draft)    │                   │                    │
    │                 │ generate QR PNG    │                   │                    │
    │                 │ ──PUT qr/<id>.png─►│                   │                    │
    │ ◄──link + signed QR URL              │                   │                    │
    │                                                          │                    │
    │ POST /:id/activate                                       │                    │
    │ ──────────────► │ status=live                            │                    │
    │ ◄──ok           │                                        │                    │
    │                                                          │                    │
    │  shares QR / public URL  ───────────────────────────────►│                    │
    │                                                          │ scans / clicks     │
    │                                                          │                    │
    │                 │ GET /public/v1/agg/                    │                    │
    │                 │  :orgSlug/links/:slug  ◄───────────────┤                    │
    │                 │ ──form schema, status─────────────────►│                    │
    │                                                          │ fills form         │
    │                 │ POST /public/v1/agg/                   │                    │
    │                 │  :orgSlug/registrations/:slug ◄────────┤                    │
    │                 │ ┌──── single DB transaction ────┐      │                    │
    │                 │ │ validate schema               │      │                    │
    │                 │ │ UPSERT participants           │      │                    │
    │                 │ │   ON CONFLICT DO NOTHING      │      │                    │
    │                 │ │ INSERT link_submissions       │      │                    │
    │                 │ │   outcome = passed | skipped  │      │                    │
    │                 │ │     | failed                  │      │                    │
    │                 │ │   participant_id = FK         │      │                    │
    │                 │ └───────────────────────────────┘      │                    │
    │                 │ ─────{outcome, submissionId}──────────►│                    │
    │                                                                               │
    │                                                          link-metrics-rollup  │ (cron)
    │                                                          reads link_submissions
    │                                                            WHERE rolled_up_at IS NULL
    │                                                          SUM by (link_id, hour) →
    │                                                            UPSERT onboarding (passed/skipped/failed)
    │                                                          mark link_submissions.rolled_up_at = now()
    │                                                          ⚠ NEVER writes participants
```

> ⚠ **Sync at submit, async metrics.** The public POST handler validates, UPSERTs `participants`, and INSERTs `link_submissions` (with `outcome` populated) atomically in one transaction — the user sees the outcome immediately. The `link-metrics-rollup` cron is metrics-only: it SUMs unconsumed `link_submissions` into the `onboarding` rollup and never modifies `participants`.

### Endpoints

**Aggregator-authenticated** (`apps/api/src/routes/registration-links.ts`):

| Method | Path                       | Purpose                                                |
| ------ | -------------------------- | ------------------------------------------------------ |
| POST   | `/v1/links/create`         | Create link (draft) + generate QR PNG to S3            |
| GET    | `/v1/links`                | List links scoped to aggregator with rolled-up metrics |
| GET    | `/v1/links/:id`            | Single link + signed QR URL                            |
| POST   | `/v1/links/:id/activate`   | draft → live (idempotent)                              |
| POST   | `/v1/links/:id/deactivate` | live → retired (idempotent)                            |

**Public — no auth** (`apps/api/src/routes/public-registration-links.ts`):

| Method | Path                                                  | Purpose                           |
| ------ | ----------------------------------------------------- | --------------------------------- |
| GET    | `/public/v1/aggregators/:orgSlug/links/:slug`         | Fetch form schema + link metadata |
| POST   | `/public/v1/aggregators/:orgSlug/registrations/:slug` | Submit one registration           |

### `registration_links` state machine

```
draft  ──activate──►  live  ──deactivate──►  retired
                       │
                       └──expires_at hit──►  expired (read-only)
```

### Public URL

```
https://<portal>/r/<org_slug>/<link_slug>
```

`(aggregator_id, slug)` is unique. Two aggregators may pick the same human slug because the org_slug is in the path.

### QR PNG

- Key: `qr/<aggregator_id>/<link_id>.png` in S3.
- Generated once at link create. Returned via short-lived signed GET URL on every read (never embedded inline).
- Same key reused on re-issue → idempotent.

### Submission persistence

Each public POST does both in a single DB transaction:

1. Schema-validate the body. On fail → HTTP 400, nothing persisted.
2. UPSERT participants `ON CONFLICT (aggregator_id, type, participant_id) DO NOTHING`.
   - Insert returned a new row → `outcome = passed`, `participant_id` FK = new id.
   - Conflict (already exists) → `outcome = skipped`, FK = existing participant id (SELECT for the id).
   - DB error → `outcome = failed`, FK = NULL.
3. INSERT `link_submissions` with `outcome` and `participant_id` populated.
4. Return `{ outcome, submissionId, participantId }` to the public user.

The `link-metrics-rollup` cron runs later on a schedule (every N min) or row-count threshold. It SUMs unconsumed `link_submissions` by `(link_id, hour-bucket)` and UPSERTs `onboarding`, then marks `rolled_up_at = now()`. Cron never touches `participants` — those writes are owned by the sync handler.

---

## 3. Unified metrics — `onboarding` table

Both paths roll up into a single time-bucketed table the dashboard reads.

```
onboarding (
  aggregator_id, org_slug,
  source = 'bulk' | 'link',
  batch_id  -- bulk_uploads.id when source='bulk'
  link_id   -- registration_links.id when source='link'
  period_start, period_end,
  total, passed, failed, skipped
)
```

Dashboard queries `onboarding` only — no joins across `link_submissions` + `bulk_uploads`.

---

## 4. Tables touched

| Table                | Bulk | Link | Notes                                                                                                 |
| -------------------- | :--: | :--: | ----------------------------------------------------------------------------------------------------- |
| `bulk_uploads`       |  ✓   |      | One row per CSV upload                                                                                |
| `registration_links` |      |  ✓   | One row per public form                                                                               |
| `link_submissions`   |      |  ✓   | One row per public POST (raw + outcome). Used by cron only for metrics aggregation, never deleted.    |
| `participants`       |  ✓   |  ✓   | Dedup'd unified roster. Bulk: `bulk-row-process` worker. Link: API public POST handler (sync UPSERT). |
| `onboarding`         |  ✓   |  ✓   | Unified metrics rollup. Bulk: `bulk-finalise`. Link: `link-metrics-rollup` cron (metrics-only).       |

S3 keys:

| Path                                                  | Path of                             |
| ----------------------------------------------------- | ----------------------------------- |
| `bulk-uploads/<aggregator_id>/<upload_id>/raw.csv`    | Original upload                     |
| `bulk-uploads/<aggregator_id>/<upload_id>/errors.csv` | Per-row errors written by finaliser |
| `qr/<aggregator_id>/<link_id>.png`                    | Registration link QR code           |

All in the single bucket `aggregator-bulk-uploads` (default; `S3_BUCKET` env).

---

## 5. Table schemas

Authoritative defs live in `packages/db-schema/src/schema.ts`. Reproduced below for quick reference. All FKs `ON DELETE CASCADE` to `aggregators` unless noted.

### Enums

```sql
participant_type            : 'seeker' | 'provider'
bulk_upload_status          : 'pending' | 'uploaded' | 'file_validating' | 'file_failed'
                            | 'row_processing' | 'finalising' | 'completed' | 'failed'
registration_link_status    : 'draft' | 'live' | 'retired'
link_submission_outcome     : 'passed' | 'skipped' | 'failed'
onboarding_source           : 'bulk' | 'link'
```

### `bulk_uploads` — one row per CSV

| Column              | Type           | Notes                                          |
| ------------------- | -------------- | ---------------------------------------------- |
| `id`                | uuid PK        | gen_random_uuid()                              |
| `aggregator_id`     | uuid NN FK     | → aggregators.id (CASCADE)                     |
| `participant_type`  | enum NN        | seeker / provider                              |
| `s3_key`            | text NN        | `bulk-uploads/<agg>/<id>/raw.csv`              |
| `s3_etag`           | text           | Set by `/start` after HEAD; NULL while pending |
| `status`            | enum NN        | default `pending`                              |
| `status_reason`     | text           | Failure detail when terminal                   |
| `errors_csv_s3_key` | text           | Written by finaliser                           |
| `schema_id`         | text NN        | e.g. `seeker.v1` — pinned at upload time       |
| `schema_version`    | text NN        |                                                |
| `uploaded_by`       | uuid NN        | KC user id                                     |
| `last_progress_at`  | timestamptz    | Watchdog signal                                |
| `created_at`        | timestamptz NN | now()                                          |
| `updated_at`        | timestamptz NN | now()                                          |
| `completed_at`      | timestamptz    |                                                |

Constraints:

- `UNIQUE (aggregator_id, s3_etag) WHERE status NOT IN ('file_failed','failed')` — re-upload of identical bytes is a no-op while the previous run is live; same bytes after a failed run are allowed.
- Indexes on `(status, last_progress_at)` (watchdog) and `(aggregator_id, status)` (per-tenant queries + concurrency cap).

> **Counters live elsewhere.** `total_rows / passed / failed / skipped` are NOT stored on `bulk_uploads`. During a run they live in Redis (per-row INCR). After `bulk-finalise` they live in the `onboarding` row keyed by `(batch_id, source='bulk')`. Read path: status=`completed` → onboarding; otherwise → Redis.

### `registration_links` — one row per public QR / form

| Column          | Type           | Notes                                                                                        |
| --------------- | -------------- | -------------------------------------------------------------------------------------------- |
| `id`            | uuid PK        | gen_random_uuid()                                                                            |
| `aggregator_id` | uuid NN FK     | → aggregators.id (CASCADE)                                                                   |
| `slug`          | text NN        | Human-readable part of public URL                                                            |
| `domain`        | enum NN        | `participant_type` — what the form collects                                                  |
| `context`       | jsonb NN       | default `{}` — extra link-level metadata, copied into every submission's `metadata_snapshot` |
| `qr_object_key` | text           | `qr/<agg>/<id>.png` once generated                                                           |
| `status`        | enum NN        | default `draft`                                                                              |
| `expires_at`    | timestamptz    | NULL = never expires                                                                         |
| `created_by`    | uuid NN        | KC user id                                                                                   |
| `created_at`    | timestamptz NN | now()                                                                                        |
| `updated_at`    | timestamptz NN | now()                                                                                        |

Constraints:

- `UNIQUE (aggregator_id, slug)` — two aggregators can share the same slug because public URL is `/<org_slug>/<slug>`.
- Index on `(aggregator_id, status)` for the link-list query.

### `link_submissions` — one row per public POST

| Column              | Type           | Notes                                                                                    |
| ------------------- | -------------- | ---------------------------------------------------------------------------------------- |
| `id`                | uuid PK        | gen_random_uuid()                                                                        |
| `link_id`           | uuid NN FK     | → registration_links.id (CASCADE)                                                        |
| `aggregator_id`     | uuid NN FK     | → aggregators.id (CASCADE) — denormalised for tenant scope queries                       |
| `metadata_snapshot` | jsonb NN       | default `{}` — snapshot of `registration_links.context` at submit time                   |
| `submitted_data`    | jsonb NN       | default `{}` — raw form payload                                                          |
| `outcome`           | enum NN        | `passed` / `skipped` / `failed`. Set by the submit handler from the Signals push result. |
| `rolled_up_at`      | timestamptz    | Set by `link-metrics-rollup` cron when consumed into `onboarding`                        |
| `created_at`        | timestamptz NN | now()                                                                                    |

Indexes:

- `(rolled_up_at, created_at)` — rollup pickup, NULLs first.
- `(link_id)` and `(aggregator_id, created_at)` for read paths.

### `participants` — REMOVED (was: deduplicated roster)

> Dropped in migration `0024_drop_participants.sql`. Retained below for historical reference only.

| Column                  | Type           | Notes                                                                                               |
| ----------------------- | -------------- | --------------------------------------------------------------------------------------------------- |
| `id`                    | uuid PK        | gen_random_uuid()                                                                                   |
| `aggregator_id`         | uuid NN FK     | → aggregators.id (CASCADE)                                                                          |
| `type`                  | enum NN        | seeker / provider                                                                                   |
| `participant_id`        | text NN        | Schema-supplied external ID (e.g. roll number)                                                      |
| `data`                  | jsonb NN       | default `{}` — full schema-validated payload                                                        |
| `phone`                 | text           | Normalised E.164                                                                                    |
| `email`                 | text           | Lowercased                                                                                          |
| `source_bulk_upload_id` | uuid FK        | → bulk_uploads.id (SET NULL) — provenance                                                           |
| `source_link_id`        | uuid FK        | → registration_links.id (SET NULL) — provenance, only set when promoted from a link (not on submit) |
| `source_row_index`      | integer        | Row number inside source CSV                                                                        |
| `created_at`            | timestamptz NN | now()                                                                                               |
| `updated_at`            | timestamptz NN | now()                                                                                               |

Constraints:

- `UNIQUE (aggregator_id, type, participant_id)` — dedup key. Re-upload of same external ID under same aggregator+type is a no-op upsert. Seeker and provider can share an external ID without colliding.
- Indexes on `(aggregator_id, phone)`, `(source_bulk_upload_id)`, `(source_link_id)`.

### `onboarding` — unified metrics rollup

| Column          | Type           | Notes                                                  |
| --------------- | -------------- | ------------------------------------------------------ |
| `id`            | uuid PK        | gen_random_uuid()                                      |
| `aggregator_id` | uuid NN FK     | → aggregators.id (CASCADE)                             |
| `org_slug`      | text NN        | Denormalised for dashboard reads                       |
| `source`        | enum NN        | bulk / link                                            |
| `batch_id`      | uuid           | source='bulk': bulk_uploads.id. source='link': NULL    |
| `link_id`       | uuid FK        | → registration_links.id (SET NULL). source='link' only |
| `period_start`  | timestamptz NN | Hour-bucket start for link; upload start for bulk      |
| `period_end`    | timestamptz NN |                                                        |
| `total`         | integer NN     |                                                        |
| `passed`        | integer NN     | default 0                                              |
| `failed`        | integer NN     | default 0                                              |
| `skipped`       | integer NN     | default 0                                              |
| `created_at`    | timestamptz NN | now()                                                  |

Constraints:

- `UNIQUE (batch_id) WHERE source='bulk'` — one row per CSV upload.
- `UNIQUE (aggregator_id, link_id, period_start) WHERE source='link'` — UPSERT target for hour-bucket rollups.
- Indexes on `(aggregator_id, source, period_start)` (dashboard time-series) and `(batch_id)`.

---

## 6. Security boundaries

- **Aggregator endpoints** require approved JWT; every row write filters by `aggregator_id` claim — cross-tenant access is structurally impossible.
- **Public endpoints** scope by `(org_slug, link_slug)` lookup and require `status='live'` + `expires_at` check. No auth, but rate-limited per IP.
- **Signed S3 URLs** are content-type + size constrained at sign time (PUT) and short-TTL (5 min default) for GET.
- Phone / email never logged. Submission body redacted at the logger boundary.

---

## 7. Files of interest

```
apps/api/src/routes/
  bulk-uploads.ts                    bulk endpoints
  registration-links.ts              aggregator link endpoints
  public-registration-links.ts       public form endpoints
  onboarding.ts                      metrics read endpoints

apps/api/src/services/
  object-storage/                    S3 client + signed URL helpers
  bulk-uploads-store/                Drizzle repo for bulk_uploads
  registration-links-store/          Drizzle repo for registration_links
  bulk-queue/                        BullMQ producer (enqueueBulkFileProcess)

apps/worker/src/jobs/
  bulk-file-process.ts               CSV → row jobs
  bulk-row-process.ts                Per row → participants upsert
  bulk-finalise.ts                   Finalise + errors.csv
  link-metrics-rollup.ts             link_submissions → onboarding cron

packages/db-schema/src/schema.ts     All table defs
config/schemas/aggregator/           Participant JSON schemas (seeker, provider)
```
