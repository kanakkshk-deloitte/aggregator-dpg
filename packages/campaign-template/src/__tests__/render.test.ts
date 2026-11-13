import { describe, it, expect } from 'vitest';
import { renderEmail } from '../render.js';

describe('renderEmail', () => {
  it('renders markdown to sanitised HTML, a text part, and a substituted subject', () => {
    const out = renderEmail({
      subject: 'Hi {{first_name}}',
      bodyMarkdown: 'Hello {{name}},\n\nWe have an **update**.\n\n- one\n- two',
      values: { first_name: 'Ananya', name: 'Ananya Krishnan' },
    });
    expect(out.subject).toBe('Hi Ananya');
    expect(out.html).toContain('<strong>update</strong>');
    expect(out.html).toContain('<li>one</li>');
    expect(out.html).toContain('Hello Ananya Krishnan,');
    // text part keeps the markdown source with placeholders substituted
    expect(out.text).toContain('Hello Ananya Krishnan,');
    expect(out.text).toContain('**update**');
  });

  it('HTML-escapes substituted values so they cannot inject markup', () => {
    const out = renderEmail({
      subject: 's',
      bodyMarkdown: 'Hi {{name}}',
      values: { name: '<img src=x onerror=alert(1)>' },
    });
    expect(out.html).not.toContain('<img');
    expect(out.html).toContain('&lt;img');
  });

  it('strips disallowed tags/scripts from the rendered markdown', () => {
    const out = renderEmail({
      subject: 's',
      bodyMarkdown: 'Hello\n\n<script>alert(1)</script>\n\n<b>bold</b>',
      values: {},
    });
    expect(out.html).not.toContain('<script>');
    // sanitizer keeps benign inline formatting
    expect(out.html).toContain('bold');
  });

  it('sends the same content to everyone when there are no placeholders', () => {
    const out = renderEmail({
      subject: 'Hello',
      bodyMarkdown: 'No placeholders here.',
      values: {},
    });
    expect(out.subject).toBe('Hello');
    expect(out.html).toContain('No placeholders here.');
  });
});
