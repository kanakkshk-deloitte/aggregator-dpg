/**
 * Shared HTML scaffolding for outbound emails.
 *
 * Email clients strip <style> tags and external CSS — every rule lives
 * inline. Layout is single-column, max 560px, system font stack.
 */

const BRAND_INK = '#0b1020';
const BRAND_INK_500 = '#475069';
const BRAND_BORDER = '#e8eaf1';
const BRAND_BG = '#f7f8fb';

/**
 * Brand values for outbound emails. Set from
 * `getNetworkConfig().aggregator.brand` at server boot via `setEmailBrand`.
 */
export interface EmailBrand {
  short_name: string;
  long_name: string;
  primary_color: string;
}

const DEFAULT_BRAND: EmailBrand = {
  short_name: 'Aggregator',
  long_name: 'Aggregator Portal',
  primary_color: '#4f46e5',
};

let runtimeBrand: EmailBrand | null = null;

/** Called once from the server boot path after network config resolves. */
export function setEmailBrand(brand: EmailBrand): void {
  runtimeBrand = brand;
}

/** Returns the active brand (or the generic default while unconfigured). */
export function getEmailBrand(): EmailBrand {
  return runtimeBrand ?? DEFAULT_BRAND;
}

export interface ShellOptions {
  preheader?: string;
  bodyHtml: string;
}

/**
 * Wraps a body fragment in the shared email shell (header bar + footer).
 *
 * @param opts - Preheader + the inner body HTML.
 * @returns Full HTML document ready to send.
 */
export function renderShell(opts: ShellOptions): string {
  const preheader = opts.preheader ?? '';
  const brand = getEmailBrand();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(brand.short_name)}</title>
</head>
<body style="margin:0;padding:0;background:${BRAND_BG};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${BRAND_INK};">
<span style="display:none;visibility:hidden;opacity:0;color:transparent;height:0;width:0;">${escapeHtml(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND_BG};padding:32px 16px;">
  <tr>
    <td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border:1px solid ${BRAND_BORDER};border-radius:14px;overflow:hidden;">
        <tr>
          <td style="padding:24px 28px;border-bottom:1px solid ${BRAND_BORDER};">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="vertical-align:middle;">
                  <div style="font-weight:700;font-size:18px;letter-spacing:-0.01em;color:${BRAND_INK};">${escapeHtml(brand.short_name)}</div>
                  <div style="font-size:12px;color:${BRAND_INK_500};margin-top:2px;">${escapeHtml(brand.long_name)}</div>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:28px;">
            ${opts.bodyHtml}
          </td>
        </tr>
        <tr>
          <td style="padding:18px 28px;border-top:1px solid ${BRAND_BORDER};font-size:12px;color:${BRAND_INK_500};">
            Sent by ${escapeHtml(brand.long_name)}. If you received this in error, ignore it.
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

/** Schemes a CTA may link to. Anything else is a phishing vector in email. */
const SAFE_HREF_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:']);

/**
 * Validates and escapes a CTA destination for use in an `href` attribute.
 *
 * The button helpers are the only place a URL reaches HTML without passing
 * through `substitute`, so the check lives here. It blocks attribute breakout
 * and `javascript:` links.
 *
 * @param href - Destination URL.
 * @returns The URL, escaped for attribute context.
 * @throws {Error} If the URL is unparseable or its scheme is not http(s).
 */
function safeHref(href: string): string {
  let scheme: string;
  try {
    scheme = new URL(href).protocol;
  } catch {
    throw new Error(`unsafe CTA href (unparseable): ${href.slice(0, 60)}`);
  }
  if (!SAFE_HREF_SCHEMES.has(scheme)) {
    throw new Error(`unsafe CTA href scheme: ${scheme}`);
  }
  // `&` becomes `&amp;` — correct for an attribute value; clients decode it.
  return escapeHtml(href);
}

/**
 * Renders an inline CTA button.
 *
 * @param label - Button text.
 * @param href - Target URL; must be http(s).
 * @param color - `primary` uses the brand colour, `danger` red.
 * @returns HTML for the button.
 */
export function ctaButton(
  label: string,
  href: string,
  color: 'primary' | 'danger' = 'primary',
): string {
  const bg = color === 'danger' ? '#dc2626' : getEmailBrand().primary_color;
  return `<a href="${safeHref(href)}" style="display:inline-block;background:${bg};color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;font-size:14px;">${escapeHtml(label)}</a>`;
}

/**
 * Status pill shown above an email heading (e.g. "Action required"). Uses a
 * table cell because Outlook drops padding on inline elements.
 *
 * @param label - Short pill text; upper-cased for emphasis by the caller's CSS.
 * @param tone - `info` for neutral notices, `action` for anything needing a reply.
 * @returns HTML for the pill.
 */
export function pill(label: string, tone: 'info' | 'action' = 'info'): string {
  const bg = tone === 'action' ? '#dbeafe' : '#f1f5f9';
  const fg = tone === 'action' ? '#1d4ed8' : '#475069';
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 14px;">` +
    `<tr><td style="background:${bg};color:${fg};border-radius:999px;padding:6px 14px;` +
    `font-size:11.5px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;">` +
    `${escapeHtml(label)}</td></tr></table>`
  );
}

