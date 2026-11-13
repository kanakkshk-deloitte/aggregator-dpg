/**
 * Unit tests for the shared URL rule.
 *
 * The accept/reject lists are copied from Signals' own
 * `packages/schemas/src/__tests__/uri_fields.test.ts`: the aggregator must
 * accept and reject exactly what Signals does, or a value that passes the
 * registration form is rejected on the push (aggregator-dpg#904).
 *
 * @module @aggregator-dpg/network-config
 */
import { describe, it, expect } from 'vitest';
import { URL_PATTERN, applyUrlRule } from '../uri-fields.js';

const re = new RegExp(URL_PATTERN, 'u');

describe('URL_PATTERN', () => {
  it.each([
    'example.com',
    'www.example.com',
    'www.example.org',
    'my-site.org',
    'https://example.com',
    'http://sub.domain.co.uk/a/b?q=1#f',
    'https://example.com:8443/x',
    'https://example.com?q=1',
    'https://www.example.com?utm_source=x',
    'https://example.com#top',
    'HTTPS://example.com',
    'Http://example.com',
    '  https://example.com  ',
    'EXAMPLE.COM',
    '',
    '   ',
  ])('accepts %j', (value) => {
    expect(re.test(value)).toBe(true);
  });

  it.each([
    'NA',
    'N/A',
    'companyabc',
    'javascript:alert(1)',
    'data:text/html,x',
    'ftp://example.com',
    'http://localhost:3000',
    'http://192.168.1.1',
    'a@b.com',
    'foo bar',
    'https://',
  ])('rejects %j', (value) => {
    expect(re.test(value)).toBe(false);
  });
});

describe('applyUrlRule', () => {
  it('adds the URL pattern to an x-uri string field', () => {
    const out = applyUrlRule({
      type: 'object',
      properties: { website: { type: 'string', 'x-uri': true, maxLength: 2048 } },
    });
    expect(out.properties.website).toEqual({
      type: 'string',
      'x-uri': true,
      maxLength: 2048,
      pattern: URL_PATTERN,
    });
  });

  it('turns a format:uri field into the same URL rule, dropping the strict format', () => {
    const out = applyUrlRule({
      type: 'object',
      properties: { catalog_url: { type: 'string', title: 'Catalog URL', format: 'uri' } },
    });
    expect(out.properties.catalog_url).toEqual({
      type: 'string',
      title: 'Catalog URL',
      'x-uri': true,
      pattern: URL_PATTERN,
    });
  });

  it('puts the pattern on items for an array of URLs', () => {
    const out = applyUrlRule({
      type: 'object',
      properties: {
        links: { type: 'array', 'x-uri': true, items: { type: 'string' } },
        mirrors: { type: 'array', items: { type: 'string', format: 'uri' } },
      },
    });
    expect(out.properties.links.items).toEqual({ type: 'string', pattern: URL_PATTERN });
    expect(out.properties.mirrors.items).toEqual({
      type: 'string',
      'x-uri': true,
      pattern: URL_PATTERN,
    });
  });

  it('keeps an author-supplied pattern', () => {
    const own = '^https://';
    const out = applyUrlRule({
      type: 'object',
      properties: { site: { type: 'string', format: 'uri', pattern: own } },
    });
    expect(out.properties.site).toEqual({ type: 'string', 'x-uri': true, pattern: own });
  });

  it('leaves other fields and other formats untouched', () => {
    const props = {
      email: { type: 'string', format: 'email' },
      name: { type: 'string', minLength: 1 },
      marked_false: { type: 'string', 'x-uri': 'yes' },
    };
    const out = applyUrlRule({ type: 'object', properties: props });
    expect(out.properties).toEqual(props);
  });

  it('recurses into nested objects and arrays of objects', () => {
    const out = applyUrlRule({
      type: 'object',
      properties: {
        org: { type: 'object', properties: { site: { type: 'string', format: 'uri' } } },
        refs: {
          type: 'array',
          items: { type: 'object', properties: { url: { type: 'string', 'x-uri': true } } },
        },
      },
    });
    expect(out.properties.org.properties.site.pattern).toBe(URL_PATTERN);
    expect(out.properties.refs.items.properties.url.pattern).toBe(URL_PATTERN);
  });

  it('does not mutate its input', () => {
    const input = {
      type: 'object',
      properties: { site: { type: 'string', format: 'uri' } },
    };
    const snapshot = structuredClone(input);
    applyUrlRule(input);
    expect(input).toEqual(snapshot);
  });

  it('returns non-object input unchanged', () => {
    expect(applyUrlRule(null)).toBeNull();
    expect(applyUrlRule('x')).toBe('x');
  });
});
