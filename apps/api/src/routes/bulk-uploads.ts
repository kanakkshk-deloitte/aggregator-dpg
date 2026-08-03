/**
 * Bulk uploads endpoints.
 *
 *   POST /v1/bulk-uploads
 *     Reserve a bulk_upload row (status='pending') and return a pre-signed
 *     S3 PUT URL with Content-Type + size constraints baked into the
 *     signature. The browser uploads CSV bytes directly to S3.
 *
 *   POST /v1/bulk-uploads/:id/start
 *     Browser calls this AFTER the S3 PUT completes. The API HEADs the
 *     object to confirm + capture the ETag, transitions status='uploaded',
 *     and (later slices) enqueues the File Processor job.
 *
 *   GET /v1/bulk-uploads/:id
 *     DB-only status read for UI polling. Returns status, counters,
 *     errors_csv_s3_key (when ready). Never reads Redis.
 *
 * All endpoints validate JWT `aggregator_id` matches the resource. Cross-
 * aggregator access returns 403 (not 404 — no enumeration leak).
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import { requireApproved, type AuthContext } from '../services/auth/access-token.js';
import { getBulkUploadsStore } from '../services/bulk-uploads-store/index.js';
import { enqueueBulkFileProcess } from '../services/bulk-queue/index.js';
import {
  headObject,
  signBulkUploadUrl,
  signErrorsCsvDownloadUrl,
} from '../services/object-storage/index.js';
import { httpError } from '../errors/http-error.js';
import { errorResponses } from '../errors/openapi.js';
import { getSchemaLoader } from '../services/schema-loader/index.js';
import { buildCsvTemplate } from '../services/csv-template/index.js';
import { readBulkSample } from '../services/csv-template/bulk-sample.js';
import { getNetworkConfig } from '../services/network-config.js';
import { loadConsentConfig } from '@aggregator-dpg/config-loader/fs';
import { getConsentLedger } from '../services/consent-ledger/index.js';
import { resolveActiveNetwork } from '@aggregator-dpg/network-config/paths';
import { config } from '../config.js';
import { getDb } from '../db/client.js';
import { onboarding } from '../db/schema.js';
import { getRedis } from '../services/redis/index.js';

/**
 * Loads the network config and returns the set of valid participant
 * types for the active network (e.g. ['seeker','provider'] for blue/purple,
 * ['tourist','practitioner'] for orange_dot).
 */
async function getValidParticipantTypes(): Promise<Set<string>> {
  const cfg = await getNetworkConfig();
  return new Set(cfg.domainIds);
}

/**
 * Query shape for the CSV template download. Valid `participant_type` values
 * are network-config driven (e.g. seeker/provider), so the schema stays an
 * open string and the handler validates against the live config.
 */
const TemplateQuerySchema = z.object({
  participant_type: z
    .string()
    .optional()
    .describe('Participant domain id declared by the active network (e.g. seeker, provider).'),
});

/**
 * Body for creating a bulk-upload job. `participant_type` is validated
 * against the active network config at request time.
 */
const CreateBulkUploadBodySchema = z
  .object({
    participant_type: z
      .string()
      .min(1)
      .describe('Participant domain id declared by the active network (e.g. seeker, provider).'),
  })
  .passthrough();

/** Path params for routes addressing a single bulk-upload job. */
const BulkUploadParamsSchema = z.object({
  id: z.string().min(1).describe('Bulk-upload job id (UUID).'),
});

/**
 * Body for `/start`. The uploading aggregator must attest authority to submit
 * the file's participants (#522 Task 1) — `attestation` must be `true` or the
 * upload is rejected with 400 CONSENT_REQUIRED.
 */
const StartBulkUploadBodySchema = z
  .object({
    attestation: z.boolean().optional().describe('Operator attestation of authority to upload.'),
  })
  .passthrough();

/**
 * Pagination query for the bulk-uploads list. Bounds are enforced here so the
 * handler consumes the already-validated values: `limit` must be 1-100
 * (default 20) and `offset` must be ≥ 0 (default 0); out-of-range values are
 * rejected with 400 SCHEMA_VALIDATION by the route schema.
 */
const ListBulkUploadsQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe('Page size (1-100, default 20).'),
  offset: z.coerce.number().int().min(0).default(0).describe('Rows to skip (≥ 0, default 0).'),
});

/** Wire shape of a bulk-upload job row (see {@link toResponse}). */
const BulkUploadResponseSchema = z
  .object({
    upload_id: z.string(),
    status: z.string(),
    status_reason: z.string().nullable(),
    participant_type: z.string(),
    total_rows: z.number().nullable(),
    passed: z.number(),
    failed: z.number(),
    skipped: z.number(),
    errors_csv_s3_key: z.string().nullable(),
    schema_id: z.string(),
    schema_version: z.string(),
    created_at: z.string(),
    completed_at: z.string().nullable(),
  })
  .passthrough();

/** 201 payload for POST /v1/bulk-uploads — pre-signed S3 PUT reservation. */
const CreateBulkUploadResponseSchema = z
  .object({
    upload_id: z.string(),
    upload_url: z.string(),
    s3_key: z.string(),
    expires_at: z.string(),
    content_type: z.string(),
    max_bytes: z.number(),
    schema_id: z.string(),
    schema_version: z.string(),
    status: z.string(),
  })
  .passthrough();

/** 200 payload for the paginated bulk-uploads list. */
const ListBulkUploadsResponseSchema = z
  .object({
    items: z.array(BulkUploadResponseSchema),
    total: z.number(),
    limit: z.number(),
    offset: z.number(),
  })
  .passthrough();

/** 200 payload for the errors.csv signed-download endpoint. */
const ErrorsCsvResponseSchema = z
  .object({
    upload_id: z.string(),
    url: z.string(),
    s3_key: z.string(),
    expires_at: z.string(),
    content_type: z.string(),
    counts: z
      .object({
        total_rows: z.number().nullable(),
        passed: z.number(),
        failed: z.number(),
        skipped: z.number(),
      })
      .passthrough(),
  })
  .passthrough();

