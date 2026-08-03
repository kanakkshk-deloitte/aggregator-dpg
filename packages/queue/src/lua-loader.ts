/**
 * Lua script loader + EVALSHA executor.
 *
 * Reads a `.lua` file once at module init, computes its SHA1, and exposes
 * a bound execute function that uses EVALSHA for fast path and falls back
 * to EVAL on NOSCRIPT (Redis flushed scripts).
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Redis } from 'ioredis';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface LuaScript {
  source: string;
  sha1: string;
}

function loadScript(relPath: string): LuaScript {
  const filePath = path.resolve(__dirname, relPath);
  const source = readFileSync(filePath, 'utf8');
  const sha1 = createHash('sha1').update(source).digest('hex');
  return { source, sha1 };
}

const bulkRowCommitScript = loadScript('./lua/bulk_row_commit.lua');

export type BulkRowOutcome = 'passed' | 'failed' | 'skipped';

export interface BulkRowCommitResult {
  /** Total rows committed so far (SCARD). */
  processed: number;
  /** total_rows from meta, or -1 if not yet set by the File Processor. */
  total: number;
  /** 1 if the File Processor has marked reader_done; else 0. */
  readerDone: 0 | 1;
  /** 1 if this call was a fresh commit; 0 if it was a replay (no-op). */
  wasNew: 0 | 1;
}

/**
 * Runs the `bulk_row_commit.lua` script against Redis. Single round-trip.
 *
 * @param redis - ioredis client.
 * @param uploadId - bulk_uploads.id; used as the key namespace `bu:{id}:`.
 * @param rowIndex - row position in the original CSV (0-indexed after header).
 * @param outcome - 'passed' | 'failed' | 'skipped'.
 * @param errorPayloadJson - JSON-serialised error details when outcome != passed; empty string otherwise.
 * @param ttlSeconds - TTL (re)applied to every bu:{id} key so participant PII self-expires if the upload is abandoned/stuck; pass 0 to skip.
 */
export async function runBulkRowCommit(
  redis: Redis,
  uploadId: string,
  rowIndex: number,
  outcome: BulkRowOutcome,
  errorPayloadJson: string,
  ttlSeconds: number,
): Promise<BulkRowCommitResult> {
  const ns = `bu:${uploadId}`;
  const keys = [
    `${ns}:processed`,
    `${ns}:counters`,
    `${ns}:errors`,
    `${ns}:error_rows`,
    `${ns}:meta`,
  ];
  const args = [String(rowIndex), outcome, errorPayloadJson, String(ttlSeconds)];

  let raw: unknown;
  try {
    raw = await redis.evalsha(bulkRowCommitScript.sha1, keys.length, ...keys, ...args);
  } catch (err) {
    // NOSCRIPT — script not in Redis cache (e.g. server restart). Reload + retry.
    const message = (err as Error).message ?? '';
    if (message.includes('NOSCRIPT')) {
      raw = await redis.eval(bulkRowCommitScript.source, keys.length, ...keys, ...args);
    } else {
      throw err;
    }
  }

  if (!Array.isArray(raw) || raw.length !== 4) {
    throw new Error(`bulk_row_commit.lua returned unexpected shape: ${JSON.stringify(raw)}`);
  }
  const [processed, total, readerDone, wasNew] = raw as [number, number, number, number];
  return {
    processed,
    total,
    readerDone: (readerDone === 1 ? 1 : 0) as 0 | 1,
    wasNew: (wasNew === 1 ? 1 : 0) as 0 | 1,
  };
}

export { bulkRowCommitScript };
