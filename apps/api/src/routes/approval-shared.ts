/**
 * Shared helpers for the coordinator and org approval routes.
 *
 * HTML result pages, token error messages and the token-to-id check used by
 * both flows. Belongs to `@aggregator-dpg/api`.
 *
 * @module apps/api/src/routes/approval-shared
 */

import type { FastifyReply } from 'fastify';
import { renderResultPage } from '../views/approval-pages.js';
import { verifyApprovalToken } from '../services/approval-token.js';

/** Signed approval-token verification failure codes surfaced to the reviewer. */
export type TokenErrorCode = 'EXPIRED' | 'INVALID' | 'MALFORMED';

/** A rendered HTML page + the HTTP status it should be sent with. */
export interface HtmlPage {
  status: number;
  html: string;
}

/**
 * Sends an HTML page as a Fastify reply with the correct content type.
 *
 * @param reply - The Fastify reply to write to.
 * @param status - HTTP status code.
 * @param html - Rendered HTML body.
 * @returns The reply, for chaining/return.
 */
export function sendHtml(reply: FastifyReply, status: number, html: string): FastifyReply {
  return reply.status(status).type('text/html; charset=utf-8').send(html);
}

/**
 * Sends a pre-rendered {@link HtmlPage}.
 *
 * @param reply - The Fastify reply.
 * @param page - The page (status + html) to send.
 * @returns The reply, for chaining/return.
 */
export function sendPage(reply: FastifyReply, page: HtmlPage): FastifyReply {
  return sendHtml(reply, page.status, page.html);
}

/**
 * Maps a token verification error code to the message shown on the result page.
 *
 * @param code - The verification failure code.
 * @returns A single-sentence, reviewer-facing message.
 */
export function tokenErrorMessage(code: TokenErrorCode): string {
  switch (code) {
    case 'EXPIRED':
      return 'This approval link has expired. Use the resend option to get a fresh link.';
    case 'INVALID':
      return 'Approval link signature is invalid.';
    case 'MALFORMED':
    default:
      return 'Approval link is malformed.';
  }
}

/** The 400 page shown when the review link carries no token. */
export function missingTokenPage(): HtmlPage {
  return {
    status: 400,
    html: renderResultPage({
      status: 'error',
      title: 'Missing token',
      message: 'This link is missing the approval token.',
    }),
  };
}

/**
 * Builds the 400 page for an invalid or expired token.
 *
 * An expired token with a resend URL also gets a "Resend approval link" button.
 *
 * @param code - The verify failure code.
 * @param opts - Optional resend affordance (url + the expired-but-signed token).
 */
export function invalidTokenPage(
  code: TokenErrorCode,
  opts: { resendUrl?: string; token?: string } = {},
): HtmlPage {
  const isExpired = code === 'EXPIRED';
  return {
    status: 400,
    html: renderResultPage({
      status: 'error',
      title: isExpired ? 'Link expired' : 'Invalid link',
      message: tokenErrorMessage(code),
      ...(isExpired && opts.resendUrl && opts.token
        ? { action: { url: opts.resendUrl, token: opts.token, label: 'Resend approval link' } }
        : {}),
    }),
  };
}

/** The 400 page when a valid token's subject does not match the path id. */
export function tokenMismatchPage(noun: string): HtmlPage {
  return {
    status: 400,
    html: renderResultPage({
      status: 'error',
      title: 'Invalid link',
      message: `Token does not match the requested ${noun}.`,
    }),
  };
}

/** The 404 page when the record for the id no longer exists. */
export function notFoundPage(title: string, message: string): HtmlPage {
  return { status: 404, html: renderResultPage({ status: 'error', title, message }) };
}

/** The 503 page when a backing service (DB / IdP) is unavailable. */
export function serviceUnavailablePage(title: string, message: string): HtmlPage {
  return { status: 503, html: renderResultPage({ status: 'error', title, message }) };
}

/** Success of {@link verifyTokenForId}: the token is valid + bound to the id. */
export interface VerifiedToken {
  ok: true;
  intent: 'approve' | 'reject';
  aggregatorId: string;
  /** Org id claim, when the token carries one. */
  org?: string;
}

/**
 * Verifies a signed approval token and confirms it is bound to the given id.
 *
 * On failure returns the {@link HtmlPage} the caller should send.
 *
 * @param token - The raw JWT from the query/body.
 * @param id - The path id the token must be bound to.
 * @param noun - Entity noun for the mismatch message (e.g. `organisation`).
 * @param opts - `allowExpired` for the resend path; `resendUrl` to add the
 *   resend action on the expired page.
 * @returns The verified claims, or a `{ page }` to render.
 */
export async function verifyTokenForId(
  token: string,
  id: string,
  noun: string,
  opts: { allowExpired?: boolean; resendUrl?: string } = {},
): Promise<VerifiedToken | { ok: false; page: HtmlPage }> {
  const verified = await verifyApprovalToken(token, { allowExpired: opts.allowExpired ?? false });
  if (!verified.ok) {
    return {
      ok: false,
      page: invalidTokenPage(verified.error.code, {
        token,
        ...(opts.resendUrl ? { resendUrl: opts.resendUrl } : {}),
      }),
    };
  }
  if (verified.aggregatorId !== id) {
    return { ok: false, page: tokenMismatchPage(noun) };
  }
  return {
    ok: true,
    intent: verified.intent,
    aggregatorId: verified.aggregatorId,
    ...(verified.org ? { org: verified.org } : {}),
  };
}