export async function registerBulkUploadsRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/v1/bulk-uploads/template',
    {
      schema: {
        tags: ['bulk-uploads'],
        summary: 'Download CSV template for a domain',
        description:
          "Returns a CSV template (text/csv) with the header row + sample row for the requested ?participant_type= (seeker/provider). Array-typed fields use the network's csv_array_delimiter. Responds with a text/csv attachment on 200 (no JSON body).",
        security: [{ bearerAuth: [] }],
        querystring: TemplateQuerySchema,
        response: {
          ...errorResponses(400, 401, 403, 500),
        },
      },
    },
    async (req, reply) => {
      const auth = await requireAuth(req);
      const query = req.query as { participant_type?: string };
      const participantType = query.participant_type;
      const validTypes = await getValidParticipantTypes();
      if (!participantType || !validTypes.has(participantType)) {
        throw httpError('SCHEMA_VALIDATION', {
          detail: `participant_type must be one of: ${[...validTypes].join(', ')}.`,
          fields: { participant_type: 'invalid' },
        });
      }
      enforceAggregatorType(auth, participantType as string);

      // Prefer a curated, data-complete sample CSV shipped with the active
      // network config (config/<network>/bulk-samples/<type>.csv) — real, valid
      // rows an operator can edit in place beat a synthesised one-row template.
      // Fall back to the schema-generated template when none is shipped.
      const sample = await readBulkSample(participantType as string);
      if (sample !== null) {
        void auth; // authenticated for audit; curated sample is static content
        return reply
          .header('Content-Type', 'text/csv; charset=utf-8')
          .header('Content-Disposition', `attachment; filename="${participantType}-template.csv"`)
          .send(sample);
      }

      const schemaResult = await getSchemaLoader().getSchema({
        id: `participant-${participantType}`,
        version: 'v1',
      });
      if (!schemaResult.success) {
        throw httpError('INTERNAL', {
          detail: 'Participant schema unavailable.',
          cause: new Error(schemaResult.error.message),
        });
      }
      const cfg = await getNetworkConfig();
      const csv = buildCsvTemplate(schemaResult.value, {
        arrayDelimiter: cfg.aggregator.network.csv_array_delimiter,
      });
      void auth; // authenticated for audit; csv content is schema-derived only
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${participantType}-template.csv"`)
        .send(csv);
    },
  );

  app.post(
    '/v1/bulk-uploads',
    {
      schema: {
        tags: ['bulk-uploads'],
        summary: 'Create a new bulk-upload job',
        description:
          'Reserves a pending bulk-upload job for the caller aggregator and returns a pre-signed S3 PUT URL. The browser uploads CSV bytes directly to S3, then calls /start. `participant_type` is validated against the active network config at request time.',
        security: [{ bearerAuth: [] }],
        body: CreateBulkUploadBodySchema,
        response: {
          201: CreateBulkUploadResponseSchema,
          ...errorResponses(400, 401, 403, 503),
        },
      },
    },
    async (req, reply) => {
      const auth = await requireAuth(req);
      const log = req.log.child({ operation: 'bulkUploads.create', actor: auth.userId });
      const start = Date.now();

      // Shape is already validated by the route schema; the value itself is
      // network-config driven, so membership is checked against live config here.
      const { participant_type: participantType } = req.body as z.infer<
        typeof CreateBulkUploadBodySchema
      >;
      const validTypes = await getValidParticipantTypes();
      if (!validTypes.has(participantType)) {
        throw httpError('SCHEMA_VALIDATION', {
          detail: `participant_type must be one of: ${[...validTypes].join(', ')}.`,
          fields: { participant_type: 'invalid' },
        });
      }
      enforceAggregatorType(auth, participantType);

      // Pin the active schema version at create time. v1 is the only published
      // version today; this becomes a registry lookup once schema versioning ships.
      const schemaId = `participant-${participantType}`;
      const schemaVersion = 'v1';

      const store = getBulkUploadsStore();
      const created = await store.create({
        aggregatorId: auth.aggregatorId,
        participantType,
        // Temporary placeholder; replaced after sign call below. We need the
        // row id to compute the deterministic key, so create-then-update.
        s3Key: 'pending',
        schemaId,
        schemaVersion,
        uploadedBy: auth.userId,
      });
      if (!created.ok) {
        log.error({
          status: 'failure',
          error: created.error.code,
          latency_ms: Date.now() - start,
        });
        throw httpError('DB_UNAVAILABLE', { cause: new Error(created.error.message) });
      }

      const uploadId = created.value.id;
      const signed = await signBulkUploadUrl({
        uploadId,
        aggregatorId: auth.aggregatorId,
      });

      // Persist the real key now that we know it. The store doesn't yet expose
      // an updateKey method; reach in via Drizzle directly. (Slice 8 cleanup
      // can move this into the store interface.)
      const { getDb } = await import('../db/client.js');
      const { bulkUploads } = await import('../db/schema.js');
      const { eq } = await import('drizzle-orm');
      await getDb()
        .update(bulkUploads)
        .set({ s3Key: signed.key, updatedAt: new Date() })
        .where(eq(bulkUploads.id, uploadId));

      log.info({
        status: 'success',
        latency_ms: Date.now() - start,
        upload_id: uploadId,
        aggregator_id: auth.aggregatorId,
      });

      return reply.code(201).send({
        upload_id: uploadId,
        upload_url: signed.url,
        s3_key: signed.key,
        expires_at: signed.expiresAt,
        content_type: signed.contentType,
        max_bytes: signed.maxBytes,
        schema_id: schemaId,
        schema_version: schemaVersion,
        status: 'pending',
      });
    },
  );

  app.post(
    '/v1/bulk-uploads/:id/start',
    {
      schema: {
        tags: ['bulk-uploads'],
        summary: 'Start processing a pending bulk-upload job',
        description:
          'Transitions a pending job to running; the worker onboards each valid row to signalstack. Idempotent on already-running/completed jobs.',
        security: [{ bearerAuth: [] }],
        params: BulkUploadParamsSchema,
        body: StartBulkUploadBodySchema,
        response: {
          200: BulkUploadResponseSchema,
          ...errorResponses(400, 401, 403, 500, 503),
        },
      },
    },
    async (req, reply) => {
      const auth = await requireAuth(req);
      // Params are already validated by the route schema (id: non-empty string).
      const { id: uploadId } = req.params as z.infer<typeof BulkUploadParamsSchema>;
      const body = req.body as z.infer<typeof StartBulkUploadBodySchema>;
      const log = req.log.child({
        operation: 'bulkUploads.start',
        actor: auth.userId,
        upload_id: uploadId,
      });
      const start = Date.now();

      const store = getBulkUploadsStore();
      const found = await store.findById(uploadId, auth.aggregatorId);
      if (!found.ok) {
        throw httpError('DB_UNAVAILABLE', { cause: new Error(found.error.message) });
      }
      if (!found.value) {
        // 403 to prevent cross-aggregator enumeration.
        throw httpError('FORBIDDEN', { detail: 'Upload not accessible.' });
      }

      const upload = found.value;
      // Idempotent re-call: already past 'uploaded' → just return current.
      if (upload.status !== 'pending' && upload.status !== 'uploaded') {
        log.warn({
          status: 'skipped',
          reason: 'invalid_transition',
          current_status: upload.status,
          latency_ms: Date.now() - start,
        });
        return reply.send(toResponse(upload));
      }

      // Operator attestation of authority (#522 Task 1): the aggregator must
      // confirm they have permission to submit the file's participants. No
      // attestation → reject before any S3 work or state transition.
      if (body.attestation !== true) {
        throw httpError('CONSENT_REQUIRED', {
          detail: 'You must confirm authority to upload before starting.',
          fields: { attestation: body.attestation ?? null },
        });
      }

      const head = await headObject(upload.s3Key);
      if (!head) {
        log.warn({
          status: 'failure',
          reason: 's3_object_missing',
          s3_key: upload.s3Key,
          latency_ms: Date.now() - start,
        });
        throw httpError('SCHEMA_VALIDATION', {
          detail: 'CSV upload not found in object storage. Complete the PUT and retry.',
        });
      }
      if (head.contentLength === 0) {
        throw httpError('SCHEMA_VALIDATION', { detail: 'Uploaded CSV is empty.' });
      }
      if (head.contentLength > config.BULK_UPLOAD_MAX_BYTES) {
        // Belt + braces alongside the signed PUT — S3 PUT signing alone does not
        // bind a max size on the GetObject side, and the worker downloads the
        // whole object into memory. Reject before enqueueing.
        log.warn({
          status: 'failure',
          reason: 'object_too_large',
          s3_key: upload.s3Key,
          content_length: head.contentLength,
          max_bytes: config.BULK_UPLOAD_MAX_BYTES,
        });
        throw httpError('SCHEMA_VALIDATION', {
          detail: `Uploaded CSV is too large (${head.contentLength} bytes; max ${config.BULK_UPLOAD_MAX_BYTES}).`,
        });
      }

      // Record the operator attestation in the consent ledger BEFORE the row
      // transitions / is enqueued — fail-closed, mirroring the registration
      // consent contract (no upload is processed without a recorded
      // attestation). No dedicated column: the source encodes the upload id +
      // statement version (`bulk_upload:<uploadId>:v<n>`); terms/privacy
      // versions in force are stored in their existing columns.
      const attestationRecorded = await recordBulkUploadAttestation({
        aggregatorId: auth.aggregatorId,
        uploadId,
        log,
      });
      if (!attestationRecorded) {
        throw httpError('CONSENT_WRITE_FAILED', {
          fields: { sub_operation: 'recordBulkUploadAttestation' },
        });
      }

      // Aggregators are allowed to re-upload the same CSV bytes — the
      // partial UNIQUE on (aggregator_id, s3_etag) was dropped in
      // migration 0011. Any non-OK result here is a real DB / state
      // error, not a duplicate.
      const marked = await store.markUploaded(uploadId, auth.aggregatorId, head.etag);
      if (!marked.ok) {
        throw httpError('DB_UNAVAILABLE', { cause: new Error(marked.error.message) });
      }

      try {
        await enqueueBulkFileProcess({
          uploadId: marked.value.id,
          aggregatorId: auth.aggregatorId,
          s3Key: marked.value.s3Key,
          participantType: marked.value.participantType,
          schemaId: marked.value.schemaId,
          schemaVersion: marked.value.schemaVersion,
        });
      } catch (err) {
        // Enqueue failed but the row is already in 'uploaded' status. The
        // stuck-job watchdog will surface this if no worker picks it up.
        log.error({
          status: 'failure',
          sub_operation: 'enqueue.bulk-file-process',
          error: (err as Error).message,
        });
        throw httpError('INTERNAL', { cause: err });
      }

      log.info({
        status: 'success',
        latency_ms: Date.now() - start,
        etag: head.etag,
        content_length: head.contentLength,
        next_status: marked.value.status,
      });

      return reply.send(toResponse(marked.value));
    },
  );

  app.get(
    '/v1/bulk-uploads',
    {
      schema: {
        tags: ['bulk-uploads'],
        summary: 'List bulk-upload jobs',
        description: 'Paginated list of bulk-upload jobs (newest first) for the caller aggregator.',
        security: [{ bearerAuth: [] }],
        querystring: ListBulkUploadsQuerySchema,
        response: {
          200: ListBulkUploadsResponseSchema,
          ...errorResponses(400, 401, 403, 503),
        },
      },
    },
    async (req, reply) => {
      const auth = await requireAuth(req);
      // Query is already validated + coerced by the route schema (bounds + defaults).
      const { limit, offset } = req.query as z.infer<typeof ListBulkUploadsQuerySchema>;

      const store = getBulkUploadsStore();
      const result = await store.list(auth.aggregatorId, { limit, offset });
      if (!result.ok) {
        throw httpError('DB_UNAVAILABLE', { cause: new Error(result.error.message) });
      }
      const countsBatch = await loadCountsBatch(result.value.rows);
      return reply.send({
        items: result.value.rows.map((row) =>
          toResponse(row, countsBatch.get(row.id) ?? ZERO_COUNTS),
        ),
        total: result.value.total,
        limit,
        offset,
      });
    },
  );

  app.get(
    '/v1/bulk-uploads/:id',
    {
      schema: {
        tags: ['bulk-uploads'],
        summary: 'Read a bulk-upload job',
        description:
          'Returns the full job row including status, per-row counters, and error summary.',
        security: [{ bearerAuth: [] }],
        params: BulkUploadParamsSchema,
        response: {
          200: BulkUploadResponseSchema,
          ...errorResponses(400, 401, 403, 503),
        },
      },
    },
    async (req, reply) => {
      const auth = await requireAuth(req);
      // Params are already validated by the route schema (id: non-empty string).
      const { id: uploadId } = req.params as z.infer<typeof BulkUploadParamsSchema>;

      const store = getBulkUploadsStore();
      const found = await store.findById(uploadId, auth.aggregatorId);
      if (!found.ok) {
        throw httpError('DB_UNAVAILABLE', { cause: new Error(found.error.message) });
      }
      if (!found.value) {
        throw httpError('FORBIDDEN', { detail: 'Upload not accessible.' });
      }

      const counts = await loadCounts(found.value.id, found.value.status);
      return reply.send(toResponse(found.value, counts));
    },
  );

  app.get(
    '/v1/bulk-uploads/:id/errors.csv',
    {
      schema: {
        tags: ['bulk-uploads'],
        summary: 'Download per-row error CSV',
        description:
          'Returns a JSON payload carrying a short-lived pre-signed S3 GET URL for the errors.csv report (rows that failed validation/onboarding with reason + offending fields), plus the final counters. Only available once the upload is completed and at least one row failed.',
        security: [{ bearerAuth: [] }],
        params: BulkUploadParamsSchema,
        response: {
          200: ErrorsCsvResponseSchema,
          ...errorResponses(400, 401, 403, 404, 410, 503),
        },
      },
    },
    async (req, reply) => {
      const auth = await requireAuth(req);
      // Params are already validated by the route schema (id: non-empty string).
      const { id: uploadId } = req.params as z.infer<typeof BulkUploadParamsSchema>;
      const log = req.log.child({
        operation: 'bulkUploads.errorsCsv',
        actor: auth.userId,
        upload_id: uploadId,
      });
      const start = Date.now();

      const store = getBulkUploadsStore();
      const found = await store.findById(uploadId, auth.aggregatorId);
      if (!found.ok) {
        throw httpError('DB_UNAVAILABLE', { cause: new Error(found.error.message) });
      }
      if (!found.value) {
        // 403 to prevent cross-aggregator enumeration.
        throw httpError('FORBIDDEN', { detail: 'Upload not accessible.' });
      }
      const upload = found.value;

      if (upload.status !== 'completed') {
        log.info({
          status: 'skipped',
          reason: 'not_completed',
          current_status: upload.status,
          latency_ms: Date.now() - start,
        });
        throw httpError('BULK_UPLOAD_NOT_READY', {
          detail: `Upload is in status '${upload.status}'. The errors report is generated only after finalisation.`,
        });
      }
      if (!upload.errorsCsvS3Key) {
        // The Finaliser only writes errors.csv when `failed > 0`. A null key
        // on a completed run = clean upload (every row passed). Communicate
        // that to the UI so it can hide the "Download errors" button instead
        // of rendering it as a broken link.
        log.info({
          status: 'skipped',
          reason: 'no_errors_to_report',
        });
        throw httpError('NOT_FOUND', {
          detail: 'No errors to download — all rows in this upload passed.',
        });
      }
      // Hardened: only sign keys that match the canonical errors.csv layout.
      // Even though the worker writes a deterministic key, this guards against
      // any future path (or DB tamper) signing a GET URL for an arbitrary object.
      const expectedKey = `bulk-uploads/${upload.id}/errors.csv`;
      if (upload.errorsCsvS3Key !== expectedKey) {
        log.error({
          status: 'failure',
          reason: 'errors_csv_key_invalid',
          s3_key: upload.errorsCsvS3Key,
        });
        throw httpError('NOT_FOUND', { detail: 'Errors report not available for this upload.' });
      }

      const signed = await signErrorsCsvDownloadUrl(upload.errorsCsvS3Key);

      log.info({
        status: 'success',
        latency_ms: Date.now() - start,
        s3_key: upload.errorsCsvS3Key,
      });

      const counts = await loadCounts(upload.id, upload.status);
      return reply.send({
        upload_id: upload.id,
        url: signed.url,
        s3_key: signed.key,
        expires_at: signed.expiresAt,
        content_type: 'text/csv',
        counts: {
          total_rows: counts.totalRows,
          passed: counts.passed,
          failed: counts.failed,
          skipped: counts.skipped,
        },
      });
    },
  );
}

