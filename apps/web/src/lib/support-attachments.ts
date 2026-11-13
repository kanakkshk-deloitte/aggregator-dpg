/**
 * Client-side checks for support attachments.
 *
 * Lets a coordinator see size and type errors before uploading. The API checks
 * again. Mirrors signals-dpg's `apps/ui/src/lib/support-attachments.ts`; keep
 * both in sync.
 *
 * @module apps/web/src/lib/support-attachments
 */

/** What the instance allows, as served by `GET /api/support/config`. */
export interface SupportConfig {
  enabled: boolean;
  maxTotalBytes: number;
  maxFiles: number;
  allowedTypes: string[];
  /**
   * Extensions for the picker's `accept`, since macOS does not match some
   * extensions (e.g. `.m4a`) to their MIME type. Optional.
   */
  allowedExtensions?: string[];
}

/** One attachment in the request payload. */
export interface SupportAttachmentPayload {
  filename: string;
  contentType: string;
  /** Base64 without the `data:` prefix. */
  data: string;
}

/** Rejection reasons; the caller maps these to translated messages. */
export type AttachmentRejection =
  { reason: 'count' } | { reason: 'size' } | { reason: 'type'; filename: string };

export type AttachmentSelectionResult =
  { ok: true; files: File[] } | ({ ok: false } & AttachmentRejection);

/**
 * Used while the config loads or if it fails. Matches the API's defaults.
 */
export const SUPPORT_CONFIG_FALLBACK: SupportConfig = {
  enabled: true,
  maxTotalBytes: 5 * 1024 * 1024,
  maxFiles: 3,
  allowedTypes: ['image/*', 'video/*', 'audio/*'],
  allowedExtensions: [],
};

/**
 * Formats a byte count the same way the API does.
 *
 * @param bytes - Size in bytes.
 * @returns e.g. `512 B`, `2.0 KB`, `5.0 MB`.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Builds the picker's `accept` attribute from MIME types and extensions.
 *
 * Extensions are included because macOS does not map some (e.g. `.m4a`) to
 * their MIME type.
 *
 * @param config - Limits currently served by the API.
 * @returns A comma-separated `accept` value.
 */
export function pickerAccept(
  config: Pick<SupportConfig, 'allowedTypes' | 'allowedExtensions'>,
): string {
  return [...config.allowedTypes, ...(config.allowedExtensions ?? [])].join(',');
}

/**
 * Whether a file's type is accepted, by exact type or `type/*` wildcard.
 *
 * @param fileType - The browser-reported MIME type.
 * @param allowedTypes - Accepted types, exact or wildcard.
 * @returns True when the file may be attached.
 */
export function matchesAllowedType(fileType: string, allowedTypes: string[]): boolean {
  const type = fileType.trim().toLowerCase();
  if (!type) return false;
  return allowedTypes.some((allowed) => {
    const candidate = allowed.trim().toLowerCase();
    if (candidate === type) return true;
    if (!candidate.endsWith('/*')) return false;
    return type.startsWith(candidate.slice(0, -1));
  });
}

/**
 * Validates newly picked files against the combined selection.
 *
 * Checks count, then type, then total size, in the same order as the API.
 *
 * @param current - Files already chosen.
 * @param incoming - Files just picked.
 * @param config - The instance's limits.
 * @returns The merged selection, or the rejection to report.
 */
export function validateAttachmentSelection(
  current: File[],
  incoming: File[],
  config: Pick<SupportConfig, 'maxFiles' | 'maxTotalBytes' | 'allowedTypes'>,
): AttachmentSelectionResult {
  const files = [...current, ...incoming];
  if (files.length > config.maxFiles) return { ok: false, reason: 'count' };

  for (const file of incoming) {
    if (!matchesAllowedType(file.type, config.allowedTypes)) {
      return { ok: false, reason: 'type', filename: file.name };
    }
  }

  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > config.maxTotalBytes) return { ok: false, reason: 'size' };

  return { ok: true, files };
}

/**
 * Base64-encodes a file for the JSON body.
 *
 * Works in chunks to avoid a call-stack overflow on large files.
 *
 * @param file - The file to encode.
 * @returns Base64 string without a `data:` prefix.
 */
export async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const CHUNK_SIZE = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    binary += String.fromCodePoint(...bytes.subarray(offset, offset + CHUNK_SIZE));
  }
  return btoa(binary);
}

/**
 * Encodes the selection into the request payload shape.
 *
 * @param files - The chosen files.
 * @returns Payload entries, in the same order.
 */
export async function encodeAttachments(files: File[]): Promise<SupportAttachmentPayload[]> {
  return Promise.all(
    files.map(async (file) => ({
      filename: file.name,
      // Some browsers leave `type` empty; the API rejects an empty type.
      contentType: file.type || 'application/octet-stream',
      data: await fileToBase64(file),
    })),
  );
}
