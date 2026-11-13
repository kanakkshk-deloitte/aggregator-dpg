/**
 * The one renderer for externalised email cases.
 *
 * Belongs to `@aggregator-dpg/api`. Builds every case's subject, HTML body and
 * plain-text body from the layout on its registry entry.
 *
 * A template module supplies only its typed inputs; the layout lives in
 * `email-cases.ts` and the copy lives in the properties layers.
 *
 * @module @aggregator-dpg/api
 */

import {
  callout,
  ctaButton,
  ctaRow,
  getEmailBrand,
  heading,
  note,
  para,
  paraLast,
  paraSmall,
  renderShell,
} from './shared.js';
import { caseTokenTypes, getEmailCase, type BlockSpec, type EmailCaseDef } from './email-cases.js';
import { getMessage } from './messages.js';
import { substitute, toPlainText, type TokenTypes } from './substitute.js';

/** Token values for one render. `undefined` means "not supplied". */
export type CaseValues = Readonly<Record<string, string | undefined>>;

/** The three parts every mailer send needs. */
export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/**
 * Decides whether a conditional block belongs in this render.
 *
 * `requires` keeps a block out unless every named token has a value;
 * `absent` keeps it out unless every named token has none.
 */
function blockApplies(spec: BlockSpec, values: CaseValues): boolean {
  for (const token of spec.requires ?? []) {
    if (values[token] === undefined || values[token] === '') return false;
  }
  for (const token of spec.absent ?? []) {
    if (values[token] !== undefined && values[token] !== '') return false;
  }
  return true;
}

const BLOCK_RENDERERS: Record<string, (html: string) => string> = {
  heading,
  para,
  paraLast,
  paraSmall,
  note,
  callout,
};

/**
 * Picks the first key whose block applies, for a `oneOf` alternation.
 *
 * @param spec - Block spec carrying `oneOf` alternatives.
 * @param values - Token values.
 * @returns The chosen key, or undefined when no alternative applies.
 */
function chooseKey(spec: BlockSpec, values: CaseValues): string | undefined {
  if (!spec.oneOf) return spec.key;
  for (const alt of spec.oneOf) {
    if (blockApplies({ ...spec, ...alt, oneOf: undefined }, values)) return alt.key;
  }
  return undefined;
}

/**
 * Resolves the case's derived tokens to already-substituted HTML.
 *
 * A derived token is a copy-key alternation used mid-sentence rather than as
 * its own block, so it is declared `html` in the registry and inserted raw.
 *
 * @param caseId - Case prefix.
 * @param def - Case definition.
 * @param values - Token values, brand tokens included.
 * @param types - Declared token types.
 * @returns Token name → rendered fragment, for tokens whose alternation matched.
 */
function resolveDerivedTokens(
  caseId: string,
  def: EmailCaseDef,
  values: CaseValues,
  types: TokenTypes,
): Record<string, string> {
  const derived: Record<string, string> = {};
  for (const [token, alternatives] of Object.entries(def.derivedTokens ?? {})) {
    const spec: BlockSpec = { block: 'para', key: alternatives[0]!.key, oneOf: alternatives };
    const key = chooseKey(spec, values);
    if (key) derived[token] = substitute(getMessage(`${caseId}.${key}`), values, types);
  }
  return derived;
}

/** One block's contribution to the two bodies. */
interface RenderedBlock {
  html: string;
  text: string;
}

/**
 * Renders one layout block, or nothing when it does not apply.
 *
 * @param spec - Block spec from the case layout.
 * @param values - Token values, brand and derived tokens included.
 * @param copy - Resolves a copy key to its substituted fragment.
 * @returns The block's HTML and text, or null when it is skipped.
 * @throws {Error} If the layout names a block kind this renderer lacks.
 */
function renderBlock(
  spec: BlockSpec,
  values: CaseValues,
  copy: (key: string) => string,
): RenderedBlock | null {
  if (!blockApplies(spec, values)) return null;
  const key = chooseKey(spec, values);
  if (key === undefined) return null;
  const fragment = copy(key);

  if (spec.block === 'cta') {
    // A CTA with no href would render `<a href="">`; drop it instead.
    const href = spec.href ? values[spec.href] : undefined;
    if (href === undefined || href === '') return null;
    const label = toPlainText(fragment);
    return {
      html: ctaRow(ctaButton(label, href, spec.tone ?? 'primary')),
      text: `${label}: ${href}`,
    };
  }

  const render = BLOCK_RENDERERS[spec.block];
  if (!render) throw new Error(`unknown block kind: ${spec.block}`);
  return { html: render(fragment), text: toPlainText(fragment) };
}

/**
 * Renders one externalised email case.
 *
 * @param caseId - Registry key, e.g. `applicant_approved`.
 * @param values - Token values. Brand tokens are added automatically, and a
 *   token used for a CTA href is passed through unescaped by the button
 *   helper rather than substituted into copy.
 * @returns Subject plus the HTML and plain-text bodies.
 * @throws {Error} If the case is not registered.
 */
export function renderCase(caseId: string, values: CaseValues): RenderedEmail {
  const def = getEmailCase(caseId);
  const brand = getEmailBrand();
  const types = caseTokenTypes(caseId);

  const base: CaseValues = {
    brandShort: brand.short_name,
    brandLong: brand.long_name,
    ...values,
  };
  const all: CaseValues = { ...base, ...resolveDerivedTokens(caseId, def, base, types) };

  const copy = (key: string): string => substitute(getMessage(`${caseId}.${key}`), all, types);

  const htmlBlocks: string[] = [];
  const textBlocks: string[] = [];
  for (const spec of def.layout) {
    const block = renderBlock(spec, all, copy);
    if (!block) continue;
    htmlBlocks.push(block.html);
    textBlocks.push(block.text);
  }

  const subject = toPlainText(copy(def.subjectKey ?? 'subject'));
  const signOff = def.signOff === false ? '' : `\nSent by ${brand.long_name}.\n`;

  return {
    subject,
    html: renderShell({ preheader: subject, bodyHtml: htmlBlocks.join('\n') }),
    text: `${textBlocks.join('\n\n')}\n${signOff}`,
  };
}
