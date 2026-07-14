import { describe, it, expect } from 'vitest';
import { renderSupportRequest } from '../support-request.js';

const base = {
  message: 'It broke',
  name: 'Asha K',
  email: 'asha@example.com',
  phone: '+919000000000',
  userId: 'user-123',
  aggregatorId: 'agg-9',
  submittedAt: new Date('2026-07-09T10:00:00.000Z'),
};

describe('renderSupportRequest', () => {
  it('uses the provided subject in the subject line', () => {
    expect(renderSupportRequest({ ...base, subject: 'Cannot log in' }).subject).toBe(
      '[Support] Cannot log in — Asha K',
    );
  });

  it('falls back to a default subject when none is given', () => {
    expect(renderSupportRequest(base).subject).toBe('[Support] New support request — Asha K');
  });

  it('includes the message and every detail in html and text', () => {
    const { html, text } = renderSupportRequest(base);
    for (const needle of [
      'It broke',
      'Asha K',
      'asha@example.com',
      '+919000000000',
      'user-123',
      'agg-9',
    ]) {
      expect(html).toContain(needle);
      expect(text).toContain(needle);
    }
  });

  it('HTML-escapes user-supplied message and name; flattens subject newlines', () => {
    const r = renderSupportRequest({
      ...base,
      subject: 'a\nb',
      message: '<script>x</script>',
      name: 'A<b>C',
    });
    expect(r.subject).toBe('[Support] a b — A<b>C');
    expect(r.html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(r.html).not.toContain('<script>');
    expect(r.html).toContain('A&lt;b&gt;C');
  });

  it('renders a dash for missing email/phone', () => {
    const { html } = renderSupportRequest({ ...base, email: null, phone: null });
    expect(html).toContain('—');
  });
});
