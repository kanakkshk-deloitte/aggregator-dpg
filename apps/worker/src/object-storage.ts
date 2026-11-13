/**
 * S3 access for the worker app.
 *
 * Streams uploaded CSVs, writes errors.csv and export CSVs, and signs export
 * download links.
 */

import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';
import { config } from './config.js';

// Two clients:
//   - `getClient()` uses the internal `S3_ENDPOINT` for GET and PUT.
//   - `getPresignerClient()` uses `S3_PUBLIC_ENDPOINT` (else `S3_ENDPOINT`),
//     because signed URLs include the host and must be reachable by a browser.
let cachedClient: S3Client | null = null;
let cachedPresignerClient: S3Client | null = null;

/** TCP connect timeout. */
const S3_CONNECTION_TIMEOUT_MS = 5_000;
/** Total attempts per request, including the first. */
const S3_MAX_ATTEMPTS = 3;
/**
 * Timeout for one upload call.
 *
 * Set per call, since the client has only a connect timeout so streaming GETs are not cut off.
 */
const S3_UPLOAD_TIMEOUT_MS = 60_000;

function buildClient(endpoint: string | undefined): S3Client {
  return new S3Client({
    region: config.S3_REGION,
    ...(endpoint ? { endpoint } : {}),
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
    // Only the connect phase is bounded, so long streaming downloads are not aborted.
    maxAttempts: S3_MAX_ATTEMPTS,
    requestHandler: { connectionTimeout: S3_CONNECTION_TIMEOUT_MS },
    ...(config.S3_ACCESS_KEY_ID && config.S3_SECRET_ACCESS_KEY
      ? {
          credentials: {
            accessKeyId: config.S3_ACCESS_KEY_ID,
            secretAccessKey: config.S3_SECRET_ACCESS_KEY,
          },
        }
      : {}),
  });
}

function getClient(): S3Client {
  if (cachedClient) return cachedClient;
  cachedClient = buildClient(config.S3_ENDPOINT);
  return cachedClient;
}

function getPresignerClient(): S3Client {
  if (cachedPresignerClient) return cachedPresignerClient;
  cachedPresignerClient = buildClient(config.S3_PUBLIC_ENDPOINT || config.S3_ENDPOINT);
  return cachedPresignerClient;
}

/**
 * Returns the CSV object body as a Node `Readable` without buffering it.
 *
 * The caller owns the stream and must consume or destroy it.
 *
 * @param s3Key - Key of the uploaded CSV object.
 * @returns The object body as a Node `Readable`.
 * @throws {Error} If the object has no body.
 */
export async function getCsvStream(s3Key: string): Promise<Readable> {
  const result = await getClient().send(
    new GetObjectCommand({ Bucket: config.S3_BUCKET, Key: s3Key }),
  );
  const body = result.Body;
  if (!body) {
    throw new Error(`empty body for s3 key: ${s3Key}`);
  }
  // In the Node runtime the AWS SDK returns a Node.js Readable.
  return body as Readable;
}

/**
 * Uploads an object to S3, with a per-call timeout.
 */
export async function putObject(key: string, body: Buffer, contentType: string): Promise<void> {
  const abort = AbortSignal.timeout(S3_UPLOAD_TIMEOUT_MS);
  await getClient().send(
    new PutObjectCommand({
      Bucket: config.S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
    { abortSignal: abort },
  );
}

export interface SignedDownloadUrl {
  url: string;
  key: string;
  /** ISO 8601 expiry timestamp. */
  expiresAt: string;
}

/**
 * Signs a GET URL for a participant export CSV.
 *
 * Uses the public endpoint and serves the file as an attachment. Valid for
 * `EXPORT_URL_TTL_SECONDS`. The link is sent by email, never returned to the API caller.
 *
 * @param key - The S3 object key of the export CSV.
 * @returns The signed URL, its key, and an ISO expiry timestamp.
 */
export async function signExportDownloadUrl(key: string): Promise<SignedDownloadUrl> {
  const command = new GetObjectCommand({
    Bucket: config.S3_BUCKET,
    Key: key,
    ResponseContentDisposition: 'attachment; filename="participant-export.csv"',
    ResponseContentType: 'text/csv',
  });
  const url = await getSignedUrl(getPresignerClient(), command, {
    expiresIn: config.EXPORT_URL_TTL_SECONDS,
  });
  const expiresAt = new Date(Date.now() + config.EXPORT_URL_TTL_SECONDS * 1000).toISOString();
  return { url, key, expiresAt };
}

/** Clears the cached clients, for tests. */
export function _resetObjectStorageClient(): void {
  cachedClient = null;
  cachedPresignerClient = null;
}