interface BulkUploadResponseShape {
  upload_id: string;
  status: string;
  status_reason: string | null;
  participant_type: string;
  total_rows: number | null;
  passed: number;
  failed: number;
  skipped: number;
  errors_csv_s3_key: string | null;
  schema_id: string;
  schema_version: string;
  created_at: string;
  completed_at: string | null;
}

interface UploadCounts {
  totalRows: number | null;
  passed: number;
  failed: number;
  skipped: number;
}

const ZERO_COUNTS: UploadCounts = { totalRows: null, passed: 0, failed: 0, skipped: 0 };

interface UploadShape {
  id: string;
  status: string;
  statusReason: string | null;
  participantType: string;
  errorsCsvS3Key: string | null;
  schemaId: string;
  schemaVersion: string;
  createdAt: Date;
  completedAt: Date | null;
}

function toResponse(
  upload: UploadShape,
  counts: UploadCounts = ZERO_COUNTS,
): BulkUploadResponseShape {
  return {
    upload_id: upload.id,
    status: upload.status,
    status_reason: upload.statusReason,
    participant_type: upload.participantType,
    total_rows: counts.totalRows,
    passed: counts.passed,
    failed: counts.failed,
    skipped: counts.skipped,
    errors_csv_s3_key: upload.errorsCsvS3Key,
    schema_id: upload.schemaId,
    schema_version: upload.schemaVersion,
    created_at: upload.createdAt.toISOString(),
    completed_at: upload.completedAt ? upload.completedAt.toISOString() : null,
  };
}

