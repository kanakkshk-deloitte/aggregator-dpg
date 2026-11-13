/**
 * Tests for the bulk-uploads route surface (`/v1/bulk-uploads*`).
 *
 * Covers the full lifecycle: template download, create (pre-signed PUT
 * reservation), start (S3 HEAD + attestation + enqueue), list, single read,
 * and the errors.csv signed-download endpoint — including the auth wrapper,
 * aggregator-type enforcement, the fail-closed consent-ledger attestation
 * write, and every upstream-failure branch (store, S3, queue, Redis).
 *
 * @module apps/api/routes/bulk-uploads.test
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import ExcelJS from 'exceljs';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { _setAccessTokenVerifier, _resetJwks } from '../services/auth/access-token.js';
import { _setNetworkConfig } from '../services/network-config.js';
import { buildBlueDotConfig } from '@aggregator-dpg/network-config/testing';
import type { ResolvedNetworkConfig } from '@aggregator-dpg/network-config/interface';
import {
  _setBulkUploadsStore,
  BulkUploadsStoreBase,
} from '../services/bulk-uploads-store/index.js';
import type {
  BulkUpload,
  CreateBulkUploadInput,
  ListBulkUploadsOptions,
  ListBulkUploadsResult,
  StoreResult,
} from '../services/bulk-uploads-store/index.js';
import { ConsentLedgerFake } from '@aggregator-dpg/consent-ledger/testing';
import { _setConsentLedger } from '../services/consent-ledger/index.js';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import { _setRedis } from '../services/redis/index.js';

// Hoisted so the vi.mock factories can reference them (mocks are hoisted
// above module code).
const {
  headObjectMock,
  signBulkUploadUrlMock,
  signErrorsCsvDownloadUrlMock,
  enqueueBulkFileProcessMock,
  loadConsentConfigMock,
} = vi.hoisted(() => ({
  headObjectMock: vi.fn(),
  signBulkUploadUrlMock: vi.fn(),
  signErrorsCsvDownloadUrlMock: vi.fn(),
  enqueueBulkFileProcessMock: vi.fn(),
  loadConsentConfigMock: vi.fn(),
}));

vi.mock('../services/object-storage/index.js', () => ({
  headObject: headObjectMock,
  signBulkUploadUrl: signBulkUploadUrlMock,
  signErrorsCsvDownloadUrl: signErrorsCsvDownloadUrlMock,
}));

vi.mock('../services/bulk-queue/index.js', () => ({
  enqueueBulkFileProcess: enqueueBulkFileProcessMock,
}));

vi.mock('@aggregator-dpg/config-loader/fs', () => ({
  loadConsentConfig: loadConsentConfigMock,
}));

/** Rows the fake DB (`../db/client.js`) hands back for onboarding-rollup reads. */
interface FakeOnboardingRow {
  batchId: string | null;
  total: number | null;
  passed: number;
  failed: number;
  skipped: number;
}

let onboardingRows: FakeOnboardingRow[] = [];
const dbUpdateSpy = vi.fn();

/** Minimal thenable that also exposes `.limit()`, mirroring drizzle's chain. */
function chainable(rows: FakeOnboardingRow[]) {
  return {
    limit(n: number) {
      return Promise.resolve(rows.slice(0, n));
    },
    then(onFulfilled: (v: FakeOnboardingRow[]) => unknown, onRejected?: (e: unknown) => unknown) {
      return Promise.resolve(rows).then(onFulfilled, onRejected);
    },
  };
}

vi.mock('../db/client.js', () => ({
  getDb: () => ({
    update: (_table: unknown) => ({
      set: (vals: Record<string, unknown>) => ({
        where: (_cond: unknown) => {
          dbUpdateSpy(vals);
          return Promise.resolve();
        },
      }),
    }),
    select: (_cols: unknown) => ({
      from: (_table: unknown) => ({
        where: (_cond: unknown) => chainable(onboardingRows),
      }),
    }),
  }),
}));

/** In-memory fake for `BulkUploadsStoreBase` (the package has no shipped fake). */
class BulkUploadsStoreFake extends BulkUploadsStoreBase {
  private rows = new Map<string, BulkUpload>();
  private seq = 0;
  /** Force the next call (by method name) to return this error instead. */
  private failNext = new Map<string, { code: string }>();

  seed(rows: BulkUpload[]): void {
    for (const r of rows) this.rows.set(r.id, r);
  }

  /** Test helper: make the next call to `method` resolve with a DB error. */
  failOnce(method: 'create' | 'findById' | 'list' | 'markUploaded', code: string): void {
    this.failNext.set(method, { code });
  }

  private takeFailure(method: string): { code: string } | undefined {
    const f = this.failNext.get(method);
    if (f) this.failNext.delete(method);
    return f;
  }

