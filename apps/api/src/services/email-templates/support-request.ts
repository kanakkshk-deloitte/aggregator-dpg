/**
 * Support / contact-form email — sent to SUPPORT_EMAIL when a coordinator
 * submits the in-app "Contact support" form. Carries the message plus the
 * submitter's identity so support can follow up (Reply-To is the submitter).
 *
 * Belongs to `@aggregator-dpg/api`.
 */

import { escapeHtml, renderShell } from './shared.js';

/** Inputs for {@link renderSupportRequest}. */
export interface SupportRequestVars {
  subject?: string;
  message: string;
  name: string;
  email: string | null;
  phone: string | null;
  userId: string;
  aggregatorId: string;
  submittedAt: Date;
}

/** Collapse whitespace/newlines to single spaces (safe for an email header). */
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Renders the support-request email.
 *
 * @param v - The submitted subject/message plus resolved submitter details.
 * @returns The email `subject`, `html`, and plain-text `text` fallback.
 */
export function renderSupportRequest(v: SupportRequestVars): {
  subject: string;
  html: string;
  text: string;
} {
  const subjectText = v.subject && v.subject.trim() ? oneLine(v.subject) : 'New support request';
  const subject = `[Support] ${subjectText} — ${oneLine(v.name)}`;

  const submitted = `${v.submittedAt.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })} IST`;

  const rows: Array<[string, string]> = [
    ['Name', v.name],
    ['Email', v.email ?? '—'],
    ['Phone', v.phone ?? '—'],
    ['User ID', v.userId],
    ['Aggregator ID', v.aggregatorId],
    ['Submitted at', submitted],
  ];
  const detailRows = rows
    .map(
      ([k, val]) =>
        `<tr><td style="padding:6px 0;color:#475069;width:140px;">${escapeHtml(k)}</td>` +
        `<td style="padding:6px 0;color:#0b1020;">${escapeHtml(val)}</td></tr>`,
    )
    .join('');

  const body = `
<h1 style="font-size:20px;font-weight:700;margin:0 0 8px;color:#0b1020;">New support request</h1>
<div style="margin:12px 0;padding:14px;background:#f7f8fb;border-radius:10px;font-size:14px;color:#0b1020;line-height:1.5;white-space:pre-wrap;">${escapeHtml(
    v.message,
  )}</div>
<table style="border-collapse:collapse;font-size:13px;">${detailRows}</table>`;

  const html = renderShell({ preheader: subject, bodyHtml: body });

  const text = `${subject}\n\n${v.message}\n\n` + rows.map(([k, val]) => `${k}: ${val}`).join('\n');

  return { subject, html, text };
}