/**
 * Loads live counters from Redis for an in-flight upload. Returns ZERO_COUNTS
 * when keys are missing (run not started, or already finalised + GC'd).
 */
async function loadCountsFromRedis(uploadId: string): Promise<UploadCounts> {
  try {
    const redis = getRedis();
    const ns = `bu:${uploadId}`;
    const [counters, meta] = await Promise.all([
      redis.hmget(`${ns}:counters`, 'passed', 'failed', 'skipped'),
      redis.hget(`${ns}:meta`, 'total_rows'),
    ]);
    const passed = parseInt(counters[0] ?? '0', 10) || 0;
    const failed = parseInt(counters[1] ?? '0', 10) || 0;
    const skipped = parseInt(counters[2] ?? '0', 10) || 0;
    const totalRows = meta ? parseInt(meta, 10) || null : null;
    return { totalRows, passed, failed, skipped };
  } catch {
    return ZERO_COUNTS;
  }
}

/**
 * Loads terminal counters from the `onboarding` row written by `bulk-finalise`.
 * Returns ZERO_COUNTS if the row is missing (would indicate a stale completed
 * upload that pre-dates the rollup migration).
 */
async function loadCountsFromOnboarding(uploadId: string): Promise<UploadCounts> {
  const rows = await getDb()
    .select({
      total: onboarding.total,
      passed: onboarding.passed,
      failed: onboarding.failed,
      skipped: onboarding.skipped,
    })
    .from(onboarding)
    .where(and(eq(onboarding.source, 'bulk'), eq(onboarding.batchId, uploadId)))
    .limit(1);
  const row = rows[0];
  if (!row) return ZERO_COUNTS;
  return {
    totalRows: row.total,
    passed: row.passed,
    failed: row.failed,
    skipped: row.skipped,
  };
}

