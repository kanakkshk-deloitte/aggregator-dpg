import { describe, it, expect } from 'vitest';
import { renderSupportRequest, generateSupportReference } from '../support-request.js';

const base = {
  type: 'complaint' as const,
  name: 'Asha K',
  email: 'asha@example.com' as string | null,
  phone: '+919000000000' as string | null,
  details: 'It broke',
  reference: 'SUP-20260713-A1B2C3',
  link: 'https://portal.example.org',
  teamName: 'Blue Dot',
  submittedAt: new Date('2026-07-13T10:00:00.000Z'),
};

describe('renderSupportRequest', () => {
  it('builds the "Issue Number … from … from <link>" subject', () => {
    expect(renderSupportRequest(base).subject).toBe(
      'Issue Number: SUP-20260713-A1B2C3 — Complaint from Asha K from https://portal.example.org',
    );
  });

  it('labels support_request submissions and omits the trailing link gracefully', () => {
    const { link: _drop, ...noLink } = base;
    expect(renderSupportRequest({ ...noLink, type: 'support_request' }).subject).toBe(
      'Issue Number: SUP-20260713-A1B2C3 — Support Request from Asha K',
    );
  });

  it('includes the reference, details, contact details and team sign-off in html and text', () => {
    const { html, text } = renderSupportRequest(base);
    for (const needle of [
      'SUP-20260713-A1B2C3',
      'It broke',
      'Asha K',
      'asha@example.com',
      '+919000000000',
      'Team Blue Dot',
      'Consent to share contact',
    ]) {
      expect(html).toContain(needle);
      expect(text).toContain(needle);
    }
  });

  it('HTML-escapes user-supplied details and name; flattens subject newlines', () => {
    const r = renderSupportRequest({
      ...base,
      name: 'A<b>C',
      details: '<script>x</script>\nmore',
    });
    expect(r.subject).toContain('A<b>C');
    expect(r.html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(r.html).not.toContain('<script>');
    expect(r.html).toContain('A&lt;b&gt;C');
  });

  it('renders a dash for missing email/phone', () => {
    const { html, text } = renderSupportRequest({ ...base, email: null, phone: null });
    expect(html).toContain('—');
    expect(text).toContain('Phone: —');
    expect(text).toContain('Email: —');
  });
});

describe('generateSupportReference', () => {
  it('formats SUP-YYYYMMDD-XXXXXX using the UTC date', () => {
    const ref = generateSupportReference(new Date('2026-07-13T23:30:00.000Z'));
    expect(ref).toMatch(/^SUP-20260713-[A-Z0-9]{6}$/);
  });

  it('produces distinct suffixes across calls', () => {
    const a = generateSupportReference();
    const b = generateSupportReference();
    // 36^6 space — collision is astronomically unlikely.
    expect(a).not.toBe(b);
  });
});
