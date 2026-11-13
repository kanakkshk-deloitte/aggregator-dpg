/**
 * Error thrown by api route handlers and rendered by the global error handler.
 *
 * Carries the catalogue entry so the handler can build the response and log.
 */

import { ERR, type ErrorCatalogueEntry, type ErrorCode } from './codes.js';

export interface HttpErrorOptions {
  /** Optional structured payload merged into the response under `error.fields`. */
  fields?: Record<string, unknown>;
  /** Underlying cause (logged, never sent to client). */
  cause?: unknown;
  /** Override the catalogue detail for this specific occurrence. */
  detail?: string;
}

export class HttpError extends Error {
  readonly code: string;
  readonly status: number;
  readonly title: string;
  readonly detail: string;
  readonly hint: string;
  readonly docs?: string;
  readonly fields?: Record<string, unknown>;

  constructor(entry: ErrorCatalogueEntry, options: HttpErrorOptions = {}) {
    super(options.detail ?? entry.detail, { cause: options.cause });
    this.name = 'HttpError';
    this.code = entry.code;
    this.status = entry.status;
    this.title = entry.title;
    this.detail = options.detail ?? entry.detail;
    this.hint = entry.hint;
    if (entry.docs !== undefined) this.docs = entry.docs;
    if (options.fields !== undefined) this.fields = options.fields;
    Object.setPrototypeOf(this, HttpError.prototype);
  }
}

/** Builds an HttpError from a catalogue key. */
export function httpError(code: ErrorCode, options?: HttpErrorOptions): HttpError {
  return new HttpError(ERR[code], options);
}