/** Picks the right counter source based on upload status. */
async function loadCounts(uploadId: string, status: string): Promise<UploadCounts> {
  if (status === 'completed') return loadCountsFromOnboarding(uploadId);
  if (status === 'pending' || status === 'uploaded') return ZERO_COUNTS;
  return loadCountsFromRedis(uploadId);
}

/** Batch counter load for list view — one onboarding query, Redis fan-out for active rows. */
async function loadCountsBatch(
  uploads: Array<{ id: string; status: string }>,
): Promise<Map<string, UploadCounts>> {
  const out = new Map<string, UploadCounts>();
  const completedIds = uploads.filter((u) => u.status === 'completed').map((u) => u.id);
  if (completedIds.length > 0) {
    const rows = await getDb()
      .select({
        batchId: onboarding.batchId,
        total: onboarding.total,
        passed: onboarding.passed,
        failed: onboarding.failed,
        skipped: onboarding.skipped,
      })
      .from(onboarding)
      .where(and(eq(onboarding.source, 'bulk'), inArray(onboarding.batchId, completedIds)));
    for (const r of rows) {
      if (!r.batchId) continue;
      out.set(r.batchId, {
        totalRows: r.total,
        passed: r.passed,
        failed: r.failed,
        skipped: r.skipped,
      });
    }
  }
  const liveUploads = uploads.filter(
    (u) => u.status !== 'completed' && u.status !== 'pending' && u.status !== 'uploaded',
  );
  for (const u of liveUploads) {
    out.set(u.id, await loadCountsFromRedis(u.id));
  }
  return out;
}

