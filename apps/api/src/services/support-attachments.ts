/**
 * Support-form attachment policy: which files may be attached and how big.
 *
 * Copies signals-dpg's `apps/api/src/support/attachments.ts`; both products
 * must accept the same files. Change both together.
 *
 * Pure (limits are passed in). Belongs to `@aggregator-dpg/api`.
 */

/** One attachment as it arrives on the wire. */
export interface SupportAttachmentInput {
  filename: string;
  contentType: string;
  /** Base64, no `data:` prefix. */
  data: string;
}

export type SupportAttachmentErrorCode =
  | 'ATTACHMENT_COUNT_EXCEEDED'
  | 'ATTACHMENT_TOO_LARGE'
  | 'ATTACHMENT_TYPE_NOT_ALLOWED'
  | 'ATTACHMENT_INVALID_ENCODING';

export interface AcceptedSupportAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
  bytes: number;
}

export type SupportAttachmentResult =
  | { ok: true; attachments: AcceptedSupportAttachment[] }
  | { ok: false; error: SupportAttachmentErrorCode; detail: string };

/**
 * Content types the support form accepts.
 *
 * `contentType` is declared by the client and not checked against the bytes,
 * so this is a convenience filter only. The support mailbox must still scan
 * what it receives (see SETUP.md).
 *
 * The web form reads this list from `GET /v1/support/config`. It includes
 * phone formats (HEIC, `.m4a`, 3GPP, AMR) and `x-` variants such as
 * `audio/x-m4a`, which browsers report for `.m4a` files.
 */
export const SUPPORT_ALLOWED_CONTENT_TYPES: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/3gpp',
  'video/x-m4v',
  'audio/mpeg',
  'audio/mp4',
  'audio/x-m4a',
  'audio/aac',
  'audio/wav',
  'audio/x-wav',
  'audio/ogg',
  'audio/webm',
  'audio/3gpp',
  'audio/amr',
];

/**
 * Extensions for the file picker's `accept` attribute, alongside the MIME list.
 *
 * Needed because macOS does not match `.m4a` to `audio/mp4` in the picker.
 * A picker hint only; validation stays MIME-based.
 */
export const SUPPORT_ALLOWED_EXTENSIONS: readonly string[] = [
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.heic',
  '.heif',
  '.mp4',
  '.m4v',
  '.mov',
  '.webm',
  '.3gp',
  '.mp3',
  '.m4a',
  '.aac',
  '.wav',
  '.ogg',
  '.oga',
  '.amr',
];

const MAX_FILENAME_LENGTH = 120;

/**
 * Base64 alphabet plus optional padding.
 *
 * A single character class with no grouped quantifier, so matching is linear
 * and large inputs cannot overflow the regex stack. With the `length % 4`
 * check it accepts the same input as the notification service's `z.base64()`.
 */
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Strips whitespace and checks the result really is base64.
 *
 * `Buffer.from(x, 'base64')` ignores invalid characters, so bad input would
 * decode to a corrupt file without error. Wrapped base64 is compacted, not rejected.
 *
 * @param data - Raw `data` value as submitted.
 * @returns The compacted base64, or null when it is not base64 at all.
 */
export function normaliseBase64(data: string): string | null {
  const compact = data.replace(/\s/g, '');
  if (!compact || compact.length % 4 !== 0 || !BASE64_RE.test(compact)) return null;
  return compact;
}

/**
 * Computes the decoded byte length of a base64 string without decoding it.
 *
 * @param data - Base64 string, optionally containing whitespace.
 * @returns Decoded size in bytes.
 */
export function decodedBase64Length(data: string): number {
  const compact = data.replace(/\s/g, '');
  if (compact.length === 0) return 0;
  return Math.floor((compact.length * 3) / 4) - base64Padding(compact);
}

/**
 * Counts the `=` padding characters at the end of a base64 string.
 *
 * @param compact - Whitespace-free base64.
 * @returns 0, 1 or 2.
 */
function base64Padding(compact: string): number {
  if (compact.endsWith('==')) return 2;
  if (compact.endsWith('=')) return 1;
  return 0;
}

/**
 * Makes a client-supplied filename safe for a MIME header.
 *
 * Drops directories, strips control characters and quotes, collapses
 * whitespace and caps the length.
 *
 * @param filename - Raw filename from the client.
 * @returns A safe filename; `attachment` when nothing usable remains.
 */
export function sanitizeFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .replace(/[\u0000-\u001F\u007F"']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'attachment';
  return cleaned.slice(0, MAX_FILENAME_LENGTH);
}

/**
 * Formats a size for the email's attachment list and error messages.
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
 * Validates a submitted attachment list against the instance's limits and
 * decodes what it accepts.
 *
 * Checks count, then type, then total size.
 *
 * @param attachments - Submitted attachments, if any.
 * @param limits - Configured maximum file count and total decoded bytes.
 * @returns The decoded attachments, or the rejection to reply with.
 */
export function validateSupportAttachments(
  attachments: SupportAttachmentInput[] | undefined,
  limits: { maxFiles: number; maxTotalBytes: number },
): SupportAttachmentResult {
  const list = attachments ?? [];
  if (list.length === 0) return { ok: true, attachments: [] };

  if (list.length > limits.maxFiles) {
    return {
      ok: false,
      error: 'ATTACHMENT_COUNT_EXCEEDED',
      detail: `Attach at most ${limits.maxFiles} file${limits.maxFiles === 1 ? '' : 's'}.`,
    };
  }

  let totalBytes = 0;
  // Validated, compacted base64 per item; decoded below.
  const normalised: string[] = [];
  for (const item of list) {
    const contentType = item.contentType.trim().toLowerCase();
    if (!SUPPORT_ALLOWED_CONTENT_TYPES.includes(contentType)) {
      return {
        ok: false,
        error: 'ATTACHMENT_TYPE_NOT_ALLOWED',
        detail: `${sanitizeFilename(item.filename)} is not an accepted file type. Attach an image, video or audio file.`,
      };
    }
    // Buffer.from ignores invalid base64, so validate first.
    const data = normaliseBase64(item.data);
    if (!data) {
      return {
        ok: false,
        error: 'ATTACHMENT_INVALID_ENCODING',
        detail: `${sanitizeFilename(item.filename)} could not be read. Please attach the file again.`,
      };
    }
    normalised.push(data);
    totalBytes += decodedBase64Length(data);
  }

  if (totalBytes > limits.maxTotalBytes) {
    return {
      ok: false,
      error: 'ATTACHMENT_TOO_LARGE',
      detail: `Attachments must total no more than ${formatBytes(limits.maxTotalBytes)}.`,
    };
  }

  // Decode only after every check passes.
  const accepted = list.map((item, index) => {
    const content = Buffer.from(normalised[index]!, 'base64');
    return {
      filename: sanitizeFilename(item.filename),
      contentType: item.contentType.trim().toLowerCase(),
      content,
      bytes: content.byteLength,
    };
  });

  return { ok: true, attachments: accepted };
}

/** Envelope headroom over the base64-inflated attachment budget. */
const ENVELOPE_HEADROOM_BYTES = 256 * 1024;

/**
 * Computes the HTTP body limit for an attachment budget.
 *
 * Allows for base64's 4/3 growth plus the rest of the JSON form.
 *
 * @param maxTotalBytes - Configured total decoded attachment budget.
 * @returns Body limit in bytes.
 */
export function supportBodyLimitBytes(maxTotalBytes: number): number {
  return Math.ceil((maxTotalBytes * 4) / 3) + ENVELOPE_HEADROOM_BYTES;
}
