/**
 * Support / contact-form email — sent to SUPPORT_EMAIL when a coordinator
 * submits the in-app "Contact support" form. Carries the raised complaint /
 * support request, the (prefilled + editable) submitter contact details, a
 * human-readable reference, and the portal link so support can triage and
 * follow up (Reply-To is the submitter's email when present).
 *
 * Belongs to `@aggregator-dpg/api`.
 */

import { randomBytes } from 'node:crypto';
import { escapeHtml, renderShell } from './shared.js';

/** Kind of contact-support submission. */
export type SupportRequestType = 'complaint' | 'support_request';

/** Inputs for {@link renderSupportRequest}. */
export interface SupportRequestVars {
  /** Whether the submitter raised a complaint or a support request. */
  type: SupportRequestType;
  /** Submitter's name (prefilled from the session, editable at submit). */
  name: string;
  /** Submitter's email, or `null` when not provided. */
  email: string | null;
  /** Submitter's phone, or `null` when not provided. */
  phone: string | null;
  /** Free-text description of the complaint / request. */
  details: string;
  /** Human-readable tracking reference, e.g. `SUP-20260713-A1B2C3`. */
  reference: string;
  /** Portal origin the submission was raised from. Optional. */
  link?: string;
  /** Brand short-name used in the "Team {teamName}" sign-off. */
  teamName: string;
  /** When the form was submitted. */
  submittedAt: Date;
}

const REF_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** Collapse whitespace/newlines to single spaces (safe for an email header). */
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Maps the submission type to its display label. */
function typeLabel(type: SupportRequestType): string {
  return type === 'complaint' ? 'Complaint' : 'Support Request';
}

/**
 * Generates a support tracking reference of the form `SUP-YYYYMMDD-XXXXXX`,
 * where the date is UTC and the suffix is 6 uppercase alphanumeric characters
 * drawn from a cryptographic source. Pure and side-effect-free given its
 * clock argument, so the format is trivially asserted in tests.
 *
 * @param now - Timestamp to derive the UTC date from. Defaults to `new Date()`.
 * @returns A new support reference string.
 */
export function generateSupportReference(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const bytes = randomBytes(6);
  let suffix = '';
  for (let i = 0; i < 6; i++) {
    suffix += REF_ALPHABET[bytes[i]! % REF_ALPHABET.length];
  }
  return `SUP-${y}${m}${d}-${suffix}`;
}

/**
 * Renders the support-request email.
 *
 * @param v - The submitted complaint/request plus resolved submitter details,
 *   reference, portal link, and team (brand) name.
 * @returns The email `subject`, `html`, and plain-text `text` fallback.
 */
export function renderSupportRequest(v: SupportRequestVars): {
  subject: string;
  html: string;
  text: string;
} {
  const label = typeLabel(v.type);
  const link = v.link && v.link.trim() ? v.link.trim() : '';
  const subject = oneLine(
    `Issue Number: ${v.reference} — ${label} from ${v.name}` + (link ? ` from ${link}` : ''),
  );

  const submitted = `${v.submittedAt.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })} IST`;

  const phone = v.phone ?? '—';
  const email = v.email ?? '—';

  const contactRows: Array<[string, string]> = [
    ['Name', v.name],
    ['Phone', phone],
    ['Email', email],
  ];
  const contactRowsHtml = contactRows
    .map(
      ([k, val]) =>
        `<tr><td style="padding:6px 0;color:#475069;width:120px;">${escapeHtml(k)}</td>` +
        `<td style="padding:6px 0;color:#0b1020;">${escapeHtml(val)}</td></tr>`,
    )
    .join('');

  const linkHtml = link
    ? `<div style="margin:2px 0 12px;font-size:13px;color:#475069;">Raised from <a href="${escapeHtml(
        link,
      )}" style="color:#0b1020;">${escapeHtml(link)}</a></div>`
    : '';

  const body = `
<h1 style="font-size:20px;font-weight:700;margin:0 0 8px;color:#0b1020;">The below ${escapeHtml(
    label,
  )} has been raised by ${escapeHtml(v.name)}</h1>
<div style="margin:2px 0;font-size:13px;color:#475069;">Issue Number: <strong style="color:#0b1020;">${escapeHtml(
    v.reference,
  )}</strong></div>
${linkHtml}
<div style="margin:12px 0;padding:14px;background:#f7f8fb;border-radius:10px;font-size:14px;color:#0b1020;line-height:1.5;white-space:pre-wrap;">${escapeHtml(
    v.details,
  )}</div>
<div style="font-size:14px;font-weight:600;color:#0b1020;margin:18px 0 6px;">Contact details</div>
<table style="border-collapse:collapse;font-size:13px;">${contactRowsHtml}</table>
<div style="margin:12px 0;font-size:13px;color:#475069;">Consent to share contact: <strong style="color:#0b1020;">Yes</strong></div>
<div style="margin:2px 0 18px;font-size:12px;color:#475069;">Submitted at: ${escapeHtml(
    submitted,
  )}</div>
<div style="font-size:14px;color:#0b1020;line-height:1.5;">Regards,<br>Team ${escapeHtml(
    v.teamName,
  )}</div>`;

  const html = renderShell({ preheader: subject, bodyHtml: body });

  const text =
    `${subject}\n\n` +
    `The below ${label} has been raised by ${v.name}\n\n` +
    `Issue Number: ${v.reference}\n` +
    (link ? `Raised from: ${link}\n` : '') +
    `\n${v.details}\n\n` +
    `Contact details\n` +
    `Name:  ${v.name}\n` +
    `Phone: ${phone}\n` +
    `Email: ${email}\n\n` +
    `Consent to share contact: Yes\n` +
    `Submitted at: ${submitted}\n\n` +
    `Regards,\nTeam ${v.teamName}`;

  return { subject, html, text };
}