async function requireAuth(req: FastifyRequest): Promise<AuthContext> {
  const result = await requireApproved(req);
  if (!result.ok) {
    if (result.error.code === 'NOT_APPROVED') {
      throw httpError('NOT_APPROVED', { detail: result.error.message });
    }
    throw httpError('UNAUTHORIZED', { detail: result.error.message });
  }
  if (!result.context.aggregatorId) {
    throw httpError('UNAUTHORIZED', { detail: 'Token missing aggregator_id claim.' });
  }
  return result.context;
}

/**
 * Reject when the requested participant type does not match the aggregator's
 * registered type (read from the JWT `aggregator_type` claim). An aggregator
 * may only upload or template the type it registered as.
 */
function enforceAggregatorType(auth: AuthContext, participantType: string): void {
  if (!auth.aggregatorType) {
    throw httpError('AGGREGATOR_TYPE_MISSING', {
      fields: { aggregator_id: auth.aggregatorId },
    });
  }
  if (auth.aggregatorType !== participantType) {
    throw httpError('AGGREGATOR_TYPE_MISMATCH', {
      fields: {
        aggregator_type: auth.aggregatorType,
        requested_type: participantType,
      },
    });
  }
}

/**
 * Records the operator's bulk-upload attestation in the consent ledger.
 *
 * Fail-closed (returns `false` on any failure) so the caller aborts the upload
 * rather than processing it without a recorded attestation. Uses no dedicated
 * columns: the `source` encodes the upload id and the attestation statement
 * version (`bulk_upload:<uploadId>:v<n>`), while the terms/privacy versions in
 * force at upload time are stored in their existing columns — satisfying the
 * "who / when / terms+privacy version" record without a migration (#522 Task 1).
 *
 * @param aggregatorId - The uploading aggregator (ledger subject).
 * @param uploadId - The bulk_uploads row this attestation authorises.
 * @param log - Request-scoped logger.
 * @returns `true` when the ledger row was written; `false` on any failure.
 */
