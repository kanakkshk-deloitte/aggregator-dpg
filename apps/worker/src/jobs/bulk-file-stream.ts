/**
 * Streaming CSV parse core for the Bulk File Processor.
 *
 * This module is the pure, I/O-free heart of file processing. It consumes a
 * byte or string stream, decodes it as strict UTF-8, validates the header
 * against the active schema, enforces the row-count and per-row-byte caps, and
 * returns the validated rows for the caller to enqueue.
 *
 * Why streaming: the previous implementation buffered the whole object into a
 * single string and ran a synchronous `Papa.parse` over it (plus a
 * `body.split('\n')` copy), blocking the worker event loop for the parse
 * duration and spiking heap to a multiple of the file size. Parsing the S3
 * body stream incrementally removes both: the parser yields to the event loop
 * between network chunks and only a bounded window of rows is resident.
 *
 * Atomicity: validation can fail late (e.g. a row past `maxRows`). To preserve
 * the invariant that a rejected file onboards **zero** rows, this function does
 * not enqueue as it parses — it accumulates validated rows and returns them so
 * the caller enqueues only after a fully successful parse. Memory stays bounded
 * by `maxRows`, well under the old whole-file blow-up.
 *
 * @module @aggregator-dpg/worker
 */

import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import Papa from 'papaparse';

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
   * The original record re-serialised verbatim as one CSV line — a ragged row
   * keeps its own cell count (shorter or wider than the header). The Finaliser
   * stores this under `bu:{id}:lines` and re-parses it positionally to rebuild
   * errors.csv, so it must round-trip through `Papa.parse(header:false)`.
   */
  rawLine: string;
}

/** Validation inputs and caps for {@link streamCsvParse}. */
export interface StreamCsvOptions {
  /** Required header columns (from the schema `required` array). */
  required: string[];
  /** Permitted header columns (the schema `properties` keys). */
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
 * Returns a Transform that decodes a byte stream to UTF-8 strings, rejecting
 * any non-UTF-8 input instead of emitting U+FFFD replacement characters. A
 * leading BOM is stripped (the default `TextDecoder` behaviour).
 *
 * @returns A Transform suitable for piping an S3 object body through.
 */
export function createUtf8DecodeStream(): Transform {
  // fatal:true → decode() throws on malformed sequences. The decoder keeps
  // state across chunks (stream:true) so a multi-byte char split across two
  // network chunks is not mistaken for invalid input.
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
        // Final decode with stream:false surfaces a dangling partial sequence.
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
 * Validation precedence matches the previous whole-file implementation:
 * encoding → header (missing/unknown columns) → empty → per-row caps. On any
 * failure no rows are returned, so the caller onboards nothing.
 *
 * @param input - The CSV as a Node byte stream (e.g. an S3 body) or a string.
 * @param options - Required/allowed columns and the row-count / row-byte caps.
 * @returns `ok` with validated rows + headers, or a typed `failed` result.
 */
export async function streamCsvParse(
  input: Readable | string,
  options: StreamCsvOptions,
): Promise<StreamCsvResult> {
  // Parse as raw arrays (`header: false`), NOT PapaParse's header mode. In
  // `NODE_STREAM_INPUT` + `header: true`, PapaParse re-invokes its header
  // logic on later internal chunk cycles (once input crosses its ~1 KB
  // boundary), passing *data-row* cells — which clobbered the derived header
  // list and produced false `header_mismatch` on big files (#500). Building
  // row objects through that machinery leaves the payload hostage to the same
  // re-derivation. Raw arrays sidestep it entirely: the first record is the
  // header (validated once), every later record maps to it strictly by column
  // index, regardless of chunking, blank cells, or file size.
  const parseStream = Papa.parse(Papa.NODE_STREAM_INPUT, {
    header: false,
    skipEmptyLines: 'greedy',
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
          // First non-empty record is the header row. Validate it and move on —
          // it is not a data row.
          if (headers === null) {
            headers = record.map((h) => String(h ?? '').trim());
            const headerFailure = validateHeaders(headers);
            if (headerFailure) throw new ParseFailure(headerFailure.reason, headerFailure.detail);
            continue;
          }
          // rawLine (for errors.csv) is the original record verbatim, incl. any
          // surplus cells — it must round-trip through `Papa.parse(header:false)`.
          const rawLine = Papa.unparse([record], { header: false });
          if (Buffer.byteLength(rawLine, 'utf8') > options.maxRowBytes) {
            throw new ParseFailure('row_size_exceeded');
          }
          if (rows.length + 1 > options.maxRows) {
            throw new ParseFailure('row_cap_exceeded', String(rows.length + 1));
          }
          // Map cells to columns by position. Cells beyond the header width are
          // surplus (kept only in rawLine); payload carries schema-keyed fields.
          const payload: Record<string, string> = {};
          for (let i = 0; i < headers.length; i += 1) {
            const value = record[i];
            if (typeof value === 'string') payload[headers[i]!] = value;
          }
          rows.push({ rowIndex: rows.length, payload, rawLine });
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

  // No records at all → empty file. (A header-only file has `headers` set but
  // zero data rows; a bad header already failed above with header_mismatch.)
  if (headers === null || rows.length === 0) {
    return { status: 'failed', reason: 'empty_csv' };
  }

  return { status: 'ok', headers, rows };
}
