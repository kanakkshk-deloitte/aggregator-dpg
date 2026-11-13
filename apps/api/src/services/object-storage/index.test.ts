/**
 * Unit tests for the S3-backed object-storage service.
 *
 * `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` are mocked (per
 * testing.md §1 — third-party adapters may be stubbed) so no real S3/MinIO
 * call is ever made. `../../config.js` is also mocked so each test controls
 * the S3 endpoint/credential permutations deterministically. Covers the
 * internal-vs-presigner client split, credential injection, the
 * NotFound/NoSuchKey → null mapping on `headObject`, and the transport-error
 * rethrow path.
 *
 * @module @aggregator-dpg/api
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const s3ClientCtorCalls: Array<Record<string, unknown>> = [];
const sendMock = vi.fn();

vi.mock('@aws-sdk/client-s3', () => {
  class MockS3Client {
    opts: Record<string, unknown>;
    send = sendMock;
    constructor(opts: Record<string, unknown>) {
      this.opts = opts;
      s3ClientCtorCalls.push(opts);
    }
  }
  class MockCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  return {
    S3Client: MockS3Client,
    HeadObjectCommand: class extends MockCommand {},
    PutObjectCommand: class extends MockCommand {},
    GetObjectCommand: class extends MockCommand {},
  };
});

const getSignedUrlMock = vi.fn();
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: getSignedUrlMock,
}));

const baseConfig = {
  S3_REGION: 'ap-south-1',
  S3_ENDPOINT: 'http://minio-internal:9000',
  S3_PUBLIC_ENDPOINT: undefined as string | undefined,
  S3_BUCKET: 'aggregator-bulk-uploads',
  S3_ACCESS_KEY_ID: undefined as string | undefined,
  S3_SECRET_ACCESS_KEY: undefined as string | undefined,
  S3_FORCE_PATH_STYLE: true,
  BULK_UPLOAD_URL_TTL_SECONDS: 900,
  BULK_UPLOAD_MAX_BYTES: 10 * 1024 * 1024,
};

vi.mock('../../config.js', () => ({
  get config() {
    return mockConfig;
  },
}));

let mockConfig = { ...baseConfig };

describe('object-storage', () => {
  beforeEach(() => {
    vi.resetModules();
    sendMock.mockReset();
    getSignedUrlMock.mockReset();
    s3ClientCtorCalls.length = 0;
    mockConfig = { ...baseConfig };
  });

  describe('client construction', () => {
    it('builds the internal client from S3_ENDPOINT without credentials when unset', async () => {
      const { headObject } = await import('./index.js');
      sendMock.mockResolvedValue({ ETag: '"abc"', ContentLength: 10 });
      await headObject('some/key');
      expect(s3ClientCtorCalls).toHaveLength(1);
      expect(s3ClientCtorCalls[0]).toMatchObject({
        region: 'ap-south-1',
        endpoint: 'http://minio-internal:9000',
        forcePathStyle: true,
      });
      expect(s3ClientCtorCalls[0]).not.toHaveProperty('credentials');
    });

    it('includes credentials when both access key and secret are set', async () => {
      mockConfig.S3_ACCESS_KEY_ID = 'AKIA123';
      mockConfig.S3_SECRET_ACCESS_KEY = 'secret123';
      const { headObject } = await import('./index.js');
      sendMock.mockResolvedValue({ ETag: '"abc"', ContentLength: 1 });
      await headObject('k');
      expect(s3ClientCtorCalls[0]).toMatchObject({
        credentials: { accessKeyId: 'AKIA123', secretAccessKey: 'secret123' },
      });
    });

    it('reuses the cached internal client across calls', async () => {
      const { headObject } = await import('./index.js');
      sendMock.mockResolvedValue({ ETag: '"abc"', ContentLength: 1 });
      await headObject('k1');
      await headObject('k2');
      expect(s3ClientCtorCalls).toHaveLength(1);
    });

    it('falls back to S3_ENDPOINT for the presigner client when S3_PUBLIC_ENDPOINT is unset', async () => {
      const { signBulkUploadUrl } = await import('./index.js');
      getSignedUrlMock.mockResolvedValue('https://signed.example/upload');
      await signBulkUploadUrl({ uploadId: 'up-1', aggregatorId: 'agg-1' });
      expect(s3ClientCtorCalls[0]).toMatchObject({ endpoint: 'http://minio-internal:9000' });
    });

    it('uses S3_PUBLIC_ENDPOINT for the presigner client when set, distinct from the internal client', async () => {
      mockConfig.S3_PUBLIC_ENDPOINT = 'https://public.example.com';
      const { signBulkUploadUrl, headObject } = await import('./index.js');
      getSignedUrlMock.mockResolvedValue('https://signed.example/upload');
      sendMock.mockResolvedValue({ ETag: '"x"', ContentLength: 1 });
      await signBulkUploadUrl({ uploadId: 'up-1', aggregatorId: 'agg-1' });
      await headObject('k');
      expect(s3ClientCtorCalls).toHaveLength(2);
      expect(s3ClientCtorCalls[0]).toMatchObject({ endpoint: 'https://public.example.com' });
      expect(s3ClientCtorCalls[1]).toMatchObject({ endpoint: 'http://minio-internal:9000' });
    });

    it('_resetObjectStorageClient forces fresh clients on the next call', async () => {
      const { headObject, _resetObjectStorageClient } = await import('./index.js');
      sendMock.mockResolvedValue({ ETag: '"x"', ContentLength: 1 });
      await headObject('k1');
      _resetObjectStorageClient();
      await headObject('k2');
      expect(s3ClientCtorCalls).toHaveLength(2);
    });
  });

  describe('signBulkUploadUrl', () => {
    it('signs a deterministic key scoped to aggregator + upload id', async () => {
      const { signBulkUploadUrl } = await import('./index.js');
      getSignedUrlMock.mockResolvedValue('https://signed.example/upload?sig=1');
      const result = await signBulkUploadUrl({ uploadId: 'up-1', aggregatorId: 'agg-1' });
      expect(result.key).toBe('bulk-uploads/agg-1/up-1/raw.csv');
      expect(result.url).toBe('https://signed.example/upload?sig=1');
      expect(result.contentType).toBe('text/csv');
      expect(result.maxBytes).toBe(10 * 1024 * 1024);
    });

    it('expiresAt reflects BULK_UPLOAD_URL_TTL_SECONDS from config', async () => {
      const { signBulkUploadUrl } = await import('./index.js');
      getSignedUrlMock.mockResolvedValue('https://signed.example/upload');
      const before = Date.now();
      const result = await signBulkUploadUrl({ uploadId: 'up-1', aggregatorId: 'agg-1' });
      const expiresAt = new Date(result.expiresAt).getTime();
      expect(expiresAt - before).toBeGreaterThanOrEqual(900_000 - 1000);
      expect(expiresAt - before).toBeLessThan(900_000 + 5000);
    });
  });

  describe('headObject', () => {
    it('returns etag (unquoted) and contentLength on success', async () => {
      const { headObject } = await import('./index.js');
      sendMock.mockResolvedValue({ ETag: '"quoted-etag"', ContentLength: 1234 });
      const result = await headObject('bulk-uploads/agg-1/up-1/raw.csv');
      expect(result).toEqual({ etag: 'quoted-etag', contentLength: 1234 });
    });

    it('defaults contentLength to 0 when the SDK omits it', async () => {
      const { headObject } = await import('./index.js');
      sendMock.mockResolvedValue({ ETag: '"e"' });
      const result = await headObject('k');
      expect(result?.contentLength).toBe(0);
    });

    it('returns null when the SDK response has no ETag', async () => {
      const { headObject } = await import('./index.js');
      sendMock.mockResolvedValue({});
      const result = await headObject('k');
      expect(result).toBeNull();
    });

    it('returns null on a NotFound error', async () => {
      const { headObject } = await import('./index.js');
      sendMock.mockRejectedValue({ name: 'NotFound' });
      const result = await headObject('missing-key');
      expect(result).toBeNull();
    });

    it('returns null on a NoSuchKey error', async () => {
      const { headObject } = await import('./index.js');
      sendMock.mockRejectedValue({ name: 'NoSuchKey' });
      const result = await headObject('missing-key');
      expect(result).toBeNull();
    });

    it('rethrows on any other transport error', async () => {
      const { headObject } = await import('./index.js');
      const err = new Error('connection refused');
      sendMock.mockRejectedValue(err);
      await expect(headObject('k')).rejects.toThrow('connection refused');
    });

    it('rethrows a non-object thrown value untouched', async () => {
      const { headObject } = await import('./index.js');
      sendMock.mockRejectedValue('raw string failure');
      await expect(headObject('k')).rejects.toBe('raw string failure');
    });
  });

  describe('putObject', () => {
    it('sends a PutObjectCommand against the internal client', async () => {
      const { putObject } = await import('./index.js');
      sendMock.mockResolvedValue({});
      await putObject('qr/agg-1/link-1.png', Buffer.from('png-bytes'), 'image/png');
      expect(sendMock).toHaveBeenCalledTimes(1);
      const command = sendMock.mock.calls[0]?.[0] as { input: Record<string, unknown> };
      expect(command.input).toMatchObject({
        Bucket: 'aggregator-bulk-uploads',
        Key: 'qr/agg-1/link-1.png',
        ContentType: 'image/png',
      });
    });
  });

  describe('signErrorsCsvDownloadUrl', () => {
    it('signs a GET url with a csv attachment disposition', async () => {
      const { signErrorsCsvDownloadUrl } = await import('./index.js');
      getSignedUrlMock.mockResolvedValue('https://signed.example/errors.csv');
      const result = await signErrorsCsvDownloadUrl('bulk-uploads/agg-1/up-1/errors.csv');
      expect(result.url).toBe('https://signed.example/errors.csv');
      expect(result.key).toBe('bulk-uploads/agg-1/up-1/errors.csv');
      const [, command] = getSignedUrlMock.mock.calls[0] as [unknown, { input: unknown }];
      expect(command.input).toMatchObject({
        ResponseContentDisposition: 'attachment; filename="errors.csv"',
        ResponseContentType: 'text/csv',
      });
    });
  });
});
