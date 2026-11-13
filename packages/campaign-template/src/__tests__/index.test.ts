import { describe, it, expect } from 'vitest';
import {
  SUPPORTED_PLACEHOLDERS,
  extractPlaceholders,
  unknownPlaceholders,
  requiredContactFields,
  placeholderValues,
  substitute,
  escapeHtml,
} from '../index.js';

describe('extractPlaceholders', () => {
  it('finds distinct, lower-cased tokens across subject + body, tolerating whitespace', () => {
    const found = extractPlaceholders('Hi {{first_name}}', 'Dear {{ Name }}, call {{phone}}');
    expect(found.sort()).toEqual(['first_name', 'name', 'phone']);
  });
  it('returns [] when there are no placeholders', () => {
    expect(extractPlaceholders('plain subject', 'plain body')).toEqual([]);
  });
});

describe('unknownPlaceholders', () => {
  it('flags tokens outside the supported set', () => {
    expect(unknownPlaceholders('Hi {{name}} {{City}}')).toEqual(['city']);
  });
  it('is empty when every token is supported', () => {
    expect(
      unknownPlaceholders('{{name}} {{email}} {{phone}} {{first_name}} {{last_name}}'),
    ).toEqual([]);
  });
});

describe('requiredContactFields', () => {
  it('maps name/first_name/last_name to name, and email/phone to themselves', () => {
    expect(requiredContactFields('Hi {{first_name}}', 'ref {{phone}}').sort()).toEqual([
      'name',
      'phone',
    ]);
  });
  it('is empty when no placeholders are used', () => {
    expect(requiredContactFields('plain', 'plain')).toEqual([]);
  });
  it('dedupes name when several name-derived tokens are used', () => {
    expect(requiredContactFields('{{name}} {{first_name}} {{last_name}}')).toEqual(['name']);
  });
});

describe('placeholderValues', () => {
  it('splits the name into first/last and passes email/phone through', () => {
    expect(placeholderValues({ name: 'Ananya Krishnan', email: 'a@x.com', phone: '+91' })).toEqual({
      name: 'Ananya Krishnan',
      first_name: 'Ananya',
      last_name: 'Krishnan',
      email: 'a@x.com',
      phone: '+91',
    });
  });
  it('handles a single-word name and null contact fields', () => {
    expect(placeholderValues({ name: 'Asha', email: null, phone: null })).toEqual({
      name: 'Asha',
      first_name: 'Asha',
      last_name: '',
      email: '',
      phone: '',
    });
  });
});

describe('substitute', () => {
  it('replaces supported tokens; missing value → empty string; unknown left verbatim', () => {
    const out = substitute('Hi {{first_name}} {{unknown}} {{last_name}}', {
      first_name: 'Asha',
      last_name: null,
    });
    expect(out).toBe('Hi Asha {{unknown}} ');
  });
  it('applies the escape function when provided', () => {
    const out = substitute('<p>{{name}}</p>', { name: '<b>x</b>' }, escapeHtml);
    expect(out).toBe('<p>&lt;b&gt;x&lt;/b&gt;</p>');
  });
});

describe('escapeHtml', () => {
  it('escapes all five metacharacters', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });
});

describe('SUPPORTED_PLACEHOLDERS', () => {
  it('is the fixed v1 identity set', () => {
    expect([...SUPPORTED_PLACEHOLDERS]).toEqual([
      'name',
      'first_name',
      'last_name',
      'email',
      'phone',
    ]);
  });
});
