# Onboarding Implementation Design

**Scope:** Participant onboarding pipeline covering two sources — **bulk CSV upload** and **public registration link** — with a shared metrics surface.

> **Superseded in part — the local `participant` table has been removed.**
>
> This document describes the design as originally drafted, when both sources
> INSERTed into a local `participant` table with
> `ON CONFLICT (aggregator_id, participant_id) DO NOTHING` and counted a conflict
> as `skipped` / `duplicate`.
> That mirror (built as `participants`) was dropped in migration 0024 (#819).
>
> Signals is now the only participant record. Every reference below to inserting
> into, deduplicating against, or securing a local `participant` table no longer
> applies. There is **no local deduplication** on either path: a bulk row's
> outcome is Signals' verdict, and Signals rejections such as `DOMAIN_LOCKED`,
> `USER_ALREADY_EXISTS` and `IDENTITY_CONFLICT` are what errors.csv categorises
> as `duplicate` (`SIGNALS_REJECTION_CATEGORY` in
> `apps/worker/src/jobs/bulk-row-process.ts`).

**Status:** Draft.

**Date:** 2026-05-08.

---

## 1. Goal

A single design that handles both onboarding sources end-to-end with a lightweight API and clear worker boundaries. Bulk routes through three workers (file → row → finalise inline). Link routes through the API synchronously (one record per submit) with a separate metrics worker handling rollups. Both write final domain data to the same `participant` table and feed metrics into the same `onboarding` table.

Asymmetric API stance is intentional: API stays lightweight for bulk (the volume problem) and stays sync-validating for link (one record, cheap).

---

## 2. High-Level Flow

```
                 ┌────────────────────────────────────────────────┐
                 │         JSON Schema (config files)             │
                 │   config/schemas/{actor}/{action}.v{N}.json    │
                 └───────────────┬───────┬────────────────────────┘
                                 │       │
            ┌────────────────────┘       └─────────────────────┐
            │                                                  │
            ▼                                                  ▼
┌───────────────────────────┐                 ┌──────────────────────────────┐
│  SOURCE A — BULK UPLOAD   │                 │  SOURCE B — REGISTRATION LINK │
│                           │                 │                              │
│  Browser → S3 (PUT)       │                 │  Browser → BFF → API         │
│  Browser → API: /start    │                 │  POST /public/v1/            │
│                           │                 │   registrations/create/{slug}│
│  ─ API writes bulk_upload │                 │                              │
│  ─ API enqueues file-proc │                 │  ─ API does ALL sync:        │
│                           │                 │    validate, dedup,          │
│  ┌─────────────────────┐  │                 │    INSERT participant,       │
│  │ FILE PROCESSOR      │  │                 │    INSERT link_submission    │
│  │ download + validate │  │                 │                              │
│  │ file-level only     │  │                 │  ─ return 200 + ids          │
│  └──────────┬──────────┘  │                 │                              │
│             │              │                 └────────────┬────────────────┘
│             ▼              │                              │
│  ┌─────────────────────┐  │                              │ (every 5 min OR
│  │ ROW PROCESSOR       │  │                              │  100-row threshold)
│  │ validate + persist  │  │                              ▼
│  │ Lua atomic counters │  │                 ┌────────────────────────────┐
│  │ Redis errors HASH   │  │                 │ METRICS AGGREGATOR Worker  │
│  │ on last row →       │  │                 │ - SELECT new submissions   │
│  │   finalise inline   │  │                 │ - aggregate by hour-bucket │
│  └──────────┬──────────┘  │                 │ - INSERT onboarding rows   │
│             │              │                 │ - mark rolled_up_at        │
│             ▼              │                 └────────────┬───────────────┘
│  Finalise (inline):        │                              │
│  - errors.csv → S3         │                              │
│  - INSERT onboarding row   │                              │
│  - DEL Redis               │                              │
└─────────────┬──────────────┘                              │
              │                                             │
              └────────────────────┬────────────────────────┘
                                   ▼
                       ┌──────────────────────┐
                       │  participant         │  (final domain data)
                       │  + onboarding        │  (unified metrics)
                       └──────────────────────┘
                                   │
                                   ▼
                            UI dashboards
```

JSON Schema is a configuration resource the API and workers load at startup. Not a flow stage.

---

## 3. Source A — Bulk CSV Upload

### 3.1 Browser → S3

1. API issues a pre-signed S3 PUT URL with constraints baked in: `Content-Type: text/csv`, `Content-Length-Range: 0..10MB`, TTL 15 minutes.
2. Browser uploads CSV directly to S3.
3. Browser calls `POST /v1/bulk-uploads/:id/start`. API HEADs the S3 object, captures the ETag, transitions `bulk_upload.status = 'uploaded'`, and enqueues a `bulk-file-process` job.

### 3.2 File Processor (Worker 1)

File-level checks only. One job per upload.

1. Download CSV from S3.
2. Detect BOM and reject non-UTF-8 with reason `encoding_unsupported`.
3. Parse header row; validate against active schema for `participant_type`. Reject with reason `header_mismatch` if required columns missing or unknown columns present.
4. Pin `bulk_upload.schema_id` + `schema_version` for this run.
5. Count rows; reject if `total == 0` (`empty_csv`) or `total > BULK_MAX_ROWS` (`row_cap_exceeded`).
6. Reject any row > 64KB at parse time (`row_size_exceeded`) — guards against Redis blowup.
7. On any failure: `bulk_upload.status='file_failed'`, set `status_reason`, exit. No row jobs enqueued. Empty `errors.csv` materialised so the user gets a download with the rejection reason at the top.
8. On success: stream rows; for each row enqueue `bulk-row-process` with `{ upload_id, row_index, raw_row, payload }`. After last enqueue, `HSET bu:{id}:meta total_rows=N` then `HSET bu:{id}:meta reader_done=1`. Update `bulk_upload.status='row_processing'`.

The `total_rows` and `reader_done` flags are written ONLY AFTER all row jobs are enqueued, preventing premature finalisation if File Processor crashes mid-stream.

### 3.3 Row Processor (Worker 2, concurrency N)

Per-row processing. Many jobs per upload, processed in parallel.

1. Pull `{ upload_id, row_index, raw_row, payload }`.
2. Validate against the schema pinned on `bulk_upload` (Ajv compiled once, cached per worker).
3. Normalise phone (E.164) and email (lowercase).
4. `INSERT participant ... ON CONFLICT (aggregator_id, participant_id) DO NOTHING`. Capture whether the row was inserted (passed) or skipped (duplicate).
5. Run the atomic Lua script (§9) to SADD `processed_rows`, INCR the right counter, HSET error details (if any), and return `(processed_count, total, reader_done)` in one round-trip.
6. If `processed_count == total && reader_done == 1`, enqueue `bulk-finalise` with `jobId = ${upload_id}:finalise`. BullMQ deduplicates; only the worker that hits equality first triggers.
7. Every 500 rows, flush Redis counters into `bulk_upload.passed/failed/skipped` and update `last_progress_at = NOW()` (powers the stuck-job watchdog).

### 3.4 Finaliser (inline path on the last Row Processor)

Triggered once per upload via the dedicated `bulk-finalise` queue.

1. `HSCAN bu:{id}:errors` (cursor-based, memory-bounded) → stream into `errors.csv` on S3 multipart upload. Key: `bulk-uploads/{upload_id}/errors.csv` (deterministic; replay overwrites identical bytes).
2. CSV format: original CSV header columns + `error_category` + `error_reason`.
3. UPDATE `bulk_upload`: `status='completed'`, final counters from Redis `counters` HASH, `errors_csv_s3_key`, `completed_at`.
4. INSERT `onboarding` summary row: `source='bulk', batch_id=upload_id, total/passed/failed/skipped`.
5. `DEL bu:{upload_id}:*` — clean Redis (only after steps 1-4 succeed).
6. Emit AUDIT telemetry summarising the run (idempotent on `upload_id`).

Finaliser is its own queue (concurrency 1 per upload) — separated from row processors so a slow S3 multipart write doesn't block a row-worker slot.

---

## 4. Source B — Registration Link

### 4.1 Link Creation

Aggregator creates a link via authenticated API. Stored in `registration_link` (slug, status, context). Status lifecycle: `draft → live → retired`. Only `live` links accept submissions; `draft` 404s, `retired` returns 410 Gone.

QR code is **not persisted** (#650). It is a deterministic function of `public_url`, so the admin UI generates the PNG in the browser (`qrcode`) and downloads it on demand — no S3 write, no presigned URL, no TTL expiry. Activating a link therefore does no object-storage work and never fails on an unreachable bucket. The nullable `qr_object_key` column and the `qr_url`/`qr_expires_at` response fields (always `null`) remain for one release for backward compatibility and will be dropped in a follow-up.

### 4.2 Public Submission (sync API)

Single-record path. Validation, dedup, and persistence all happen in the API request handler — cheap for one row, immediate UX feedback for the user.

```
POST /public/v1/registrations/create/{slug}    (BFF-fronted, anonymous)

API:
  1. Resolve slug → registration_link row. Reject if status != 'live' (410 Gone).
  2. Verify CAPTCHA (Cloudflare Turnstile token from BFF).
  3. Validate body against active schema for the link's domain (Ajv).
  4. Normalise phone (E.164) and email (lowercase).
  5. INSERT participant ... ON CONFLICT (aggregator_id, participant_id) DO NOTHING.
       └─ conflict → 409 with "already registered"; outcome='skipped'
  6. INSERT link_submission (link_id, aggregator_id, submitted_data,
                             metadata_snapshot, outcome, participant_id).
  7. Return 200 + { submission_id, participant_id }.
```

Mid-run errors not applicable — this path is one record. If validation fails → 400 sync. If dedup hits → 409 sync. If system error → 500 sync.

### 4.3 Metrics Aggregator (Worker 3)

Periodically rolls up `link_submission` rows into `onboarding` for UI dashboards. Triggered by 5-minute cron AND by 100-row threshold per aggregator (whichever fires first).

```
1. SELECT * FROM link_submission
   WHERE rolled_up_at IS NULL
   ORDER BY created_at LIMIT 1000.
2. Aggregate by (aggregator_id, link_id, hour_bucket).
3. INSERT INTO onboarding (source='link', aggregator_id, batch_id=NULL,
                          period_start, period_end, total, passed, failed, skipped)
   ON CONFLICT (aggregator_id, source, period_start, link_id) DO UPDATE
   SET total = onboarding.total + EXCLUDED.total,
       passed = onboarding.passed + EXCLUDED.passed, ...
4. UPDATE link_submission SET rolled_up_at = NOW()
   WHERE id IN (...).
```

Idempotent. Restart-safe via `rolled_up_at IS NULL` filter.

---

## 5. Tables

### `bulk_upload`

```
id                    UUID PK    (= upload_id)
aggregator_id         UUID FK
participant_type      seeker | provider
s3_key                TEXT       (S3 path of original CSV)
s3_etag               TEXT       (S3 ETag, captured at /start)
status                pending | uploaded | file_validating | file_failed
                      | row_processing | finalising | completed | failed
status_reason         TEXT NULL
total_rows            INT NULL
passed                INT NOT NULL DEFAULT 0
failed                INT NOT NULL DEFAULT 0
skipped               INT NOT NULL DEFAULT 0
errors_csv_s3_key     TEXT NULL
schema_id             TEXT NOT NULL
schema_version        TEXT NOT NULL
uploaded_by           UUID NOT NULL
last_progress_at      TIMESTAMPTZ NULL
created_at, updated_at, completed_at

UNIQUE (aggregator_id, s3_etag)
INDEX  (status, last_progress_at)
INDEX  (aggregator_id, status)
```

### `registration_link`

```
id                    UUID PK
aggregator_id         UUID FK
slug                  TEXT NOT NULL
domain                seeker | provider
context               JSONB        (state, district, signal_source, campaign)
qr_object_key         TEXT NULL     (legacy; unused since #650 — QR is client-side. Drop in follow-up)
status                draft | live | retired
expires_at            TIMESTAMPTZ NULL
created_by            UUID NOT NULL
created_at, updated_at

UNIQUE (slug)
INDEX  (aggregator_id, status)
```

### `link_submission`

```
id                    UUID PK
link_id               UUID FK → registration_link
aggregator_id         UUID FK
participant_id        UUID FK NULL    (set when outcome='passed')
metadata_snapshot     JSONB           (link.context at submit time)
submitted_data        JSONB           (validated form payload)
outcome               passed | skipped | failed
created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
rolled_up_at          TIMESTAMPTZ NULL

INDEX (rolled_up_at NULLS FIRST, created_at)
INDEX (link_id)
INDEX (aggregator_id, created_at)
```

### `participant` (existing, additions)

```
... existing fields ...
participant_id          TEXT NOT NULL          (schema-supplied unique id)
source_bulk_upload_id   UUID FK → bulk_upload(id)  NULL
source_link_id          UUID FK → registration_link(id)  NULL
source_row_index        INT  NULL              (bulk only)

UNIQUE (aggregator_id, participant_id)
```

Phone is no longer a unique key. Phone stays as an indexed searchable field.

### `onboarding` (unified metrics)

```
id                    UUID PK
aggregator_id         UUID FK
org_slug              TEXT
source                bulk | link
batch_id              UUID NULL        (bulk_upload.id for source='bulk'; NULL for link)
link_id               UUID NULL        (registration_link.id for source='link'; NULL for bulk)
period_start          TIMESTAMPTZ      (hour-bucket start for link; upload created_at for bulk)
period_end            TIMESTAMPTZ      (hour-bucket end for link; upload completed_at for bulk)
total                 INT NOT NULL
passed                INT NOT NULL DEFAULT 0
failed                INT NOT NULL DEFAULT 0
skipped               INT NOT NULL DEFAULT 0
created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()

UNIQUE (aggregator_id, source, period_start, link_id)   -- supports UPSERT
INDEX  (aggregator_id, source, period_start)
INDEX  (batch_id)
```

UI queries: `SELECT SUM(passed) FROM onboarding WHERE aggregator_id = $1 AND source = 'bulk' AND created_at >= NOW() - INTERVAL '30 days'`.

---

## 6. Redis Key Map (bulk only)

All keys namespaced `bu:{upload_id}:`. Link path doesn't use Redis — it's sync at the API.

| Key          | Type | Purpose                                                               |
| ------------ | ---- | --------------------------------------------------------------------- |
| `meta`       | HASH | Fields: `total_rows`, `reader_done`, `started_at`                     |
| `processed`  | SET  | Row indices that have completed. SADD return value drives idempotency |
| `counters`   | HASH | Fields: `passed`, `failed`, `skipped`                                 |
| `errors`     | HASH | `row_index → JSON {raw_row, reasons, error_category}`                 |
| `error_rows` | SET  | Row indices with errors (drives errors.csv ordering)                  |

24-hour TTL fallback after finalisation (`DEL` is the primary cleanup). Redis AOF persistence required (`appendonly yes`, `appendfsync everysec`).

---

## 7. BullMQ Queues

| Queue                 | Concurrency              | Role                                                                                                          |
| --------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `bulk-file-process`   | 2 (per aggregator group) | One job per upload. File Processor — file-level checks.                                                       |
| `bulk-row-process`    | 10 (across replicas)     | One job per CSV row. Row Processor — validates, persists, increments counters, triggers finalise on last row. |
| `bulk-finalise`       | 1 per upload             | One job per upload. Finaliser — errors.csv, UPDATE bulk_upload, INSERT onboarding, DEL Redis.                 |
| `link-metrics-rollup` | 1 per tick               | Periodic (5-min cron + 100-row threshold). Metrics Aggregator — link_submission → onboarding.                 |

`jobId` patterns:

- `bulk-file-process`: `${upload_id}` (idempotent)
- `bulk-row-process`: `${upload_id}:${row_index}` (idempotent replay)
- `bulk-finalise`: `${upload_id}:finalise` (exactly-one)
- `link-metrics-rollup`: `${aggregator_id}:${tick_timestamp}` (idempotent ticks)

`removeOnComplete: { age: 3600 }`, `removeOnFail: { age: 604800 }`.

---

## 8. Worker Boundaries (concise)

| Worker                 | Inputs                   | Side effects                                                    | Outputs                                 |
| ---------------------- | ------------------------ | --------------------------------------------------------------- | --------------------------------------- |
| **File Processor**     | S3 CSV object key        | UPDATE bulk_upload status, schema pin                           | enqueues N row jobs OR terminal failure |
| **Row Processor**      | per-row payload          | INSERT participant; Redis Lua atomic write                      | enqueues finaliser when last row        |
| **Finaliser**          | upload_id                | S3 errors.csv; UPDATE bulk_upload; INSERT onboarding; DEL Redis | telemetry                               |
| **Metrics Aggregator** | new link_submission rows | INSERT onboarding; UPDATE rolled_up_at                          | none                                    |

Schema validation and Ajv compile live in worker bootstrap (not API). API never reads Redis.

---

## 9. Atomic Lua Script — Counter Race Fix

The Row Processor must SADD the row index, INCR the right counter, and HSET the error (if any) atomically. Otherwise:

```
Worker A: SADD row 7 → returns 1
Worker A: 💥 crash before INCR
Worker B: SADD row 7 → returns 0, exits early
Result: row 7 in `processed` but counted nowhere.
```

### Script `bulk_row_commit.lua`

KEYS:

- `KEYS[1] = bu:{id}:processed`
- `KEYS[2] = bu:{id}:counters`
- `KEYS[3] = bu:{id}:errors`
- `KEYS[4] = bu:{id}:error_rows`
- `KEYS[5] = bu:{id}:meta`

ARGV:

- `ARGV[1] = row_index`
- `ARGV[2] = outcome` ∈ `{passed, failed, skipped}`
- `ARGV[3] = error_payload_json` (empty if outcome == passed)

Behaviour:

1. `local added = redis.call('SADD', KEYS[1], ARGV[1])`
2. If `added == 0` → row already committed; return current `(SCARD, total, reader_done)`.
3. `redis.call('HINCRBY', KEYS[2], ARGV[2], 1)`
4. If `outcome != "passed"`:
   - `redis.call('HSET', KEYS[3], ARGV[1], ARGV[3])`
   - `redis.call('SADD', KEYS[4], ARGV[1])`
5. Return `{ SCARD KEYS[1], HGET KEYS[5] total_rows, HGET KEYS[5] reader_done }`.

Cached via `EVALSHA`. Reload on `NOSCRIPT`.

---

## 10. Idempotency

| Concern                                      | Mechanism                                                                                             |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Same row processed twice (BullMQ replay)     | Lua `SADD` returns 0; worker exits before counter increment                                           |
| Same row jobId enqueued twice                | BullMQ deduplicates by `jobId = ${upload_id}:${row_index}`                                            |
| Same CSV uploaded twice                      | `bulk_upload` UNIQUE `(aggregator_id, s3_etag)` — second upload returns existing row                  |
| Same person twice (any source)               | `participant` UNIQUE `(aggregator_id, participant_id)` + ON CONFLICT DO NOTHING; counted as `skipped` |
| Multiple processors hit `processed == total` | BullMQ `jobId = ${upload_id}:finalise` — exactly-one finaliser                                        |
| Finaliser dies mid-write                     | Replay overwrites deterministic S3 key; UPDATE + DEL idempotent                                       |
| Reader crash mid-enqueue                     | `total_rows` + `reader_done` set ONLY after all enqueues; finalise can't trigger early                |
| Redis restart                                | AOF restores keys; `everysec` may lose <1s; row jobs replay safely via Lua dedup                      |
| Link submission retry                        | Client `Idempotency-Key` header → API caches response 24h                                             |
| Metrics rollup re-runs                       | `rolled_up_at` filter + UPSERT on `onboarding` UNIQUE — safe replay                                   |

---

## 11. Status Delivery (DB-only)

All endpoints validate `req.auth.aggregator_id` matches the resource. Mismatch → 403. Postgres row-level security as defence-in-depth.

```
Bulk:
  POST   /v1/bulk-uploads                       → pre-signed PUT URL
  POST   /v1/bulk-uploads/:id/start             → confirms ETag, enqueues
  GET    /v1/bulk-uploads/:id                   → DB read only
  GET    /v1/bulk-uploads/:id/errors.csv        → pre-signed download (410 if not completed)

Link:
  POST   /v1/links/create                       → creates link, returns slug + public_url (QR is client-side, #650)
  GET    /v1/links/list                         → aggregator's links
  POST   /v1/links/:id/deactivate               → flips to retired
  GET    /public/v1/links/resolve/:slug         → public resolve
  POST   /public/v1/registrations/create/:slug  → sync submission

Metrics:
  GET    /v1/onboarding/summary                 → aggregated counts from onboarding table
  GET    /v1/onboarding/by-source               → bulk vs link breakdown
```

API never reads Redis. Row Processor flushes counters to `bulk_upload` every 500 rows. Finaliser writes final counters and `onboarding` summary row.

---

## 12. Errors (bulk only)

Single-pipeline: Redis HASH during processing → S3 `errors.csv` at finalisation. No durable Postgres errors table.

| Stage          | Where                                          | Purpose                                    |
| -------------- | ---------------------------------------------- | ------------------------------------------ |
| During run     | Redis HASH `bu:{id}:errors` + SET `error_rows` | Fast atomic ingest via Lua                 |
| At finalise    | S3 `errors.csv`                                | Single artefact for "fix and re-upload" UX |
| After finalise | DEL Redis                                      | Cleanup                                    |

Categories:

- `validation` — schema check failed
- `normalisation` — phone / email parse failed
- `duplicate` — `participant_id` already exists for this aggregator (counted as `skipped`)
- `system_error` — DB write or downstream call failed for an otherwise-valid row

`errors.csv` format:

```
<original CSV header columns>,error_category,error_reason
<original raw row>,validation,participant_id: required field missing
<original raw row>,duplicate,participant_id 'XYZ' already registered
```

Mid-run errors are not exposed via API. After finalisation, errors are accessible only by downloading `errors.csv`.

Link path has no errors.csv — single submissions return validation/dedup errors synchronously.

---

## 13. Failure Modes

| Failure                                                          | Handling                                                                              |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Header mismatch (bulk)                                           | File Processor rejects; `status='file_failed'`, reason `header_mismatch`              |
| Non-UTF-8 encoding (bulk)                                        | File Processor rejects; reason `encoding_unsupported`                                 |
| 0-row CSV                                                        | File Processor rejects; reason `empty_csv`; empty errors.csv materialised             |
| Row count > `BULK_MAX_ROWS`                                      | File Processor rejects; reason `row_cap_exceeded`                                     |
| Single row > 64KB                                                | File Processor rejects whole upload; reason `row_size_exceeded`                       |
| S3 PUT exceeds 10MB or wrong Content-Type                        | S3 rejects directly; client sees signing error                                        |
| Same CSV re-uploaded                                             | UNIQUE `(aggregator_id, s3_etag)` returns existing `upload_id`                        |
| Concurrent uploads, same aggregator, overlapping participant_ids | UNIQUE `(aggregator_id, participant_id)` → second batch reports overlaps as `skipped` |
| Cross-aggregator API access                                      | 403; row-level security as defence-in-depth                                           |
| Upload abandoned                                                 | Watchdog cron sweeps `pending > 24h` → `failed:upload_abandoned`                      |
| Processing stuck                                                 | Watchdog sweeps `processing/finalising > 30 min stalled` → `failed:processing_stuck`  |
| Reader crash mid-enqueue                                         | BullMQ retries; row jobIds dedupe; `total_rows` set only after last enqueue           |
| Processor crash mid-row                                          | Lua atomicity → safe; replay → SADD returns 0 → exit                                  |
| Finaliser crash mid-write                                        | Job retried; deterministic S3 key overwrites; UPDATE + INSERT idempotent              |
| Redis crash with AOF lag                                         | <1s of SADD/INCR lost; missing rows replay via BullMQ                                 |
| Link submit, validation fails                                    | API returns 400 with field-level errors                                               |
| Link submit, duplicate participant_id                            | API returns 409 with "already registered"                                             |
| Link expired or retired                                          | API returns 410 Gone                                                                  |
| Metrics rollup crash                                             | BullMQ retries; `rolled_up_at IS NULL` filter ensures no double-count                 |

---

## 14. Cleanup & Retention

| Data                           | Retention                                           | Mechanism                               |
| ------------------------------ | --------------------------------------------------- | --------------------------------------- |
| BullMQ records (Redis)         | 1h on complete, 7d on fail                          | `removeOnComplete` / `removeOnFail`     |
| Redis batch keys (`bu:{id}:*`) | DEL'd at finalisation; 24h TTL fallback             | Inline cleanup + TTL                    |
| `bulk_upload` rows             | 90 days                                             | Nightly cron                            |
| `link_submission` rows         | 90 days                                             | Nightly cron (after `rolled_up_at` set) |
| `registration_link` rows       | Soft-retire; never auto-delete                      | Manual admin action                     |
| `onboarding` rows              | Forever (rollup data)                               | n/a                                     |
| `participant` rows             | Forever (manual delete only)                        | n/a                                     |
| Original CSV in S3             | 30 days                                             | S3 lifecycle on `bulk-uploads/` prefix  |
| `errors.csv` in S3             | 30 days                                             | Same lifecycle rule                     |
| QR PNGs                        | Not stored (#650) — generated client-side on demand | n/a (no sweep needed)                   |

### Stuck-job watchdog (hourly cron)

```
sweep 1: pending > 24h
   UPDATE bulk_upload SET status='failed', status_reason='upload_abandoned'
   WHERE status='pending' AND created_at < NOW() - INTERVAL '24 hours';

sweep 2: stalled in-flight
   UPDATE bulk_upload SET status='failed', status_reason='processing_stuck'
   WHERE status IN ('file_validating','row_processing','finalising')
     AND last_progress_at < NOW() - INTERVAL '30 minutes';
```

---

## 15. Locked Decisions

- API stays lightweight for bulk: auth, pre-signed URL, DB row insert, enqueue, status reads only. No Ajv compile, no normalisation, no Redis reads in request handlers.
- API does sync work for link submissions (single record): validate, dedup, INSERT participant, INSERT link_submission. Cheap; user gets immediate confirmation.
- Three workers for bulk: **File Processor**, **Row Processor**, **Finaliser**. Not merged. Each its own queue.
- One worker for link metrics: **Metrics Aggregator**. Cron + threshold trigger.
- No chunking at MVP. One BullMQ job per CSV row.
- Atomic Lua script (`bulk_row_commit.lua`) for SADD + INCR + HSET — closes counter-inflation race.
- Errors are transient in Redis HASH during run; flushed to S3 `errors.csv` at finalisation. No durable Postgres errors table.
- `errors.csv` is the only durable error artefact; up to 1s loss tolerated under Redis AOF lag.
- Mid-run errors not exposed via API. Detailed errors visible only via `errors.csv` download after `status='completed'`.
- Error categories: `validation`, `normalisation`, `duplicate`, `system_error`. `duplicate` counts as `skipped`.
- Status reads are DB-only. Row Processor flushes counters every 500 rows.
- Person dedup is `(aggregator_id, participant_id)` UNIQUE on `participant`. `participant_id` is a schema-required field provided by the data source. Same person can register under different aggregators.
- `(aggregator_id, s3_etag)` UNIQUE on `bulk_upload` — re-upload idempotency.
- Pre-signed S3 PUT URL signed with `Content-Type: text/csv`, `Content-Length-Range: 0..10MB`, TTL 15 min.
- File Processor validates CSV header against active schema BEFORE enqueueing any row jobs.
- File Processor pins `schema_id` + `schema_version` on `bulk_upload` at start. Mid-run schema deploys do not affect in-flight uploads.
- Stuck-job watchdog runs hourly: `pending > 24h → upload_abandoned`; `processing > 30 min stalled → processing_stuck`.
- Every API endpoint validates JWT `aggregator_id` matches the resource. Postgres row-level security on `bulk_upload`, `participant`, `link_submission`, `onboarding`.
- Schema fetch and Ajv compile live in worker bootstrap (and API for the link sync path), not in any request hot path otherwise.
- Redis AOF persistence required (`appendonly yes`, `appendfsync everysec`).
- QR is derived data (#650): generated client-side from `public_url` on demand, never persisted — activation does no S3 work.
- Registration links are immutable post-create; status flip (`draft → live → retired`) is the only allowed change.
- Both bulk and link sources write to the same `participant` table and the same `onboarding` metrics table.
- `onboarding` rows: bulk = one per upload (Finaliser); link = one per (aggregator, hour-bucket) (Metrics Aggregator UPSERT).

---

## 16. Build Slice Order

1. `bulk_upload` table migration (with `s3_etag` UNIQUE, `schema_id`, `schema_version`, `last_progress_at`, status enum, counters, RLS policies).
2. `participant` migration: add `participant_id` column, drop phone UNIQUE, add `(aggregator_id, participant_id)` UNIQUE, add source FKs.
3. `registration_link` table migration.
4. `link_submission` table migration.
5. `onboarding` table migration.
6. SchemaLoader + Ajv compile cache (shared package consumed by API and workers).
7. `POST /v1/bulk-uploads` (pre-signed S3 URL with constraints) and `POST /v1/bulk-uploads/:id/start`.
8. `GET /v1/bulk-uploads/:id` — DB-only status read.
9. File Processor worker (`bulk-file-process`) — file-level checks, header validation, schema pinning.
10. `bulk_row_commit.lua` script + EVALSHA wrapper.
11. Row Processor worker (`bulk-row-process`) — Lua-atomic per-row processing.
12. Finaliser worker (`bulk-finalise`) — HSCAN errors → errors.csv → UPDATE bulk_upload → INSERT onboarding → DEL Redis.
13. `GET /v1/bulk-uploads/:id/errors.csv` — pre-signed download.
14. `POST /v1/links/create` — link creation (public_url only; QR generated client-side, #650).
15. `GET /v1/links/list`, `GET /v1/links/:id`, `POST /v1/links/:id/deactivate`.
16. `GET /public/v1/links/resolve/:slug` — public link resolve.
17. `POST /public/v1/registrations/create/:slug` — sync submission path (validate, dedup, INSERT participant, INSERT link_submission).
18. Metrics Aggregator worker (`link-metrics-rollup`) — cron + threshold trigger; UPSERT onboarding.
19. `GET /v1/onboarding/summary` and `/v1/onboarding/by-source` — UI metrics endpoints.
20. Telemetry events (run start, run complete, per-row AUDIT, link submission AUDIT).
21. Per-aggregator rate limit on `bulk-file-process` queue group; CAPTCHA + rate limit at BFF for link path.
22. Retention crons + S3 lifecycle rules.
23. Stuck-job watchdog cron — `pending > 24h` and `processing > 30 min stalled` sweepers.

---

## 17. Future Scale Levers

| Trigger                                                | Lever                                                                                  |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Uploads > 50K rows                                     | Reintroduce chunking (one chunk = 500 rows = one job batch)                            |
| Many concurrent batches                                | Separate `bulk-row-process` queue per aggregator for fairness                          |
| Redis memory pressure                                  | Switch to per-worker S3 chunk files concatenated at finalise                           |
| Audit / regulatory demand for queryable per-row errors | Add durable `bulk_upload_errors` table; Finaliser writes both PG and S3                |
| Multi-region                                           | Replicate `bulk_upload`, `participant`, `link_submission`, `onboarding` across regions |
| Link traffic spike                                     | Move link submission to async (enqueue + poll); BFF holds 3s for fast paths            |
| QR generation burst                                    | N/A since #650 — QR is generated client-side, no server load                           |

None required at MVP.
