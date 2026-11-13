/**
 * Streaming CSV parser for the bulk file processor in the worker app.
 *
 * Decodes the stream as strict UTF-8, checks the header against the schema,
 * enforces the row-count and row-size limits, and returns the validated rows.
 * Parsing is incremental, so the event loop is not blocked on large files.
 *
 * Rows are returned only after the whole file parses, so a rejected file
 * enqueues no rows. Memory is bounded by `maxRows`.
 *
 * @module @aggregator-dpg/worker
 */

import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import Papa from 'papaparse';

/**
 * The bulk CSV field delimiter, used for every parse of an upload.
 *
 * Set explicitly because auto-detect can pick the array delimiter (`|`) instead.
 */
export const CSV_FIELD_DELIMITER = ',';

/** Reasons the File Processor can reject a file before per-row work begins. */
export type FileFailureReason =
  | 'encoding_unsupported'
  | 'header_mismatch'
  | 'empty_csv'
  | 'row_cap_exceeded'
  | 'row_size_exceeded'
  | 'schema_unavailable'
  | 'system_error';

/** A single validated data row produced by {@link streamCsvParse}. */
export interface StreamedRow {
  /** Zero-based index among non-empty data rows (excludes the header). */
  rowIndex: number;
  /** Parsed cell values keyed by trimmed header name. */
  payload: Record<string, string>;
  /**
   * The record's cells as parsed, which may be shorter or wider than the header.
   * Stored under `bu:{id}:lines` so the finaliser can rebuild errors.csv.
   */
  cells: string[];
}

/** Validation inputs and caps for {@link streamCsvParse}. */
export interface StreamCsvOptions {
  /** Required header columns (from the schema `required` array). */
  required: string[];
  /**
   * Permitted header columns: schema properties plus `WELL_KNOWN_COLUMNS`.
   * Any other column fails the file.
   */
  allowed: ReadonlySet<string>;
  /** Maximum number of data rows; exceeding it fails `row_cap_exceeded`. */
  maxRows: number;
  /** Maximum bytes for a single reconstructed row line. */
  maxRowBytes: number;
}

/** Outcome of a streaming parse: validated rows, or a typed failure. */
export type StreamCsvResult =
  | { status: 'ok'; headers: string[]; rows: StreamedRow[] }
  | { status: 'failed'; reason: FileFailureReason; detail?: string };

/** Marker error so the pipeline can distinguish a decode failure from any other. */
class EncodingError extends Error {
  constructor() {
    super('encoding_unsupported: stream is not valid UTF-8');
    this.name = 'EncodingError';
  }
}

/** Carries a typed file-level failure out of the streaming pipeline. */
class ParseFailure extends Error {
  constructor(
    public readonly reason: FileFailureReason,
    public readonly detail?: string,
  ) {
    super(reason);
    this.name = 'ParseFailure';
  }
}

/**
 * Returns a Transform that decodes bytes to UTF-8 strings and rejects invalid UTF-8.
 *
 * A leading BOM is stripped.
 *
 * @returns A Transform suitable for piping an S3 object body through.
 */
export function createUtf8DecodeStream(): Transform {
  // `fatal` throws on malformed input. `stream: true` keeps state so a
  // character split across chunks decodes correctly.
  const decoder = new TextDecoder('utf-8', { fatal: true });
  return new Transform({
    decodeStrings: true,
    transform(chunk: Buffer, _enc, cb) {
      try {
        cb(null, decoder.decode(chunk, { stream: true }));
      } catch {
        cb(new EncodingError());
      }
    },
    flush(cb) {
      try {
        // Final decode fails on a trailing partial sequence.
        cb(null, decoder.decode());
      } catch {
        cb(new EncodingError());
      }
    },
  });
}

/**
 * Streams and validates a CSV, returning its data rows for enqueueing.
 *
 * Checks run in order: encoding, header, empty file, per-row limits.
 * On any failure no rows are returned.
 *
 * @param input - The CSV as a Node byte stream (e.g. an S3 body) or a string.
 * @param options - Required/allowed columns and the row-count / row-byte caps.
 * @returns `ok` with validated rows + headers, or a typed `failed` result.
 */
export async function streamCsvParse(
  input: Readable | string,
  options: StreamCsvOptions,
): Promise<StreamCsvResult> {
  // Parse as raw arrays. PapaParse's header mode in stream input can re-read
  // the header from data rows on later chunks. The first record is the header;
  // later records map to it by column index.
  const parseStream = Papa.parse(Papa.NODE_STREAM_INPUT, {
    header: false,
    skipEmptyLines: 'greedy',
    delimiter: CSV_FIELD_DELIMITER,
  });

  const byteSrc = typeof input === 'string' ? Readable.from([Buffer.from(input, 'utf8')]) : input;

  let headers: string[] | null = null;
  const rows: StreamedRow[] = [];

  const validateHeaders = (
    hdrs: string[],
  ): { reason: FileFailureReason; detail?: string } | null => {
    const headerSet = new Set(hdrs);
    const missing = options.required.filter((f) => !headerSet.has(f));
    if (missing.length > 0) {
      return { reason: 'header_mismatch', detail: `missing: ${missing.join(',')}` };
    }
    const unknown = hdrs.filter((h) => !options.allowed.has(h));
    if (unknown.length > 0) {
      return { reason: 'header_mismatch', detail: `unknown: ${unknown.join(',')}` };
    }
    return null;
  };

  try {
    await pipeline(
      byteSrc,
      createUtf8DecodeStream(),
      parseStream,
      async (parsed: AsyncIterable<string[]>) => {
        for await (const record of parsed) {
          // The first non-empty record is the header.
          if (headers === null) {
            headers = record.map((h) => String(h ?? '').trim());
            const headerFailure = validateHeaders(headers);
            if (headerFailure) throw new ParseFailure(headerFailure.reason, headerFailure.detail);
            continue;
          }
          // `cells` keeps the record as-is, including surplus cells. The size
          // limit is measured on the stored form.
          const cells = record.map((c) => String(c ?? ''));
          if (Buffer.byteLength(JSON.stringify(cells), 'utf8') > options.maxRowBytes) {
            throw new ParseFailure('row_size_exceeded');
          }
          if (rows.length + 1 > options.maxRows) {
            throw new ParseFailure('row_cap_exceeded', String(rows.length + 1));
          }
          // Map cells to columns by position. Surplus cells stay only in `cells`.
          const payload: Record<string, string> = {};
          for (let i = 0; i < headers.length; i += 1) {
            const value = record[i];
            if (typeof value === 'string') payload[headers[i]!] = value;
          }
          rows.push({ rowIndex: rows.length, payload, cells });
        }
      },
    );
  } catch (err) {
    if (err instanceof EncodingError) {
      return { status: 'failed', reason: 'encoding_unsupported' };
    }
    if (err instanceof ParseFailure) {
      return {
        status: 'failed',
        reason: err.reason,
        ...(err.detail !== undefined ? { detail: err.detail } : {}),
      };
    }
    return { status: 'failed', reason: 'system_error', detail: (err as Error).message };
  }

  // No header or no data rows means an empty file.
  if (headers === null || rows.length === 0) {
    return { status: 'failed', reason: 'empty_csv' };
  }

  return { status: 'ok', headers, rows };
}
