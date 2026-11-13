/**
 * Server-rendered HTML pages for the admin approval flow in `@aggregator-dpg/api`.
 *
 * Plain inlined HTML with no template engine or client framework. Styles follow
 * the portal palette.
 */

/**
 * Brand values for the approval pages, from `getNetworkConfig().aggregator.brand`.
 */
export interface PageBrand {
  short_name: string;
  long_name: string;
  primary_color: string;
  portal_url: string;
}

const DEFAULT_BRAND: PageBrand = {
  short_name: 'Aggregator',
  long_name: 'Aggregator Portal',
  primary_color: '#4f46e5',
  portal_url: 'http://localhost:3000',
};

/** Brand set at boot from network config; used when a caller passes no `brand`. */
let runtimeBrand: PageBrand | null = null;

/** Called once from the server boot path after network config resolves. */
export function setApprovalBrand(brand: PageBrand): void {
  runtimeBrand = brand;
}

function pickBrand(override: PageBrand | undefined): PageBrand {
  return override ?? runtimeBrand ?? DEFAULT_BRAND;
}

function shade(hex: string, percent: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m || !m[1]) return hex;
  const num = Number.parseInt(m[1], 16);
  const r = (num >> 16) & 0xff;
  const g = (num >> 8) & 0xff;
  const b = num & 0xff;
  const mix = (c: number): number =>
    percent < 0
      ? Math.max(0, Math.round(c * (1 + percent)))
      : Math.min(255, Math.round(c + (255 - c) * percent));
  const out = ((mix(r) << 16) | (mix(g) << 8) | mix(b)).toString(16).padStart(6, '0');
  return `#${out}`;
}

function brandInitial(name: string): string {
  return (name.trim()[0] ?? 'A').toUpperCase();
}
const INK_900 = '#0b1020';
const INK_500 = '#475069';
const INK_300 = '#a3a8bd';
const BORDER = '#e5e7eb';
const SURFACE = '#fbfcfe';
const SURFACE_SOFT = '#f7f8fb';
const DANGER = '#b91c1c';
const DANGER_BG = '#fef2f2';
const DANGER_BORDER = '#fecaca';
const SUCCESS = '#15803d';
const SUCCESS_BG = '#dcfce7';
const INFO = '#1e40af';
const INFO_BG = '#dbeafe';

/** Inline decision icons, so the page is one self-contained response. */
const ICON_CHECK =
  '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<polyline points="20 6 9 17 4 12"></polyline></svg>';

const ICON_X =
  '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';

interface ShellOptions {
  title: string;
  brand: PageBrand;
}

function hexToRgba(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m || !m[1]) return `rgba(79, 70, 229, ${alpha})`;
  const num = Number.parseInt(m[1], 16);
  return `rgba(${(num >> 16) & 0xff}, ${(num >> 8) & 0xff}, ${num & 0xff}, ${alpha})`;
}