/**
 * Full-width CTA button, for the main action of an email.
 *
 * @param label - Button text.
 * @param href - Target URL; already signed/encoded by the caller.
 * @param color - `primary` uses the brand colour, `danger` red.
 * @returns HTML for a full-width button row.
 */
export function ctaButtonFull(
  label: string,
  href: string,
  color: 'primary' | 'danger' = 'primary',
): string {
  const bg = color === 'danger' ? '#dc2626' : getEmailBrand().primary_color;
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">` +
    `<tr><td align="center" style="background:${bg};border-radius:12px;">` +
    `<a href="${safeHref(href)}" style="display:block;padding:15px 22px;color:#ffffff;` +
    `text-decoration:none;font-weight:700;font-size:15px;">${escapeHtml(label)} &rarr;</a>` +
    `</td></tr></table>`
  );
}

export function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// ── Block helpers ───────────────────────────────────────────────────────────
// These helpers own all body-block styling, so the copy files carry no inline CSS.

/** Standard body paragraph. `html` must already be escaped or code-generated. */
export function para(html: string): string {
  return `<p style="margin:0 0 14px;font-size:14px;color:${BRAND_INK_500};line-height:1.55;">\n  ${html}\n</p>`;
}

/** Body paragraph with the wider bottom margin used before a footnote. */
export function paraLast(html: string): string {
  return `<p style="margin:0 0 22px;font-size:14px;color:${BRAND_INK_500};line-height:1.55;">\n  ${html}\n</p>`;
}

/** Top-of-body heading. */
export function heading(html: string): string {
  return `<h1 style="font-size:22px;font-weight:700;letter-spacing:-0.01em;margin:0 0 12px;color:${BRAND_INK};">\n  ${html}\n</h1>`;
}

/** Small grey closing note. */
export function note(html: string): string {
  return `<p style="margin:0;font-size:12px;color:#7c84a6;line-height:1.55;">\n  ${html}\n</p>`;
}

/** Warning callout — used for a rejection reason. */
export function callout(html: string): string {
  return (
    `<div style="margin:18px 0 0;padding:14px;background:#fef2f2;border:1px solid #fecaca;` +
    `border-radius:10px;font-size:13.5px;color:#7f1d1d;line-height:1.55;">${html}</div>`
  );
}

/** Wraps a CTA button in its own row. */
export function ctaRow(buttonHtml: string): string {
  return `<div style="margin:0 0 18px;">\n  ${buttonHtml}\n</div>`;
}

/** Smaller closing paragraph — used for the rejection appeal line. */
export function paraSmall(html: string): string {
  return `<p style="margin:18px 0 0;font-size:13.5px;color:${BRAND_INK_500};line-height:1.55;">\n  ${html}\n</p>`;
}