  async create(input: CreateBulkUploadInput): Promise<StoreResult<BulkUpload>> {
    const fail = this.takeFailure('create');
    if (fail) return { ok: false, error: { code: 'DB_UNAVAILABLE', message: 'db down' } };
    this.seq += 1;
    const now = new Date('2026-08-01T00:00:00.000Z');
    const row: BulkUpload = {
      id: `upload-${this.seq}`,
      aggregatorId: input.aggregatorId,
      participantType: input.participantType,
      s3Key: input.s3Key,
      s3Etag: null,
      status: 'pending',
      statusReason: null,
      errorsCsvS3Key: null,
      schemaId: input.schemaId,
      schemaVersion: input.schemaVersion,
      uploadedBy: input.uploadedBy,
      lastProgressAt: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
    this.rows.set(row.id, row);
    return { ok: true, value: row };
  }

  async findById(id: string, aggregatorId: string): Promise<StoreResult<BulkUpload | null>> {
    const fail = this.takeFailure('findById');
    if (fail) return { ok: false, error: { code: 'DB_UNAVAILABLE', message: 'db down' } };
    const row = this.rows.get(id);
    if (!row || row.aggregatorId !== aggregatorId) return { ok: true, value: null };
    return { ok: true, value: row };
  }

  async findByAggregatorAndEtag(
    aggregatorId: string,
    s3Etag: string,
  ): Promise<StoreResult<BulkUpload | null>> {
    for (const row of this.rows.values()) {
      if (row.aggregatorId === aggregatorId && row.s3Etag === s3Etag) {
        return { ok: true, value: row };
      }
    }
    return { ok: true, value: null };
  }

  async list(
    aggregatorId: string,
    options: ListBulkUploadsOptions,
  ): Promise<StoreResult<ListBulkUploadsResult>> {
    const fail = this.takeFailure('list');
    if (fail) return { ok: false, error: { code: 'DB_UNAVAILABLE', message: 'db down' } };
    const all = [...this.rows.values()]
      .filter((r) => r.aggregatorId === aggregatorId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return {
      ok: true,
      value: {
        rows: all.slice(options.offset, options.offset + options.limit),
        total: all.length,
      },
    };
  }

  async markUploaded(
    id: string,
    aggregatorId: string,
    s3Etag: string,
  ): Promise<StoreResult<BulkUpload>> {
    const fail = this.takeFailure('markUploaded');
    if (fail) return { ok: false, error: { code: 'DB_UNAVAILABLE', message: 'db down' } };
    const row = this.rows.get(id);
    if (!row || row.aggregatorId !== aggregatorId) {
      return { ok: false, error: { code: 'NOT_FOUND', message: 'not found' } };
    }
    if (row.status !== 'pending' && row.status !== 'uploaded') {
      return { ok: false, error: { code: 'INVALID_TRANSITION', message: 'bad transition' } };
    }
    const updated: BulkUpload = { ...row, status: 'uploaded', s3Etag, updatedAt: new Date() };
    this.rows.set(id, updated);
    return { ok: true, value: updated };
  }

  async deletePending(id: string, aggregatorId: string): Promise<StoreResult<void>> {
    const row = this.rows.get(id);
    if (row && row.aggregatorId === aggregatorId && row.status === 'pending') {
      this.rows.delete(id);
    }
    return { ok: true, value: undefined };
  }

  /** Test-only convenience: force a row's status (bypasses the state machine). */
  setStatus(id: string, status: BulkUpload['status'], extra: Partial<BulkUpload> = {}): void {
    const row = this.rows.get(id);
    if (!row) throw new Error(`no row ${id}`);
    this.rows.set(id, { ...row, status, ...extra });
  }

  get(id: string): BulkUpload | undefined {
    return this.rows.get(id);
  }
}

function buildUpload(overrides: Partial<BulkUpload> = {}): BulkUpload {
  const now = new Date('2026-08-01T00:00:00.000Z');
  return {
    id: 'upload-fixed',
    aggregatorId: AGG_A,
    participantType: 'seeker',
    s3Key: 'bulk-uploads/agg-a/upload-fixed/raw.csv',
    s3Etag: null,
    status: 'pending',
    statusReason: null,
    errorsCsvS3Key: null,
    schemaId: 'participant-seeker',
    schemaVersion: 'v1',
    uploadedBy: 'kc-1',
    lastProgressAt: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    ...overrides,
  };
}

const AGG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AGG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const VALID_CONSENT_CFG = {
  audiences: {
    aggregator: {
      documents: {
        terms: { current_version: 1 },
        privacy: { current_version: 1 },
        bulk_upload_attestation: { current_version: 1 },
      },
    },
  },
};

describe('bulk-uploads routes', () => {
  let app: FastifyInstance;
  let store: BulkUploadsStoreFake;
  let consentLedger: ConsentLedgerFake;
  let redisHmget: ReturnType<typeof vi.fn>;
  let redisHget: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    _resetJwks();
    process.env.KEYCLOAK_URL = 'http://kc.local';
    process.env.KEYCLOAK_REALM = 'aggregator';

    onboardingRows = [];
    dbUpdateSpy.mockClear();

    headObjectMock.mockReset();
    signBulkUploadUrlMock.mockReset();
    signErrorsCsvDownloadUrlMock.mockReset();
    enqueueBulkFileProcessMock.mockReset().mockResolvedValue(undefined);
    loadConsentConfigMock.mockReset().mockResolvedValue(VALID_CONSENT_CFG);

    signBulkUploadUrlMock.mockResolvedValue({
      url: 'https://s3.example.invalid/put-url',
      key: 'bulk-uploads/agg/upload-1/raw.csv',
      expiresAt: '2026-08-01T01:00:00.000Z',
      contentType: 'text/csv',
      maxBytes: 10 * 1024 * 1024,
    });
    signErrorsCsvDownloadUrlMock.mockResolvedValue({
      url: 'https://s3.example.invalid/get-url',
      key: 'bulk-uploads/upload-1/errors.csv',
      expiresAt: '2026-08-01T01:00:00.000Z',
    });

    _setNetworkConfig(buildBlueDotConfig());

    store = new BulkUploadsStoreFake();
    _setBulkUploadsStore(store);

    consentLedger = new ConsentLedgerFake();
    _setConsentLedger(consentLedger);

    redisHmget = vi.fn().mockResolvedValue(['0', '0', '0']);
    redisHget = vi.fn().mockResolvedValue(null);
    _setRedis({ hmget: redisHmget, hget: redisHget } as never);

    _setAccessTokenVerifier(async (token) => {
      if (token === 'no-agg-id') {
        return { sub: 'kc-noagg', decision_made: 'approved' };
      }
      if (token === 'pending') {
        return { sub: 'kc-1', aggregator_id: AGG_A, decision_made: 'pending' };
      }
      if (token === 'seeker-approved') {
        return {
          sub: 'kc-1',
          aggregator_id: AGG_A,
          aggregator_type: 'seeker',
          decision_made: 'approved',
        };
      }
      if (token === 'provider-approved') {
        return {
          sub: 'kc-2',
          aggregator_id: AGG_A,
          aggregator_type: 'provider',
          decision_made: 'approved',
        };
      }
      if (token === 'no-type-approved') {
        return { sub: 'kc-3', aggregator_id: AGG_A, decision_made: 'approved' };
      }
      if (token === 'seeker-approved-b') {
        return {
          sub: 'kc-4',
          aggregator_id: AGG_B,
          aggregator_type: 'seeker',
          decision_made: 'approved',
        };
      }
      throw new Error('invalid token');
    });

    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    _setBulkUploadsStore(null);
    _setConsentLedger(null);
    _setRedis(null);
    _setAccessTokenVerifier(null);
    _setNetworkConfig(null);
  });

  const AUTH = (token: string) => ({ authorization: `Bearer ${token}` });

  // ── GET /v1/bulk-uploads/template ───────────────────────────────────────

  describe('GET /v1/bulk-uploads/template', () => {
    // ── format=xlsx (#564) ───────────────────────────────────────────────
    // The workbook exists to prevent upload errors CSV cannot describe, so the
    // assertions that matter are that it is a real workbook, that it is derived
    // from the SCHEMA rather than the curated CSV sample, and that its columns
    // still match what the parser accepts.

    it('returns a workbook for format=xlsx', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/bulk-uploads/template?participant_type=seeker&format=xlsx',
        headers: AUTH('seeker-approved'),
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      // One workbook per participant type, named for it.
      expect(res.headers['content-disposition']).toContain('seeker-template.xlsx');
      // An .xlsx is a ZIP: the magic bytes prove bytes survived the response
      // path rather than being decoded as text somewhere.
      expect(res.rawPayload.subarray(0, 2).toString('latin1')).toBe('PK');
    });

    it('builds the workbook from the live schema, not from any shipped artifact', async () => {
      // The shipped `bulk-samples/*.csv` were deleted for rotting (24 columns
      // against a 36-column schema, 18 of 20 rows failing on stale enums), so
      // the columns must come from the network config in force. Renaming a
      // property there has to change the header.
      const cfg = buildBlueDotConfig();
      const seeker = cfg.domains['seeker']!;
      _setNetworkConfig({
        ...cfg,
        domains: {
          ...cfg.domains,
          seeker: {
            ...seeker,
            schema: {
              type: 'object',
              required: ['renamedByConfig'],
              properties: { renamedByConfig: { type: 'string', title: 'Renamed' } },
            },
          },
        },
      });
      const res = await app.inject({
        method: 'GET',
        url: '/v1/bulk-uploads/template?participant_type=seeker&format=xlsx',
        headers: AUTH('seeker-approved'),
      });
      expect(res.statusCode).toBe(200);
      expect(res.rawPayload.subarray(0, 2).toString('latin1')).toBe('PK');

      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(res.rawPayload as unknown as ExcelJS.Buffer);
      const header = wb.getWorksheet('4. Enter your seekers')!.getRow(1).getCell(1).value;
      expect(String(header)).toBe('renamedByConfig');
      _setNetworkConfig(buildBlueDotConfig());
    });

    it('still serves CSV when format is omitted', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/bulk-uploads/template?participant_type=seeker',
        headers: AUTH('seeker-approved'),
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
    });

    it('rejects an unknown format rather than silently serving CSV', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/bulk-uploads/template?participant_type=seeker&format=pdf',
        headers: AUTH('seeker-approved'),
      });
      expect(res.statusCode).toBe(400);
    });

    it('enforces the aggregator type on the xlsx path too', async () => {
      // The workbook is per participant type now, so the gate applies to it
      // exactly as it does to the CSV — a seeker coordinator has no business
      // downloading the provider grid.
      const res = await app.inject({
        method: 'GET',
        url: '/v1/bulk-uploads/template?participant_type=provider&format=xlsx',
        headers: AUTH('seeker-approved'),
      });
      expect(res.statusCode).toBe(403);
    });

    it('requires participant_type for xlsx, as for csv', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/bulk-uploads/template?format=xlsx',
        headers: AUTH('seeker-approved'),
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: { code: string } }).error.code).toBe('SCHEMA_VALIDATION');
    });

    it('carries the four operator-facing tabs for that one type', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/bulk-uploads/template?participant_type=seeker&format=xlsx',
        headers: AUTH('seeker-approved'),
      });
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(res.rawPayload as unknown as ExcelJS.Buffer);
      expect(wb.worksheets.map((s) => s.name)).toEqual([
        '1. Instructions',
        'Lists',
        '2. Allowed values',
        '3. Sample data',
        '4. Enter your seekers',
      ]);
    });

    it('401s without a token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/bulk-uploads/template?participant_type=seeker',
      });
      expect(res.statusCode).toBe(401);
    });

    it('401s when the token has no aggregator_id claim', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/bulk-uploads/template?participant_type=seeker',
        headers: AUTH('no-agg-id'),
      });
      expect(res.statusCode).toBe(401);
    });

    it('403 NOT_APPROVED when decision_made is pending', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/bulk-uploads/template?participant_type=seeker',
        headers: AUTH('pending'),
      });
      expect(res.statusCode).toBe(403);
      expect((res.json() as { error: { code: string } }).error.code).toBe('NOT_APPROVED');
    });

    it('400 SCHEMA_VALIDATION when participant_type is missing', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/bulk-uploads/template',
        headers: AUTH('seeker-approved'),
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: { code: string } }).error.code).toBe('SCHEMA_VALIDATION');
    });

    it('400 SCHEMA_VALIDATION when participant_type is not a valid domain', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/bulk-uploads/template?participant_type=bogus',
        headers: AUTH('seeker-approved'),
      });
      expect(res.statusCode).toBe(400);
    });

    it('403 AGGREGATOR_TYPE_MISSING when the token has no aggregator_type claim', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/bulk-uploads/template?participant_type=seeker',
        headers: AUTH('no-type-approved'),
      });
      expect(res.statusCode).toBe(403);
      expect((res.json() as { error: { code: string } }).error.code).toBe(
        'AGGREGATOR_TYPE_MISSING',
      );
    });

    it('403 AGGREGATOR_TYPE_MISMATCH when requesting a different type than registered', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/bulk-uploads/template?participant_type=provider',
        headers: AUTH('seeker-approved'),
      });
      expect(res.statusCode).toBe(403);
      expect((res.json() as { error: { code: string } }).error.code).toBe(
        'AGGREGATOR_TYPE_MISMATCH',
      );
    });

    it('200s with a schema-generated CSV', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/bulk-uploads/template?participant_type=seeker',
        headers: AUTH('seeker-approved'),
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toContain('seeker-template.csv');
    });

    it('serves a CSV header matching the workbook, so one cannot drift', async () => {
      // The operator fills the workbook's grid and exports it to CSV, and an
      // API caller generates from the CSV template. Both have to be the file
      // `bulk-row-process` accepts, so their headers must be identical — the
      // divergence the deleted shipped samples had introduced.
      const csv = await app.inject({
        method: 'GET',
        url: '/v1/bulk-uploads/template?participant_type=seeker',
        headers: AUTH('seeker-approved'),
      });
      const xlsx = await app.inject({
        method: 'GET',
        url: '/v1/bulk-uploads/template?participant_type=seeker&format=xlsx',
        headers: AUTH('seeker-approved'),
      });
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(xlsx.rawPayload as unknown as ExcelJS.Buffer);
      const sheetHeader: string[] = [];
      wb.getWorksheet('4. Enter your seekers')!
        .getRow(1)
        .eachCell((c) => sheetHeader.push(String(c.value)));

      expect(sheetHeader.join(',')).toBe(csv.body.split('\n')[0]);
    });

    it('500 INTERNAL when the schema loader cannot resolve the participant schema', async () => {
      const broken: ResolvedNetworkConfig = {
        ...buildBlueDotConfig(),
        domains: {}, // domainIds still advertises 'seeker'/'provider' but domains is empty
      };
      _setNetworkConfig(broken);
      const res = await app.inject({
        method: 'GET',
        url: '/v1/bulk-uploads/template?participant_type=seeker',
        headers: AUTH('seeker-approved'),
      });
      expect(res.statusCode).toBe(500);
      expect((res.json() as { error: { code: string } }).error.code).toBe('INTERNAL');
      _setNetworkConfig(buildBlueDotConfig());
    });
  });

  // ── POST /v1/bulk-uploads ────────────────────────────────────────────────

  describe('POST /v1/bulk-uploads', () => {
    it('401s without a token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/bulk-uploads',
        payload: { participant_type: 'seeker' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('400 SCHEMA_VALIDATION on an empty participant_type', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/bulk-uploads',
        headers: AUTH('seeker-approved'),
        payload: { participant_type: '' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('400 SCHEMA_VALIDATION when participant_type is not a live domain', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/bulk-uploads',
        headers: AUTH('seeker-approved'),
        payload: { participant_type: 'bogus' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('403 AGGREGATOR_TYPE_MISMATCH when creating for a different type', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/bulk-uploads',
        headers: AUTH('seeker-approved'),
        payload: { participant_type: 'provider' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('503 DB_UNAVAILABLE when the store fails to reserve the row', async () => {
      store.failOnce('create', 'DB_UNAVAILABLE');
      const res = await app.inject({
        method: 'POST',
        url: '/v1/bulk-uploads',
        headers: AUTH('seeker-approved'),
        payload: { participant_type: 'seeker' },
      });
      expect(res.statusCode).toBe(503);
      expect((res.json() as { error: { code: string } }).error.code).toBe('DB_UNAVAILABLE');
    });

    it('201s with a pre-signed PUT URL on success', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/bulk-uploads',
        headers: AUTH('seeker-approved'),
        payload: { participant_type: 'seeker' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as Record<string, unknown>;
      expect(body.upload_url).toBe('https://s3.example.invalid/put-url');
      expect(body.status).toBe('pending');
      expect(body.schema_id).toBe('participant-seeker');
      expect(body.schema_version).toBe('v1');
      expect(dbUpdateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ s3Key: 'bulk-uploads/agg/upload-1/raw.csv' }),
      );
    });
  });

  // ── POST /v1/bulk-uploads/:id/start ──────────────────────────────────────

  describe('POST /v1/bulk-uploads/:id/start', () => {
    it('401s without a token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/bulk-uploads/upload-1/start',
        payload: { attestation: true },
      });
      expect(res.statusCode).toBe(401);
    });

    it('503 DB_UNAVAILABLE when findById fails', async () => {
      store.failOnce('findById', 'DB_UNAVAILABLE');
      const res = await app.inject({
        method: 'POST',
        url: '/v1/bulk-uploads/upload-1/start',
        headers: AUTH('seeker-approved'),
        payload: { attestation: true },
      });
      expect(res.statusCode).toBe(503);
    });

    it('403 FORBIDDEN when the upload belongs to another aggregator (no enumeration leak)', async () => {
      store.seed([buildUpload({ id: 'upload-x', aggregatorId: AGG_B })]);
      const res = await app.inject({
        method: 'POST',
        url: '/v1/bulk-uploads/upload-x/start',
        headers: AUTH('seeker-approved'),
        payload: { attestation: true },
      });
      expect(res.statusCode).toBe(403);
      expect((res.json() as { error: { code: string } }).error.code).toBe('FORBIDDEN');
    });

    it('403 FORBIDDEN when the upload id does not exist', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/bulk-uploads/does-not-exist/start',
        headers: AUTH('seeker-approved'),
        payload: { attestation: true },
      });
      expect(res.statusCode).toBe(403);
    });

    it('is idempotent (200, no S3/enqueue work) when already past pending/uploaded', async () => {
      store.seed([buildUpload({ id: 'upload-done', aggregatorId: AGG_A, status: 'completed' })]);
      const res = await app.inject({
        method: 'POST',
        url: '/v1/bulk-uploads/upload-done/start',
        headers: AUTH('seeker-approved'),
        payload: { attestation: true },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { status: string }).status).toBe('completed');
      expect(headObjectMock).not.toHaveBeenCalled();
      expect(enqueueBulkFileProcessMock).not.toHaveBeenCalled();
    });

    it('400 CONSENT_REQUIRED when attestation is not true', async () => {
      store.seed([buildUpload({ id: 'upload-1', aggregatorId: AGG_A })]);
      const res = await app.inject({
        method: 'POST',
        url: '/v1/bulk-uploads/upload-1/start',
        headers: AUTH('seeker-approved'),
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: { code: string } }).error.code).toBe('CONSENT_REQUIRED');
    });

    it('400 SCHEMA_VALIDATION when the S3 object is missing', async () => {
      store.seed([buildUpload({ id: 'upload-1', aggregatorId: AGG_A })]);
      headObjectMock.mockResolvedValue(null);
      const res = await app.inject({
        method: 'POST',
        url: '/v1/bulk-uploads/upload-1/start',
        headers: AUTH('seeker-approved'),
        payload: { attestation: true },
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: { detail: string } }).error.detail).toContain('not found');
    });

    it('400 SCHEMA_VALIDATION when the uploaded CSV is empty', async () => {
      store.seed([buildUpload({ id: 'upload-1', aggregatorId: AGG_A })]);
      headObjectMock.mockResolvedValue({ etag: 'e1', contentLength: 0 });
      const res = await app.inject({
        method: 'POST',
        url: '/v1/bulk-uploads/upload-1/start',
        headers: AUTH('seeker-approved'),
        payload: { attestation: true },
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: { detail: string } }).error.detail).toContain('empty');
    });

    it('400 SCHEMA_VALIDATION when the uploaded CSV exceeds the max size', async () => {
      store.seed([buildUpload({ id: 'upload-1', aggregatorId: AGG_A })]);
      headObjectMock.mockResolvedValue({ etag: 'e1', contentLength: 999_999_999 });
      const res = await app.inject({
        method: 'POST',
        url: '/v1/bulk-uploads/upload-1/start',
        headers: AUTH('seeker-approved'),
        payload: { attestation: true },
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: { detail: string } }).error.detail).toContain('too large');
    });

    it('500 CONSENT_WRITE_FAILED when consent config fails to load (fail-closed)', async () => {
      store.seed([buildUpload({ id: 'upload-1', aggregatorId: AGG_A })]);
      headObjectMock.mockResolvedValue({ etag: 'e1', contentLength: 1000 });
      loadConsentConfigMock.mockRejectedValueOnce(new Error('config disk error'));
      const res = await app.inject({
        method: 'POST',
        url: '/v1/bulk-uploads/upload-1/start',
        headers: AUTH('seeker-approved'),
        payload: { attestation: true },
      });
      expect(res.statusCode).toBe(500);
      expect((res.json() as { error: { code: string } }).error.code).toBe('CONSENT_WRITE_FAILED');
      // No state transition and no enqueue happened — fail-closed.
      expect(store.get('upload-1')?.status).toBe('pending');
      expect(enqueueBulkFileProcessMock).not.toHaveBeenCalled();
    });

    it('500 CONSENT_WRITE_FAILED when the bulk_upload_attestation document is not configured', async () => {
      store.seed([buildUpload({ id: 'upload-1', aggregatorId: AGG_A })]);
      headObjectMock.mockResolvedValue({ etag: 'e1', contentLength: 1000 });
      loadConsentConfigMock.mockResolvedValueOnce({
        audiences: {
          aggregator: {
            documents: { terms: { current_version: 1 }, privacy: { current_version: 1 } },
          },
        },
      });
      const res = await app.inject({
        method: 'POST',
        url: '/v1/bulk-uploads/upload-1/start',
        headers: AUTH('seeker-approved'),
        payload: { attestation: true },
      });
      expect(res.statusCode).toBe(500);
      expect((res.json() as { error: { code: string } }).error.code).toBe('CONSENT_WRITE_FAILED');
    });

    it('500 CONSENT_WRITE_FAILED when the ledger write itself fails', async () => {
      store.seed([buildUpload({ id: 'upload-1', aggregatorId: AGG_A })]);
      headObjectMock.mockResolvedValue({ etag: 'e1', contentLength: 1000 });
      consentLedger.recordRegistrationConsent = async () => ({
        success: false as const,
        error: Object.assign(new Error('ledger down'), {
          name: 'UpstreamError',
          code: 'CONSENT_INSERT_FAILED',
        }) as BaseError,
      });
      const res = await app.inject({
        method: 'POST',
        url: '/v1/bulk-uploads/upload-1/start',
        headers: AUTH('seeker-approved'),
        payload: { attestation: true },
      });
      expect(res.statusCode).toBe(500);
      expect((res.json() as { error: { code: string } }).error.code).toBe('CONSENT_WRITE_FAILED');
    });

    it('503 DB_UNAVAILABLE when markUploaded fails', async () => {
      store.seed([buildUpload({ id: 'upload-1', aggregatorId: AGG_A })]);
      headObjectMock.mockResolvedValue({ etag: 'e1', contentLength: 1000 });
      store.failOnce('markUploaded', 'DB_UNAVAILABLE');
      const res = await app.inject({
        method: 'POST',
        url: '/v1/bulk-uploads/upload-1/start',
        headers: AUTH('seeker-approved'),
        payload: { attestation: true },
      });
      expect(res.statusCode).toBe(503);
    });

    it('500 INTERNAL when enqueue fails after the row is already marked uploaded', async () => {
      store.seed([buildUpload({ id: 'upload-1', aggregatorId: AGG_A })]);
      headObjectMock.mockResolvedValue({ etag: 'e1', contentLength: 1000 });
      enqueueBulkFileProcessMock.mockRejectedValueOnce(new Error('redis down'));
      const res = await app.inject({
        method: 'POST',
        url: '/v1/bulk-uploads/upload-1/start',
        headers: AUTH('seeker-approved'),
        payload: { attestation: true },
      });
      expect(res.statusCode).toBe(500);
      expect((res.json() as { error: { code: string } }).error.code).toBe('INTERNAL');
      // The row is left 'uploaded' — recovery is via the worker watchdog, not a retry here.
      expect(store.get('upload-1')?.status).toBe('uploaded');
    });

    it('200s and enqueues the file-process job on success', async () => {
      store.seed([buildUpload({ id: 'upload-1', aggregatorId: AGG_A })]);
      headObjectMock.mockResolvedValue({ etag: 'e1', contentLength: 1000 });
      const res = await app.inject({
        method: 'POST',
        url: '/v1/bulk-uploads/upload-1/start',
        headers: AUTH('seeker-approved'),
        payload: { attestation: true },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { status: string; upload_id: string };
      expect(body.status).toBe('uploaded');
      expect(enqueueBulkFileProcessMock).toHaveBeenCalledWith(
        expect.objectContaining({ uploadId: 'upload-1', aggregatorId: AGG_A }),
      );
      const ledgerRows = consentLedger.list();
      expect(ledgerRows).toHaveLength(1);
      expect(ledgerRows[0]?.source).toBe('bulk_upload:upload-1:v1');
    });
  });

  // ── GET /v1/bulk-uploads ─────────────────────────────────────────────────

  describe('GET /v1/bulk-uploads', () => {
    it('401s without a token', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/bulk-uploads' });
      expect(res.statusCode).toBe(401);
    });

    it('400 SCHEMA_VALIDATION when limit is out of bounds', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/bulk-uploads?limit=0',
        headers: AUTH('seeker-approved'),
      });
      expect(res.statusCode).toBe(400);
    });

    it('400 SCHEMA_VALIDATION when offset is negative', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/bulk-uploads?offset=-1',
        headers: AUTH('seeker-approved'),
      });
      expect(res.statusCode).toBe(400);
    });

    it('503 DB_UNAVAILABLE when the store fails', async () => {
      store.failOnce('list', 'DB_UNAVAILABLE');
      const res = await app.inject({
        method: 'GET',
        url: '/v1/bulk-uploads',
        headers: AUTH('seeker-approved'),
      });
      expect(res.statusCode).toBe(503);
    });

    it('200s with per-row counters from the right source per status', async () => {
      store.seed([
        buildUpload({ id: 'u-pending', aggregatorId: AGG_A, status: 'pending' }),
        buildUpload({ id: 'u-live', aggregatorId: AGG_A, status: 'row_processing' }),
        buildUpload({ id: 'u-done', aggregatorId: AGG_A, status: 'completed' }),
      ]);
      onboardingRows = [{ batchId: 'u-done', total: 10, passed: 8, failed: 2, skipped: 0 }];
      redisHmget.mockResolvedValue(['3', '1', '0']);
      redisHget.mockResolvedValue('4');

      const res = await app.inject({
        method: 'GET',
        url: '/v1/bulk-uploads?limit=10&offset=0',
        headers: AUTH('seeker-approved'),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        items: Array<{ upload_id: string; total_rows: number | null; passed: number }>;
        total: number;
        limit: number;
        offset: number;
      };
      expect(body.total).toBe(3);
      expect(body.limit).toBe(10);
      expect(body.offset).toBe(0);
      const byId = new Map(body.items.map((i) => [i.upload_id, i]));
      expect(byId.get('u-pending')).toMatchObject({ total_rows: null, passed: 0 });
      expect(byId.get('u-live')).toMatchObject({ total_rows: 4, passed: 3 });
      expect(byId.get('u-done')).toMatchObject({ total_rows: 10, passed: 8 });
    });

    it('only returns uploads scoped to the caller aggregator', async () => {
      store.seed([
        buildUpload({ id: 'mine', aggregatorId: AGG_A }),
        buildUpload({ id: 'theirs', aggregatorId: AGG_B }),
      ]);
      const res = await app.inject({
        method: 'GET',
        url: '/v1/bulk-uploads',
        headers: AUTH('seeker-approved'),
      });
      const body = res.json() as { items: Array<{ upload_id: string }> };
      expect(body.items.map((i) => i.upload_id)).toEqual(['mine']);
    });
  });

  // ── GET /v1/bulk-uploads/:id ─────────────────────────────────────────────

  describe('GET /v1/bulk-uploads/:id', () => {
    it('401s without a token', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/bulk-uploads/upload-1' });
      expect(res.statusCode).toBe(401);
    });

    it('503 DB_UNAVAILABLE when findById fails', async () => {
      store.failOnce('findById', 'DB_UNAVAILABLE');
      const res = await app.inject({
        method: 'GET',
        url: '/v1/bulk-uploads/upload-1',
        headers: AUTH('seeker-approved'),
      });
      expect(res.statusCode).toBe(503);
    });

    it('403 FORBIDDEN for a cross-aggregator read (no enumeration leak)', async () => {
      store.seed([buildUpload({ id: 'upload-1', aggregatorId: AGG_B })]);
      const res = await app.inject({
        method: 'GET',
        url: '/v1/bulk-uploads/upload-1',
        headers: AUTH('seeker-approved'),
      });
      expect(res.statusCode).toBe(403);
    });

    it('200s with ZERO_COUNTS for a pending upload', async () => {
      store.seed([buildUpload({ id: 'upload-1', aggregatorId: AGG_A, status: 'pending' })]);
      const res = await app.inject({
        method: 'GET',
        url: '/v1/bulk-uploads/upload-1',
        headers: AUTH('seeker-approved'),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { total_rows: number | null; passed: number };
      expect(body.total_rows).toBeNull();
      expect(body.passed).toBe(0);
    });

    it('200s with onboarding-rollup counts for a completed upload', async () => {
      store.seed([buildUpload({ id: 'upload-1', aggregatorId: AGG_A, status: 'completed' })]);
      onboardingRows = [{ batchId: 'upload-1', total: 20, passed: 18, failed: 2, skipped: 0 }];
      const res = await app.inject({
        method: 'GET',
        url: '/v1/bulk-uploads/upload-1',
        headers: AUTH('seeker-approved'),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { total_rows: number | null; passed: number; failed: number };
      expect(body.total_rows).toBe(20);
      expect(body.passed).toBe(18);
      expect(body.failed).toBe(2);
    });

    it('falls back to ZERO_COUNTS when the onboarding rollup row is missing for a completed upload', async () => {
      store.seed([buildUpload({ id: 'upload-1', aggregatorId: AGG_A, status: 'completed' })]);
      onboardingRows = [];
      const res = await app.inject({
        method: 'GET',
        url: '/v1/bulk-uploads/upload-1',
        headers: AUTH('seeker-approved'),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { total_rows: number | null };
      expect(body.total_rows).toBeNull();
    });

    it('200s with Redis-backed live counters for an in-flight upload', async () => {
      store.seed([buildUpload({ id: 'upload-1', aggregatorId: AGG_A, status: 'row_processing' })]);
      redisHmget.mockResolvedValue(['5', '2', '1']);
      redisHget.mockResolvedValue('20');
      const res = await app.inject({
        method: 'GET',
        url: '/v1/bulk-uploads/upload-1',
        headers: AUTH('seeker-approved'),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        total_rows: number | null;
        passed: number;
        failed: number;
        skipped: number;
      };
      expect(body).toMatchObject({ total_rows: 20, passed: 5, failed: 2, skipped: 1 });
    });

    it('falls back to ZERO_COUNTS when Redis is unreachable', async () => {
      store.seed([buildUpload({ id: 'upload-1', aggregatorId: AGG_A, status: 'row_processing' })]);
      redisHmget.mockRejectedValue(new Error('redis down'));
      const res = await app.inject({
        method: 'GET',
        url: '/v1/bulk-uploads/upload-1',
        headers: AUTH('seeker-approved'),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { total_rows: number | null; passed: number };
      expect(body.total_rows).toBeNull();
      expect(body.passed).toBe(0);
    });
  });

  // ── GET /v1/bulk-uploads/:id/errors.csv ──────────────────────────────────

  describe('GET /v1/bulk-uploads/:id/errors.csv', () => {
    it('401s without a token', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/bulk-uploads/upload-1/errors.csv' });
      expect(res.statusCode).toBe(401);
    });

    it('503 DB_UNAVAILABLE when findById fails', async () => {
      store.failOnce('findById', 'DB_UNAVAILABLE');
      const res = await app.inject({
        method: 'GET',
        url: '/v1/bulk-uploads/upload-1/errors.csv',
        headers: AUTH('seeker-approved'),
      });
      expect(res.statusCode).toBe(503);
    });

    it('403 FORBIDDEN for a cross-aggregator request', async () => {
      store.seed([buildUpload({ id: 'upload-1', aggregatorId: AGG_B })]);
      const res = await app.inject({
        method: 'GET',
        url: '/v1/bulk-uploads/upload-1/errors.csv',
        headers: AUTH('seeker-approved'),
      });
      expect(res.statusCode).toBe(403);
    });

    it('410 BULK_UPLOAD_NOT_READY when the upload has not completed', async () => {
      store.seed([buildUpload({ id: 'upload-1', aggregatorId: AGG_A, status: 'row_processing' })]);
      const res = await app.inject({
        method: 'GET',
        url: '/v1/bulk-uploads/upload-1/errors.csv',
        headers: AUTH('seeker-approved'),
      });
      expect(res.statusCode).toBe(410);
      expect((res.json() as { error: { code: string } }).error.code).toBe('BULK_UPLOAD_NOT_READY');
    });

    it('404 NOT_FOUND when the upload completed clean (no errors.csv key)', async () => {
      store.seed([
        buildUpload({
          id: 'upload-1',
          aggregatorId: AGG_A,
          status: 'completed',
          errorsCsvS3Key: null,
        }),
      ]);
      const res = await app.inject({
        method: 'GET',
        url: '/v1/bulk-uploads/upload-1/errors.csv',
        headers: AUTH('seeker-approved'),
      });
      expect(res.statusCode).toBe(404);
      expect((res.json() as { error: { detail: string } }).error.detail).toContain('all rows');
    });

    it('404 NOT_FOUND when the stored errors.csv key does not match the canonical layout', async () => {
      store.seed([
        buildUpload({
          id: 'upload-1',
          aggregatorId: AGG_A,
          status: 'completed',
          errorsCsvS3Key: 'some/other/path.csv',
        }),
      ]);
      const res = await app.inject({
        method: 'GET',
        url: '/v1/bulk-uploads/upload-1/errors.csv',
        headers: AUTH('seeker-approved'),
      });
      expect(res.statusCode).toBe(404);
      expect(signErrorsCsvDownloadUrlMock).not.toHaveBeenCalled();
    });

    it('200s with a signed download URL + final counts on success', async () => {
      store.seed([
        buildUpload({
          id: 'upload-1',
          aggregatorId: AGG_A,
          status: 'completed',
          errorsCsvS3Key: 'bulk-uploads/upload-1/errors.csv',
        }),
      ]);
      onboardingRows = [{ batchId: 'upload-1', total: 5, passed: 3, failed: 2, skipped: 0 }];
      const res = await app.inject({
        method: 'GET',
        url: '/v1/bulk-uploads/upload-1/errors.csv',
        headers: AUTH('seeker-approved'),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        url: string;
        s3_key: string;
        counts: { total_rows: number | null; failed: number };
      };
      expect(body.url).toBe('https://s3.example.invalid/get-url');
      expect(body.s3_key).toBe('bulk-uploads/upload-1/errors.csv');
      expect(body.counts.total_rows).toBe(5);
      expect(body.counts.failed).toBe(2);
    });
  });

  // Sanity check that the aggregator-scoping in these fakes actually matches
  // the auth token used across the suite (guards against a copy-paste bug in
  // the fixtures above making every "cross-aggregator" test vacuously pass).
  it('sanity: seeker-approved-b resolves to AGG_B for future cross-agg tests', async () => {
    store.seed([buildUpload({ id: 'cross-check', aggregatorId: AGG_B })]);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/bulk-uploads/cross-check',
      headers: AUTH('seeker-approved-b'),
    });
    expect(res.statusCode).toBe(200);
  });
});