function shell(opts: ShellOptions, body: string): string {
  const brand = opts.brand;
  const primary = brand.primary_color;
  const primaryDark = shade(primary, -0.12);
  const primary50 = shade(primary, 0.92);
  const primary100 = shade(primary, 0.84);
  const primaryShadow = hexToRgba(primary, 0.28);
  const primaryFocus = hexToRgba(primary, 0.06);
  const initial = brandInitial(brand.short_name);
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escape(opts.title)} · ${escape(brand.short_name)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
<style>
  :root { color-scheme: light; }
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 14px;
    line-height: 1.55;
    background: ${SURFACE};
    color: ${INK_900};
    min-height: 100vh;
    background-image:
      radial-gradient(ellipse 60% 40% at 50% 0%, ${primary50} 0%, transparent 70%),
      radial-gradient(${primaryFocus} 1px, transparent 1px);
    background-size: 100% 100%, 22px 22px;
  }
  .wrap { max-width: 600px; margin: 0 auto; padding: 48px 20px 64px; }
  .brand {
    display: flex; align-items: center; gap: 12px;
    margin-bottom: 32px;
  }
  .brand-mark {
    width: 44px; height: 44px; border-radius: 12px;
    background: ${primary};
    display: flex; align-items: center; justify-content: center;
    color: #fff; font-weight: 700; font-size: 17px;
    letter-spacing: -0.02em;
    box-shadow: 0 8px 22px ${primaryShadow};
  }
  .brand-text { line-height: 1.2; }
  .brand-name {
    font-weight: 700; font-size: 16px; letter-spacing: -0.01em;
    color: ${INK_900};
  }
  .brand-tag { font-size: 12px; color: ${INK_500}; margin-top: 2px; }
  .card {
    background: #fff;
    border-radius: 18px;
    box-shadow: 0 6px 28px rgba(11, 16, 32, 0.06), 0 1px 0 rgba(11, 16, 32, 0.02);
    overflow: hidden;
    border: 1px solid ${BORDER};
  }
  .card-header {
    padding: 28px 32px 12px;
  }
  .card-body { padding: 4px 32px 28px; }
  .card-footer {
    padding: 22px 32px;
    background: ${SURFACE_SOFT};
    border-top: 1px solid ${BORDER};
    display: flex; align-items: center; gap: 12px; justify-content: flex-end;
    flex-wrap: wrap;
  }
  h1 {
    margin: 0 0 10px;
    font-size: 24px; font-weight: 700;
    letter-spacing: -0.02em;
    color: ${INK_900};
  }
  .lead { margin: 0; color: ${INK_500}; font-size: 14.5px; }
  .meta {
    margin: 22px 0 4px;
    background: ${SURFACE_SOFT};
    border: 1px solid ${BORDER};
    border-radius: 14px;
    padding: 18px 22px;
  }
  .meta-row { display: grid; grid-template-columns: 110px 1fr; gap: 14px; padding: 7px 0; }
  .meta-row + .meta-row { border-top: 1px dashed ${BORDER}; }
  .meta-label { font-size: 12px; font-weight: 600; color: ${INK_500}; text-transform: uppercase; letter-spacing: 0.06em; padding-top: 1px; }
  .meta-value { font-size: 14px; color: ${INK_900}; word-break: break-word; }
  .mono { font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; color: ${INK_500}; }
  textarea {
    width: 100%; box-sizing: border-box;
    min-height: 100px; padding: 12px 14px;
    border: 1px solid ${BORDER}; border-radius: 12px;
    font: inherit; color: ${INK_900};
    resize: vertical;
    background: #fff;
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
  }
  textarea:focus { outline: none; border-color: ${primary}; box-shadow: 0 0 0 4px ${primary100}; }
  label { display: block; font-size: 12px; font-weight: 600; color: ${INK_500}; text-transform: uppercase; letter-spacing: 0.06em; margin: 18px 0 8px; }
  button {
    font: inherit; cursor: pointer;
    padding: 11px 20px; border-radius: 11px; border: 0;
    font-weight: 600; font-size: 14px;
    transition: transform 0.04s ease, box-shadow 0.15s ease, background 0.15s ease;
  }
  button:active { transform: translateY(1px); }
  .btn-primary {
    background: ${primary}; color: #fff;
    box-shadow: 0 8px 18px ${primaryShadow};
  }
  .btn-primary:hover { background: ${primaryDark}; }
  .btn-danger {
    background: ${DANGER}; color: #fff;
    box-shadow: 0 8px 18px rgba(185, 28, 28, 0.22);
  }
  .btn-danger:hover { background: #991b1b; }
  .btn-secondary {
    background: #fff; color: ${INK_900}; border: 1px solid ${BORDER};
  }
  .btn-secondary:hover { background: ${SURFACE_SOFT}; }
  /* Decision row: the two outcomes sit side by side so the page offers exactly
     two choices. The reason field lives in the reject dialog, not inline —
     rendering a textarea next to Approve made the page read as a form to fill
     in before either action.

     A 2-column grid rather than flex, with display:contents on the wrapping
     form, so both buttons are direct grid items. Otherwise Approve sits inside
     its own form box and Reject doesn't, which is what made the two sit at
     different widths and heights. Equal columns also mirrors the review
     email's full-width CTA instead of two differently-sized pills. */
  .actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    align-items: stretch;
    margin-top: 22px;
  }
  .actions form { margin: 0; display: contents; }
  /* Icon + label centred as one unit, so the two buttons read as a matched
     pair however different the label widths are. */
  .actions button {
    width: 100%; padding: 14px 20px; border-radius: 12px;
    display: inline-flex; align-items: center; justify-content: center; gap: 9px;
    font-size: 15px;
  }
  .actions button svg { flex: none; }
  /* Reject is outlined rather than solid: destructive, but not the visual
     equal of the primary action on a page where approve is the common case. */
  .btn-danger-outline {
    background: #fff; color: ${DANGER};
    border: 1px solid ${DANGER_BORDER};
  }
  .btn-danger-outline:hover { background: ${DANGER_BG}; border-color: ${DANGER}; }
  @media (max-width: 420px) {
    .actions { grid-template-columns: 1fr; }
  }
  dialog.modal {
    border: 0; border-radius: 16px; padding: 26px;
    max-width: 460px; width: calc(100% - 40px);
    box-shadow: 0 24px 60px rgba(15, 23, 42, 0.22);
    color: ${INK_900};
  }
  dialog.modal::backdrop { background: rgba(15, 23, 42, 0.45); }
  dialog.modal h2 { margin: 0; font-size: 19px; font-weight: 700; letter-spacing: -0.01em; }
  dialog.modal .modal-lead { margin: 8px 0 0; font-size: 13.5px; color: ${INK_500}; }
  dialog.modal label { margin-top: 16px; }
  dialog.modal textarea { margin: 0; }
  .modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 18px; }
  .pill {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 4px 10px; border-radius: 999px;
    font-size: 12px; font-weight: 600;
    letter-spacing: 0.01em;
  }
  .pill-success { background: ${SUCCESS_BG}; color: ${SUCCESS}; }
  .pill-error { background: ${DANGER_BG}; color: ${DANGER}; border: 1px solid ${DANGER_BORDER}; }
  .pill-info { background: ${INFO_BG}; color: ${INFO}; }
  .accent-bar { height: 4px; }
  .accent-primary { background: linear-gradient(90deg, ${primary}, ${primaryDark}); }
  .accent-danger { background: linear-gradient(90deg, ${DANGER}, #7f1d1d); }
  .accent-success { background: linear-gradient(90deg, ${SUCCESS}, #166534); }
  .accent-info { background: linear-gradient(90deg, ${INFO}, #1e3a8a); }
  .footer-note { margin: 22px 4px 0; font-size: 12px; color: ${INK_300}; line-height: 1.55; }
  .icon-circle {
    width: 64px; height: 64px; border-radius: 999px;
    display: inline-flex; align-items: center; justify-content: center;
    margin: 0 0 18px;
  }
  .icon-circle svg { width: 30px; height: 30px; }
  .icon-success { background: ${SUCCESS_BG}; color: ${SUCCESS}; box-shadow: 0 0 0 8px rgba(21, 128, 61, 0.08); }
  .icon-error { background: ${DANGER_BG}; color: ${DANGER}; box-shadow: 0 0 0 8px rgba(185, 28, 28, 0.08); }
  .icon-info { background: ${INFO_BG}; color: ${INFO}; box-shadow: 0 0 0 8px rgba(30, 64, 175, 0.08); }
  .result-card { text-align: center; }
  .result-card h1 { font-size: 26px; margin-top: 4px; }
  .result-card .lead { max-width: 420px; margin: 8px auto 0; }
  .result-cta {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 11px 20px; border-radius: 11px;
    background: ${primary}; color: #fff;
    text-decoration: none; font-weight: 600; font-size: 14px;
    box-shadow: 0 8px 18px ${primaryShadow};
    transition: background 0.15s ease;
  }
  .result-cta:hover { background: ${primaryDark}; }
  .result-cta-row { margin: 24px 0 4px; display: flex; justify-content: center; gap: 12px; flex-wrap: wrap; }
  .result-secondary {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 11px 18px; border-radius: 11px;
    color: ${INK_500}; text-decoration: none; font-weight: 500; font-size: 14px;
    border: 1px solid ${BORDER}; background: #fff;
  }
  .result-secondary:hover { background: ${SURFACE_SOFT}; color: ${INK_900}; }
  .result-divider {
    display: block; margin: 22px auto 18px;
    width: 64px; height: 1px; background: ${BORDER};
  }
  .result-meta { font-size: 12px; color: ${INK_300}; margin-top: 4px; }
</style></head>
<body>
  <div class="wrap">
    <div class="brand">
      <div class="brand-mark">${escape(initial)}</div>
      <div class="brand-text">
        <div class="brand-name">${escape(brand.short_name)}</div>
        <div class="brand-tag">${escape(brand.long_name)} · Admin review</div>
      </div>
    </div>
    ${body}
  </div>
</body></html>`;
}

export interface ConfirmPageVars {
  aggregatorId: string;
  token: string;
  applicantEmail: string;
  association: string;
  aggregatorType: string;
  /** Noun for the heading/title, e.g. `organisation`. Defaults to `aggregator`. */
  entityLabel?: string;
  postUrl: string;
  /**
   * The email the coordinator was invited at.
   * When it differs from `applicantEmail`, the page flags it for the approver.
   */
  invitedEmail?: string | undefined;
  /**
   * Human-readable link lifetime (e.g. "7 days") from `formatApprovalTtl`.
   * Must match the wording in the admin review email.
   */
  expiresInText: string;
  brand?: PageBrand;
  /** A rejection must carry a reason; the reason field becomes required. */
  reasonRequired?: boolean;
  /** The longest reason the form takes; 2000 when absent. */
  reasonMaxLength?: number;
}

export function renderConfirmPage(v: ConfirmPageVars): string {
  const brand = pickBrand(v.brand);
  const reasonAttr = v.reasonRequired ? ' required' : '';
  const reasonMax = String(v.reasonMaxLength ?? 2000);
  const entity = v.entityLabel ?? 'aggregator';
  const invitedRow =
    v.invitedEmail && v.invitedEmail !== v.applicantEmail
      ? `<div class="meta-row">
            <div class="meta-label" style="color:#b45309;">Invited email</div>
            <div class="meta-value" style="color:#b45309;">${escape(v.invitedEmail)} — registering with a different email</div>
          </div>`
      : '';

  const body = `
    <div class="card">
      <div class="accent-bar accent-primary"></div>
      <div class="card-header">
        <span class="pill pill-info">Pending review</span>
        <h1 style="margin-top:14px;text-transform:capitalize;">Review ${escape(entity)} application</h1>
        <p class="lead">Approve to enable this account (the applicant gets a welcome email), or reject with a brief reason (sent to the applicant).</p>
      </div>
      <div class="card-body">
        <div class="meta">
          <div class="meta-row">
            <div class="meta-label">Email</div>
            <div class="meta-value">${escape(v.applicantEmail)}</div>
          </div>
          ${invitedRow}
          <div class="meta-row">
            <div class="meta-label">Name</div>
            <div class="meta-value">${escape(v.association)}</div>
          </div>
          <div class="meta-row">
            <div class="meta-label">Type</div>
            <div class="meta-value" style="text-transform:capitalize;">${escape(v.aggregatorType)}</div>
          </div>
          <div class="meta-row">
            <div class="meta-label">Reference</div>
            <div class="meta-value mono">${escape(v.aggregatorId)}</div>
          </div>
        </div>

        <!--
          Two outcomes, two buttons. Approve posts straight away; Reject opens a
          dialog that collects the reason, so the reason field is only present
          when it is relevant. Each decision keeps its own form and its own
          hidden token, so nothing is shared or mirrored between them.
        -->
        <div class="actions">
          <form method="POST" action="${escape(v.postUrl)}">
            <input type="hidden" name="token" value="${escape(v.token)}" />
            <input type="hidden" name="decision" value="approve" />
            <button type="submit" class="btn-primary">${ICON_CHECK}Approve</button>
          </form>
          <button type="button" class="btn-danger-outline" id="reject-open" hidden>${ICON_X}Reject</button>
        </div>

        <dialog class="modal" id="reject-modal" aria-labelledby="reject-title">
          <form method="POST" action="${escape(v.postUrl)}">
            <input type="hidden" name="token" value="${escape(v.token)}" />
            <input type="hidden" name="decision" value="reject" />
            <h2 id="reject-title">Reject this application?</h2>
            <p class="modal-lead">This is final once submitted. The reason below is emailed to the applicant.</p>
            <label for="reason-input">Reason (sent to the applicant)</label>
            <textarea id="reason-input" name="reason" maxlength="${reasonMax}"${reasonAttr}
              placeholder="A brief explanation helps the applicant understand the decision."></textarea>
            <div class="modal-actions">
              <button type="button" class="btn-secondary" id="reject-cancel">Cancel</button>
              <button type="submit" class="btn-danger">Reject application</button>
            </div>
          </form>
        </dialog>

        <!--
          Without JS the dialog can never be opened, so reject has to stay
          reachable inline. The scripted button starts hidden and the script
          un-hides it, which means exactly one reject affordance is ever
          visible — no duplicate buttons if the script fails to run.
        -->
        <noscript>
          <form method="POST" action="${escape(v.postUrl)}" style="margin:20px 0 0;">
            <input type="hidden" name="token" value="${escape(v.token)}" />
            <input type="hidden" name="decision" value="reject" />
            <label for="reason-input-nojs">Reason (sent to the applicant)</label>
            <textarea id="reason-input-nojs" name="reason" maxlength="${reasonMax}"${reasonAttr}
              placeholder="A brief explanation helps the applicant understand the decision."></textarea>
            <button type="submit" class="btn-danger" style="margin-top:10px;">Reject</button>
          </form>
        </noscript>
      </div>
    </div>
    <p class="footer-note">
      This decision is final once submitted. The review link is single-use and expires in ${escape(v.expiresInText)}.
    </p>
    <script>
      (function () {
        var dialog = document.getElementById('reject-modal');
        var open = document.getElementById('reject-open');
        var cancel = document.getElementById('reject-cancel');
        // Only take over if the browser actually supports <dialog>; otherwise
        // leave the button hidden and let the <noscript> path stand in.
        if (!dialog || !open || typeof dialog.showModal !== 'function') return;
        open.hidden = false;
        open.addEventListener('click', function () { dialog.showModal(); });
        if (cancel) cancel.addEventListener('click', function () { dialog.close(); });
      })();
    </script>
  `;
  return shell({ title: `Review ${entity}`, brand }, body);
}

export interface ResultPageVars {
  status: 'success' | 'error' | 'info';
  title: string;
  message: string;
  /**
   * Optional secondary action rendered as a POST form button, e.g. "resend approval link".
   * Posts a single hidden `token` field to `url`.
   */
  action?: { url: string; token: string; label: string };
  brand?: PageBrand;
}

export function renderResultPage(v: ResultPageVars): string {
  const brand = pickBrand(v.brand);
  const accent =
    v.status === 'success'
      ? 'accent-success'
      : v.status === 'error'
        ? 'accent-danger'
        : 'accent-info';
  const iconClass =
    v.status === 'success' ? 'icon-success' : v.status === 'error' ? 'icon-error' : 'icon-info';
  const iconSvg = resultIconSvg(v.status);
  const portalUrl = brand.portal_url;
  const decidedAt = new Date().toLocaleString('en-IN', {
    // Always render in IST; the server clock is UTC.
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  const body = `
    <div class="card result-card">
      <div class="accent-bar ${accent}"></div>
      <div class="card-header">
        <span class="icon-circle ${iconClass}">${iconSvg}</span>
        <h1>${escape(v.title)}</h1>
        <p class="lead">${escape(v.message)}</p>
        <span class="result-divider"></span>
        <div class="result-cta-row">
          <a class="result-cta" href="${escape(portalUrl)}">
            Open ${escape(brand.short_name)} Portal
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M13 5l7 7-7 7"/></svg>
          </a>
          ${
            v.action
              ? `<form method="POST" action="${escape(v.action.url)}" style="margin:0;display:inline;">
                   <input type="hidden" name="token" value="${escape(v.action.token)}" />
                   <button type="submit" class="btn-secondary">${escape(v.action.label)}</button>
                 </form>`
              : ''
          }
        </div>
        <div class="result-meta">${escape(decidedAt)}</div>
      </div>
    </div>
    <p class="footer-note" style="text-align:center;">You can safely close this tab.</p>
  `;
  return shell({ title: v.title, brand }, body);
}

function resultIconSvg(status: 'success' | 'error' | 'info'): string {
  if (status === 'success') {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>`;
  }
  if (status === 'error') {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="13"/><line x1="12" y1="16.5" x2="12" y2="16.51"/></svg>`;
  }
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="11" x2="12" y2="16"/><line x1="12" y1="7.5" x2="12" y2="7.51"/></svg>`;
}

function escape(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
