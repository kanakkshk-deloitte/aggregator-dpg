/**
 * Admin review email — sent to ADMIN_EMAILS when a new aggregator
 * registration arrives. Two CTA buttons (Approve / Reject) link to the
 * confirmation page rendered by the API.
 */

import { ctaButtonFull, escapeHtml, pill, renderShell } from './shared.js';

export interface AdminReviewVars {
  registrationId: string;
  applicantName: string;
  applicantEmail: string;
  applicantPhone: string;
  association: string;
  /**
   * What was registered — drives the subject, heading, and Type row. Use
   * `organisation` for the org flow, `aggregator` (default) for coordinators.
   */
  entityLabel?: string;
  state?: string | undefined;
  /** Name of the parent organisation, for an organisation registration. */
  parent?: string | undefined;
  about?: string | undefined;
  /**
   * The email the coordinator was invited at. When it differs from
   * `applicantEmail`, the review highlights the difference.
   */
  invitedEmail?: string | undefined;
  /** Review link with the signed token; approve or reject is chosen on the page it opens. */
  reviewUrl: string;
  submittedAt: Date;
  /**
   * Human-readable link lifetime (e.g. "7 days"), from `formatApprovalTtl`.
   * Must match the wording on the confirmation page.
   */
  expiresInText: string;
}

/**
 * Renders the admin review email.
 *
 * @param v - Registration details and the review link.
 * @returns The `subject`, `html`, and `text` parts ready for the mailer.
 */
export function renderAdminReview(v: AdminReviewVars): {
  subject: string;
  html: string;
  text: string;
} {
  const label = v.entityLabel ?? 'aggregator';
  const subject = `Action required: ${label} registration from ${v.association}`;
  // Show the submission time in IST, matching the approval pages.
  const submitted = `${v.submittedAt.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })} IST`;
  // True when the coordinator registered with a different email than the invited one.
  const emailMismatch = Boolean(v.invitedEmail && v.invitedEmail !== v.applicantEmail);

  // Rows as data, so the last row can skip its divider and optional rows drop out.
  const rows: Array<{ label: string; value: string; style?: string }> = [
    { label: 'Association', value: escapeHtml(v.association) },
    { label: 'Type', value: escapeHtml(label), style: 'text-transform:capitalize;' },
    ...(v.parent ? [{ label: 'Parent', value: escapeHtml(v.parent) }] : []),
    { label: 'Contact', value: escapeHtml(v.applicantName) },
    { label: 'Email', value: escapeHtml(v.applicantEmail) },
    ...(emailMismatch
      ? [
          {
            label: 'Invited email',
            value:
              `${escapeHtml(v.invitedEmail as string)} ` +
              `<span style="color:#7c84a6;">— they're registering with a different email (above)</span>`,
            style: 'color:#b45309;',
          },
        ]
      : []),
    { label: 'Phone', value: escapeHtml(v.applicantPhone) },
    ...(v.state ? [{ label: 'State', value: escapeHtml(v.state) }] : []),
    { label: 'Submitted', value: escapeHtml(submitted) },
    {
      label: 'Reference',
      value: escapeHtml(v.registrationId),
      style: 'font-family:monospace;font-size:12px;',
    },
  ];

  const rowsHtml = rows
    .map((r, i) => {
      const divider = i === rows.length - 1 ? '' : 'border-bottom:1px solid #eaecf2;';
      return (
        `<tr>` +
        `<td style="padding:12px 16px;color:#475069;width:132px;vertical-align:top;${divider}">${escapeHtml(r.label)}</td>` +
        `<td style="padding:12px 16px;color:#0b1020;${r.style ?? ''}${divider}">${r.value}</td>` +
        `</tr>`
      );
    })
    .join('');

  const aboutBlock = v.about
    ? `<div style="margin-top:16px;padding:14px;background:#f7f8fb;border-radius:10px;font-size:13px;color:#0b1020;line-height:1.5;">${escapeHtml(v.about)}</div>`
    : '';

  const body = `
${pill('Action required', 'action')}
<h1 style="font-size:22px;font-weight:700;letter-spacing:-0.015em;margin:0 0 10px;color:#0b1020;text-transform:capitalize;">New ${escapeHtml(label)} registration</h1>
<p style="margin:0 0 20px;font-size:14.5px;color:#475069;line-height:1.55;">
  <strong style="color:#0b1020;">${escapeHtml(v.association)}</strong> has submitted an ${escapeHtml(label)} registration. Review and approve or reject below.
</p>

<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
  style="font-size:13.5px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;border-collapse:separate;overflow:hidden;">
  ${rowsHtml}
</table>
${aboutBlock}

<div style="margin-top:26px;">
  ${ctaButtonFull('Review registration', v.reviewUrl, 'primary')}
</div>

<p style="margin:20px 0 0;font-size:12px;color:#7c84a6;line-height:1.5;">
  The link opens a review page where you can approve or reject. The decision is
  final once submitted. The link is single-use and expires in ${escapeHtml(v.expiresInText)}.
</p>
`;

  const text = `New ${label} registration

Association: ${v.association}
Type:        ${label}
${v.parent ? `Parent:      ${v.parent}\n` : ''}Contact:     ${v.applicantName}
Email:       ${v.applicantEmail}
${emailMismatch ? `Invited email: ${v.invitedEmail} (registering with a different email)\n` : ''}Phone:       ${v.applicantPhone}
${v.state ? `State:       ${v.state}\n` : ''}Submitted:   ${submitted}
Reference:   ${v.registrationId}
${v.about ? `\nAbout:\n${v.about}\n` : ''}
Review (approve or reject): ${v.reviewUrl}

The link opens a review page where you approve or reject. Single-use, expires in ${v.expiresInText}.
`;

  return { subject, html: renderShell({ preheader: subject, bodyHtml: body }), text };
}
