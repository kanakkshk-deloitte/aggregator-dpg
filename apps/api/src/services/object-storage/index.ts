/**
 * Object-storage service (`@aggregator-dpg/api`).
 *
 * Wraps the AWS S3 SDK: pre-signed upload and download URLs, HEAD and PUT.
 * Works with S3 and MinIO; MinIO needs `S3_ENDPOINT` and path-style addressing.
 */

import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../../config.js';

// Two S3 clients:
//   - `getInternalClient()` uses S3_ENDPOINT for all server-side calls.
//   - `getPresignerClient()` uses S3_PUBLIC_ENDPOINT, the host browsers can
//     reach; pre-signed URLs must use it. Defaults to S3_ENDPOINT.
let cachedInternalClient: S3Client | null = null;
let cachedPresignerClient: S3Client | null = null;

/** Bound the TCP-connect phase so a black-holed endpoint fails fast. */
const S3_CONNECTION_TIMEOUT_MS = 5_000;
/** Total attempts per request (1 initial + retries) using the SDK's backoff. */
const S3_MAX_ATTEMPTS = 3;

function buildClient(endpoint: string | undefined): S3Client {
  return new S3Client({
    region: config.S3_REGION,
    ...(endpoint ? { endpoint } : {}),
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
    // Only the connect phase has a timeout, so large streaming downloads are not cut off.
    // Matches apps/worker/src/object-storage.ts.
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

function getInternalClient(): S3Client {
  if (cachedInternalClient) return cachedInternalClient;
  cachedInternalClient = buildClient(config.S3_ENDPOINT);
  return cachedInternalClient;
}

function getPresignerClient(): S3Client {
  if (cachedPresignerClient) return cachedPresignerClient;
  const publicEndpoint = config.S3_PUBLIC_ENDPOINT || config.S3_ENDPOINT;
  cachedPresignerClient = buildClient(publicEndpoint);
  return cachedPresignerClient;
}

export interface SignedUploadUrl {
  url: string;
  /** S3 object key the URL grants PUT access to. */
  key: string;
  /** ISO 8601 expiry timestamp. */
  expiresAt: string;
  /** Content-Type the signature requires the client to send. */
  contentType: string;
  /** Maximum bytes the signature accepts. */
  maxBytes: number;
}

/**
 * Issues a pre-signed PUT URL for a bulk upload CSV.
 *
 * The signature constrains:
 *   - Content-Type: text/csv (signed; mismatch → S3 rejects with 403)
 *
 * The size is not signed; `/complete` checks it against BULK_UPLOAD_MAX_BYTES
 * with a HEAD request.
 *
 * @param uploadId - DB row id; used as the deterministic S3 key.
 * @param aggregatorId - Owner aggregator; used as a key prefix for grouping.
 */
export async function signBulkUploadUrl(opts: {
  uploadId: string;
  aggregatorId: string;
}): Promise<SignedUploadUrl> {
  const key = `bulk-uploads/${opts.aggregatorId}/${opts.uploadId}/raw.csv`;
  const command = new PutObjectCommand({
    Bucket: config.S3_BUCKET,
    Key: key,
    ContentType: 'text/csv',
  });
  const url = await getSignedUrl(getPresignerClient(), command, {
    expiresIn: config.BULK_UPLOAD_URL_TTL_SECONDS,
  });
  const expiresAt = new Date(Date.now() + config.BULK_UPLOAD_URL_TTL_SECONDS * 1000).toISOString();
  return {
    url,
    key,
    expiresAt,
    contentType: 'text/csv',
    maxBytes: config.BULK_UPLOAD_MAX_BYTES,
  };
}

export interface ObjectHead {
  etag: string;
  contentLength: number;
}

/**
 * HEAD an S3 object to confirm upload completion and capture its ETag.
 *
 * Returns null if the object does not exist (e.g. browser never completed
 * the PUT). Throws on transport errors so the caller can surface 503.
 */
export async function headObject(key: string): Promise<ObjectHead | null> {
  try {
    const result = await getInternalClient().send(
      new HeadObjectCommand({ Bucket: config.S3_BUCKET, Key: key }),
    );
    if (!result.ETag) return null;
    return {
      etag: result.ETag.replaceAll('"', ''),
      contentLength: typeof result.ContentLength === 'number' ? result.ContentLength : 0,
    };
  } catch (err: unknown) {
    const code = typeof err === 'object' && err !== null && 'name' in err ? String(err.name) : '';
    // S3 returns NotFound or NoSuchKey for missing objects.
    if (code === 'NotFound' || code === 'NoSuchKey') return null;
    throw err;
  }
}

/**
 * Uploads an object to S3. Currently has no callers.
 */
export async function putObject(key: string, body: Buffer, contentType: string): Promise<void> {
  await getInternalClient().send(
    new PutObjectCommand({
      Bucket: config.S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

export interface SignedDownloadUrl {
  url: string;
  key: string;
  /** ISO 8601 expiry timestamp. */
  expiresAt: string;
}

/**
 * Issues a pre-signed GET URL for a bulk-upload errors.csv artefact.
 *
 * Uses BULK_UPLOAD_URL_TTL_SECONDS as the URL lifetime.
 */
export async function signErrorsCsvDownloadUrl(key: string): Promise<SignedDownloadUrl> {
  const command = new GetObjectCommand({
    Bucket: config.S3_BUCKET,
    Key: key,
    ResponseContentDisposition: 'attachment; filename="errors.csv"',
    ResponseContentType: 'text/csv',
  });
  const url = await getSignedUrl(getPresignerClient(), command, {
    expiresIn: config.BULK_UPLOAD_URL_TTL_SECONDS,
  });
  const expiresAt = new Date(Date.now() + config.BULK_UPLOAD_URL_TTL_SECONDS * 1000).toISOString();
  return { url, key, expiresAt };
}

/** Test-only — clears the cached clients so fresh instances are built next call. */
export function _resetObjectStorageClient(): void {
  cachedInternalClient = null;
  cachedPresignerClient = null;
}
