/**
 * Renders campaign emails from Markdown to sanitised HTML and plain text.
 *
 * Values are HTML-escaped in the HTML part. The subject and text parts are
 * plain text. Kept in its own subpath so callers that only validate do not
 * load the Markdown dependencies. Belongs to `@aggregator-dpg/campaign-template`.
 */
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import { substitute, escapeHtml, type PlaceholderValues } from './index.js';

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

// Allows only basic formatting tags. Strips scripts, styles, event handlers and unsafe URL schemes.
const SANITIZE_OPTS: sanitizeHtml.IOptions = {
  allowedTags: [
    'p',
    'br',
    'strong',
    'b',
    'em',
    'i',
    'u',
    'ul',
    'ol',
    'li',
    'a',
    'h1',
    'h2',
    'h3',
    'h4',
    'blockquote',
    'code',
    'pre',
    'hr',
    'span',
  ],
  allowedAttributes: { a: ['href', 'title'] },
  allowedSchemes: ['http', 'https', 'mailto'],
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer' }),
  },
};

/**
 * Renders one recipient's email from the shared Markdown template.
 *
 * The body is rendered and sanitised first, then placeholders are substituted.
 * Values are HTML-escaped in the HTML part only.
 *
 * @param input.subject - Subject template (may contain placeholders).
 * @param input.bodyMarkdown - Markdown body template (may contain placeholders).
 * @param input.values - This recipient's placeholder values.
 * @returns The rendered subject, HTML, and plain-text parts.
 */
export function renderEmail(input: {
  subject: string;
  bodyMarkdown: string;
  values: PlaceholderValues;
}): RenderedEmail {
  const { subject, bodyMarkdown, values } = input;
  const rendered = marked.parse(bodyMarkdown, { async: false }) as string;
  const htmlTemplate = sanitizeHtml(rendered, SANITIZE_OPTS);
  return {
    subject: substitute(subject, values),
    html: substitute(htmlTemplate, values, escapeHtml),
    text: substitute(bodyMarkdown, values),
  };
}
