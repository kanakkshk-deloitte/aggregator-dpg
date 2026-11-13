import { describe, it, expect, afterEach } from 'vitest';
import { renderCase } from './render-case.js';
import { _setEmailMessages } from './messages.js';

afterEach(() => {
  _setEmailMessages(null);
});

describe('renderCase — the one conversion', () => {
  it('renders subject, HTML and text from the same copy keys', () => {
    const out = renderCase('owner_grant_refreshed', {
      orgName: 'Acme Org',
      inviteUrl: 'https://portal.test/login',
    });
    expect(out.subject).toBe('Manage Acme Org by signing in');
    expect(out.html).toContain('Acme Org');
    expect(out.text).toContain('Acme Org');
    // The text part is derived, so the HTML's <strong> must not leak into it.
    expect(out.text).not.toContain('<strong>');
  });

  it('emits a CTA as a button in HTML and as "Label: url" in text', () => {
    const out = renderCase('owner_grant_refreshed', {
      orgName: 'Acme Org',
      inviteUrl: 'https://portal.test/login',
    });
    expect(out.html).toContain('href="https://portal.test/login"');
    expect(out.text).toContain('Sign in: https://portal.test/login');
  });

  it('skips a `requires` block when its token is absent', () => {
    const withReason = renderCase('applicant_rejected', {
      association: 'Acme',
      reason: 'Incomplete documents',
    });
    const without = renderCase('applicant_rejected', { association: 'Acme' });
    expect(withReason.html).toContain('Incomplete documents');
    expect(without.html).not.toContain('Reason:');
    expect(without.text).not.toContain('Reason:');
  });

  it('picks the first `oneOf` alternative whose conditions hold', () => {
    const named = renderCase('applicant_rejected', {
      association: 'Acme',
      contactName: 'Ravi',
    });
    const anon = renderCase('applicant_rejected', { association: 'Acme' });
    expect(named.html).toContain('Hi Ravi,');
    expect(anon.html).toContain('Hi there,');
  });

  it('honours `absent` for the mutually exclusive tail', () => {
    const withLink = renderCase('org_owner_approved', {
      orgName: 'Acme',
      ownerEmail: 'o@acme.test',
      inviteUrl: 'https://portal.test/login',
    });
    const pending = renderCase('org_owner_approved', {
      orgName: 'Acme',
      ownerEmail: 'o@acme.test',
    });
    expect(withLink.html).toContain('Sign in to manage your organisation');
    expect(withLink.html).not.toContain('follow-up message');
    expect(pending.html).toContain('follow-up message');
    expect(pending.html).not.toContain('Sign in to manage your organisation');
  });

  it('substitutes a derived token mid-sentence, already escaped', () => {
    const out = renderCase('coordinator_invite', {
      orgName: 'Acme',
      inviterEmail: 'owner@acme.test',
      inviteUrl: 'https://portal.test/r?invite=t',
      expiresOn: '15 Sep 2026',
      recipientName: "O'Brien",
    });
    // Escaped once, not twice: the greeting is an `html` token built from copy.
    expect(out.html).toContain('Hi O&#39;Brien,');
    expect(out.html).not.toContain('&amp;#39;');
  });

  it('escapes token values on substitution', () => {
    const out = renderCase('owner_grant_refreshed', {
      orgName: '<script>alert(1)</script>',
      inviteUrl: 'https://portal.test/i',
    });
    expect(out.html).not.toContain('<script>alert(1)</script>');
    expect(out.html).toContain('&lt;script&gt;');
  });

  it('omits the sign-off where the case opts out', () => {
    const rejected = renderCase('applicant_rejected', { association: 'Acme' });
    const approved = renderCase('applicant_approved', {
      contactName: 'Ravi',
      association: 'Acme',
      identifier: 'ravi@acme.test',
      signInUrl: 'https://portal.test/login',
    });
    expect(rejected.text).not.toContain('Sent by');
    expect(approved.text).toContain('Sent by');
  });

  it('throws on an unregistered case rather than sending an empty email', () => {
    expect(() => renderCase('nope', {})).toThrow(/unknown email case/);
  });

  it('drops a CTA whose href token was not supplied', () => {
    // Guards against a button rendering with an empty href.
    const out = renderCase('org_already_registered', {
      orgName: 'Acme',
    });
    expect(out.html).not.toContain('<a href=""');
  });

  it('escapes the CTA href — it never passes through substitute()', () => {
    // The registry declares inviteUrl as `text`, but the CTA path bypasses
    // substitution entirely, so the escaping has to happen in the button
    // helper. An `&` in a query string must arrive as `&amp;`.
    const out = renderCase('owner_grant_refreshed', {
      orgName: 'Acme',
      inviteUrl: 'https://portal.test/i?grant=a&next=b',
    });
    expect(out.html).toContain('href="https://portal.test/i?grant=a&amp;next=b"');
    expect(out.html).not.toContain('grant=a&next=b"');
  });

  it('refuses a non-http(s) CTA href rather than emitting it', () => {
    // Attribute breakout plus `javascript:` in an email is a phishing vector.
    expect(() =>
      renderCase('owner_grant_refreshed', {
        orgName: 'Acme',
        inviteUrl: 'javascript:alert(1)',
      }),
    ).toThrow(/unsafe CTA href scheme/);
  });

  it('refuses an unparseable CTA href', () => {
    expect(() =>
      renderCase('owner_grant_refreshed', {
        orgName: 'Acme',
        inviteUrl: '" onmouseover="alert(1)',
      }),
    ).toThrow(/unsafe CTA href/);
  });
});