async function recordBulkUploadAttestation({
  aggregatorId,
  uploadId,
  log,
}: {
  aggregatorId: string;
  uploadId: string;
  log: ReturnType<FastifyRequest['log']['child']>;
}): Promise<boolean> {
  const { network, brand } = resolveActiveNetwork();
  let termsVersion: number;
  let privacyVersion: number;
  let attestationVersion: number;
  try {
    const consentCfg = await loadConsentConfig(network, brand);
    const docs = consentCfg.audiences.aggregator.documents;
    const attestation = docs.bulk_upload_attestation;
    if (!attestation) {
      log.error(
        { operation: 'consentLedger.recordBulkUploadAttestation', status: 'failure' },
        'bulk_upload_attestation not configured for the aggregator audience',
      );
      return false;
    }
    termsVersion = docs.terms.current_version;
    privacyVersion = docs.privacy.current_version;
    attestationVersion = attestation.current_version;
  } catch (e) {
    log.error(
      {
        operation: 'consentLedger.recordBulkUploadAttestation',
        status: 'failure',
        error: e instanceof Error ? e.message : String(e),
      },
      'consent config load failed — bulk upload rejected',
    );
    return false;
  }

  const result = await getConsentLedger().recordRegistrationConsent({
    subjectType: 'aggregator',
    subjectId: aggregatorId,
    network,
    brand: brand ?? null,
    termsVersion,
    privacyVersion,
    source: `bulk_upload:${uploadId}:v${attestationVersion}`,
  });
  if (!result.success) {
    log.error(
      {
        operation: 'consentLedger.recordBulkUploadAttestation',
        status: 'failure',
        error: result.error.message,
      },
      'attestation ledger write failed — bulk upload rejected',
    );
    return false;
  }
  return true;
}
