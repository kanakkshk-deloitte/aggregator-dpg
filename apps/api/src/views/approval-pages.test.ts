import { describe, it, expect } from 'vitest';
import { renderResultPage, renderConfirmPage, setApprovalBrand } from './approval-pages.js';

describe('setApprovalBrand', () => {
  it('seeds the runtime brand used by render functions that omit an explicit override', () => {
    setApprovalBrand({
      short_name: 'Test Network',
      long_name: 'Test Network Portal',
      primary_color: '#123456',
      portal_url: 'https://test.invalid',
    });
    const html = renderConfirmPage({
      aggregatorId: 'agg-1',
      token: 'tok',
      applicantEmail: 'a@b.com',
      association: 'Acme',
      aggregatorType: 'seeker',
      postUrl: 'https://api.local/decision/agg-1',
      expiresInText: '1 hour',
    });
    expect(html).toContain('Test Network');
    // One link, both actions: the review page carries Approve + Reject.
    expect(html).toContain('name="decision" value="approve"');
    expect(html).toContain('name="decision" value="reject"');
    // Restore the default runtime brand so later tests in the suite (which
    // rely on DEFAULT_BRAND when no override is passed) are unaffected.
    setApprovalBrand({
      short_name: 'Aggregator',
      long_name: 'Aggregator Portal',
      primary_color: '#4f46e5',
      portal_url: 'http://localhost:3000',
    });
  });
});

describe('renderConfirmPage reject flow', () => {
  const base = {
    aggregatorId: 'agg-1',
    token: 'tok',
    applicantEmail: 'a@b.com',
    association: 'Acme',
    aggregatorType: 'seeker',
    postUrl: 'https://api.local/decision/agg-1',
    expiresInText: '1 hour',
  };

  it('offers exactly two decisions and keeps the reason inside the reject dialog', () => {
    const html = renderConfirmPage(base);
    // The page presents two outcomes, not a form to fill in before choosing.
    expect(html).toContain('id="reject-modal"');
    expect(html).toContain('<dialog');
    // The reason field must not sit in the main card next to Approve — it
    // belongs to the reject dialog, which is what makes the page read as a
    // choice rather than a form.
    const beforeDialog = html.slice(0, html.indexOf('<dialog'));
    expect(beforeDialog).not.toContain('name="reason"');
  });

  it('mirrors the server-side reason cap so the field cannot overflow validation', () => {
    // The route parses `reason` as z.string().max(2000).optional().
    expect(renderConfirmPage(base)).toContain('maxlength="2000"');
  });

  it('keeps reject reachable without JS, without showing two reject buttons', () => {
    const html = renderConfirmPage(base);
    // The scripted button starts hidden and is un-hidden only once the dialog
    // is known to work, so a failed script can never leave two reject paths.
    expect(html).toContain('id="reject-open" hidden');
    expect(html).toContain('<noscript>');
    const noscript = html.slice(html.indexOf('<noscript>'), html.indexOf('</noscript>'));
    expect(noscript).toContain('name="decision" value="reject"');
    expect(noscript).toContain('name="reason"');
  });
});

describe('renderResultPage action button', () => {
  it('omits the resend form when no action is given', () => {
    const html = renderResultPage({ status: 'error', title: 'Invalid link', message: 'x' });
    expect(html).not.toContain('name="token"');
  });

  it('renders a resend form POSTing the token when action is given', () => {
    const html = renderResultPage({
      status: 'error',
      title: 'Link expired',
      message: 'x',
      action: {
        url: 'https://api.local/admin/v1/aggregator-registrations/resend/agg-1',
        token: 'tok-123',
        label: 'Resend approval link',
      },
    });
    expect(html).toContain(
      'action="https://api.local/admin/v1/aggregator-registrations/resend/agg-1"',
    );
    expect(html).toContain('value="tok-123"');
    expect(html).toContain('Resend approval link');
  });
});
