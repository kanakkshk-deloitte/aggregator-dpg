/**
 * Unit tests for the worker S3 module. `@aws-sdk/client-s3` +
 * `@aws-sdk/s3-request-presigner` are mocked so no real S3/MinIO call is made,
 * and `./config.js` is mocked to drive the internal-vs-presigner client split.
 * Covers putObject, getCsvStream, and the campaign-export presign
 * (signExportDownloadUrl).
 *
 * @module @aggregator-dpg/worker
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
    GetObjectCommand: class extends MockCommand {},
    PutObjectCommand: class extends MockCommand {},
  };
});

const getSignedUrlMock = vi.fn();
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: getSignedUrlMock }));

const baseConfig = {
  S3_REGION: 'ap-south-1',
  S3_ENDPOINT: 'http://minio-internal:9000',
  S3_PUBLIC_ENDPOINT: undefined as string | undefined,
  S3_BUCKET: 'aggregator-bulk-uploads',
  S3_ACCESS_KEY_ID: undefined as string | undefined,
  S3_SECRET_ACCESS_KEY: undefined as string | undefined,
  S3_FORCE_PATH_STYLE: true,
  EXPORT_URL_TTL_SECONDS: 3600,
};
vi.mock('./config.js', () => ({
  get config() {
    return mockConfig;
  },
}));
let mockConfig = { ...baseConfig };

describe('worker object-storage', () => {
  beforeEach(() => {
    vi.resetModules();
    sendMock.mockReset();
    getSignedUrlMock.mockReset();
    s3ClientCtorCalls.length = 0;
    mockConfig = { ...baseConfig };
  });

  it('putObject sends a PutObjectCommand to the internal client', async () => {
    const { putObject } = await import('./object-storage.js');
    sendMock.mockResolvedValue({});
    await putObject('campaign-exports/o/x.csv', Buffer.from('hi'), 'text/csv');
    expect(sendMock).toHaveBeenCalledTimes(1);
    const cmd = sendMock.mock.calls[0]![0] as { input: Record<string, unknown> };
    expect(cmd.input).toMatchObject({
      Bucket: 'aggregator-bulk-uploads',
      Key: 'campaign-exports/o/x.csv',
      ContentType: 'text/csv',
    });
    expect(s3ClientCtorCalls[0]).toMatchObject({ endpoint: 'http://minio-internal:9000' });
  });

  it('signExportDownloadUrl signs a GET with the export TTL + csv attachment disposition', async () => {
    getSignedUrlMock.mockResolvedValue('https://signed.example/export.csv');
    const { signExportDownloadUrl } = await import('./object-storage.js');
    const res = await signExportDownloadUrl('campaign-exports/org-1/2026.csv');

    expect(res).toMatchObject({
      url: 'https://signed.example/export.csv',
      key: 'campaign-exports/org-1/2026.csv',
    });
    expect(typeof res.expiresAt).toBe('string');
    const cmd = getSignedUrlMock.mock.calls[0]![1] as { input: Record<string, unknown> };
    expect(cmd.input).toMatchObject({
      Bucket: 'aggregator-bulk-uploads',
      Key: 'campaign-exports/org-1/2026.csv',
      ResponseContentDisposition: 'attachment; filename="participant-export.csv"',
      ResponseContentType: 'text/csv',
    });
    expect(getSignedUrlMock.mock.calls[0]![2]).toMatchObject({ expiresIn: 3600 });
  });

  it('presigner falls back to S3_ENDPOINT when S3_PUBLIC_ENDPOINT is unset', async () => {
    getSignedUrlMock.mockResolvedValue('https://signed.example/x');
    const { signExportDownloadUrl } = await import('./object-storage.js');
    await signExportDownloadUrl('k');
    expect(s3ClientCtorCalls[0]).toMatchObject({ endpoint: 'http://minio-internal:9000' });
  });

  it('presigner uses S3_PUBLIC_ENDPOINT when set, distinct from the internal client', async () => {
    mockConfig.S3_PUBLIC_ENDPOINT = 'https://public.example.com';
    getSignedUrlMock.mockResolvedValue('https://signed.example/x');
    sendMock.mockResolvedValue({});
    const { signExportDownloadUrl, putObject } = await import('./object-storage.js');
    await signExportDownloadUrl('k'); // builds the presigner client first
    await putObject('k', Buffer.from('x'), 'text/csv'); // builds the internal client
    expect(s3ClientCtorCalls).toHaveLength(2);
    expect(s3ClientCtorCalls[0]).toMatchObject({ endpoint: 'https://public.example.com' });
    expect(s3ClientCtorCalls[1]).toMatchObject({ endpoint: 'http://minio-internal:9000' });
  });

  it('passes explicit credentials to the S3 client when both keys are set', async () => {
    mockConfig.S3_ACCESS_KEY_ID = 'AKIA_TEST';
    mockConfig.S3_SECRET_ACCESS_KEY = 'secret_test';
    sendMock.mockResolvedValue({});
    const { putObject } = await import('./object-storage.js');
    await putObject('k', Buffer.from('x'), 'text/csv');
    expect(s3ClientCtorCalls[0]).toMatchObject({
      credentials: { accessKeyId: 'AKIA_TEST', secretAccessKey: 'secret_test' },
    });
  });

  it('_resetObjectStorageClient clears both cached clients so fresh ones are built', async () => {
    sendMock.mockResolvedValue({});
    getSignedUrlMock.mockResolvedValue('https://signed.example/x');
    const { putObject, signExportDownloadUrl, _resetObjectStorageClient } =
      await import('./object-storage.js');
    await putObject('k', Buffer.from('x'), 'text/csv'); // internal client (1)
    await signExportDownloadUrl('k'); // presigner client (2)
    expect(s3ClientCtorCalls).toHaveLength(2);
    _resetObjectStorageClient();
    await putObject('k', Buffer.from('x'), 'text/csv'); // rebuilt (3)
    await signExportDownloadUrl('k'); // rebuilt (4)
    expect(s3ClientCtorCalls).toHaveLength(4);
  });

  it('getCsvStream returns the object body, and throws when it is empty', async () => {
    const { getCsvStream } = await import('./object-storage.js');
    sendMock.mockResolvedValue({ Body: 'a-readable-stream' });
    await expect(getCsvStream('k')).resolves.toBe('a-readable-stream');
    sendMock.mockResolvedValue({});
    await expect(getCsvStream('k')).rejects.toThrow(/empty body/);
  });
});
