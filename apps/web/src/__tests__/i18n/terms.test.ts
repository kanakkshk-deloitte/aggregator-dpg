import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { applyTerms, fillTerms } from '@/i18n/terms';

// Read the files from disk: a plain import would already have the terms filled.
const rawMessages = (locale: string): unknown =>
  JSON.parse(readFileSync(path.join(__dirname, '../../i18n/messages', `${locale}.json`), 'utf8'));

const collectStrings = (value: unknown, out: string[] = []): string[] => {
  if (typeof value === 'string') out.push(value);
  else if (value !== null && typeof value === 'object') {
    Object.values(value).forEach((v) => collectStrings(v, out));
  }
  return out;
};

describe('fillTerms', () => {
  it('fills English placeholders with the English words', () => {
    expect(fillTerms('Invite [[users]] to your [[org]]', 'en')).toBe(
      'Invite users to your organisation',
    );
  });

  it("fills a translated string with its locale's words", () => {
    expect(fillTerms('[[user]] पंजीकरण', 'hi')).toBe('उपयोगकर्ता पंजीकरण');
    expect(fillTerms('[[user]]ರು', 'kn')).toBe('ಬಳಕೆದಾರರು');
  });

  it('fills an untranslated English string in the hi file with the English words', () => {
    expect(fillTerms('Loading [[orgs]]…', 'hi')).toBe('Loading organisations…');
  });

  it("fills a placeholder-only string with the locale's words", () => {
    expect(fillTerms('[[org]]', 'hi')).toBe('संगठन');
  });

  it('falls back to English for a term the locale does not define', () => {
    expect(fillTerms('[[Users]] सूची', 'hi')).toBe('Users सूची');
  });

  it('leaves unknown placeholders and plain text unchanged', () => {
    expect(fillTerms('[[nope]]', 'en')).toBe('[[nope]]');
    expect(fillTerms('', 'en')).toBe('');
    expect(fillTerms('No terms here', 'xx')).toBe('No terms here');
  });
});

describe('applyTerms', () => {
  it('fills nested strings and keeps other values', () => {
    expect(applyTerms({ a: { b: '[[Org]]' }, c: ['[[user]]'], d: 3, e: null }, 'en')).toEqual({
      a: { b: 'Organisation' },
      c: ['user'],
      d: 3,
      e: null,
    });
  });

  it.each(['en', 'hi', 'kn'])('resolves every placeholder in %s.json', (locale) => {
    const left = collectStrings(applyTerms(rawMessages(locale), locale)).filter((s) =>
      /\[\[\w+\]\]/.test(s),
    );
    expect(left).toEqual([]);
  });
});
