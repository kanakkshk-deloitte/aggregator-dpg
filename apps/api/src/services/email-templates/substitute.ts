/**
 * `{{token}}` substitution for externalised email copy.
 *
 * Belongs to `@aggregator-dpg/api`. Substitution is typed. A `text` token is
 * HTML-escaped; an `html` token is inserted raw and must be built in code from
 * already-escaped parts. This keeps copy files from injecting HTML.
 *
 * An unprovided token is left as literal `{{token}}` text.
 *
 * @module @aggregator-dpg/api
 */

import { escapeHtml } from './shared.js';

/**
 * The one `{{token}}` grammar, shared by the substituter and the boot-time
 * validator so the two cannot disagree about what a token looks like.
 */
export const TOKEN_RE = /\{\{(\w+)\}\}/g;

/** How a token's value must be treated on substitution. */
export type TokenType = 'text' | 'html';

/** Declared token types for one email case. */
export type TokenTypes = Readonly<Record<string, TokenType>>;

/**
 * Substitutes `{{token}}` placeholders in a copy fragment.
 *
 * @param template - Copy fragment from the properties file.
 * @param values - Token values; a missing or undefined value is left literal.
 * @param types - Declared type per token. Undeclared tokens are treated as `text` (escaped).
 * @returns The fragment with tokens substituted.
 */
export function substitute(
  template: string,
  values: Readonly<Record<string, string | undefined>>,
  types: TokenTypes = {},
): string {
  return template.replace(TOKEN_RE, (whole, name: string) => {
    const value = values[name];
    if (value === undefined) return whole;
    return types[name] === 'html' ? value : escapeHtml(value);
  });
}

/**
 * Collects the token names used by a copy fragment.
 *
 * @param template - Copy fragment.
 * @returns Token names, deduplicated.
 */
export function tokensUsed(template: string): string[] {
  return [...new Set([...template.matchAll(TOKEN_RE)].map((m) => m[1] as string))];
}

/**
 * The copy files' entire tag vocabulary, as an explicit allow-list.
 *
 * The attribute run is bounded (`{0,200}`) and excludes `<`/`>` so the
 * pattern cannot backtrack super-linearly.
 */
const ALLOWED_TAG_RE = /<\/?(?:b|strong|i|em|a|br)(?:\s[^<>]{0,200})?\/?>/gi;

/**
 * Converts a copy fragment to its plain-text equivalent.
 *
 * The text part is derived from the HTML so the two stay in sync.
 *
 * Only the allowed tags (`<b> <strong> <i> <em> <a> <br>`) are stripped. Any
 * other tag stays visible in the text part.
 *
 * @param html - Copy fragment, already substituted.
 * @returns Plain-text rendering with entities decoded.
 */
export function toPlainText(html: string): string {
  return (
    html
      .replaceAll(ALLOWED_TAG_RE, (tag) => (tag.toLowerCase().startsWith('<br') ? '\n' : ''))
      .replaceAll('&nbsp;', ' ')
      .replaceAll('&quot;', '"')
      .replaceAll('&#39;', "'")
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      // `&amp;` last: decoding it earlier would let `&amp;lt;` become `<`.
      .replaceAll('&amp;', '&')
      .replaceAll(/[ \t]+/g, ' ')
      .trim()
  );
}
