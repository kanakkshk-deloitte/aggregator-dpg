/**
 * Pulls the section list out of a consent document's Markdown so the public
 * legal page can build a contents rail and anchor each heading.
 *
 * @module apps/web/src/components/legal/legal-sections
 */

/** One entry in the contents rail. */
export interface LegalSection {
  id: string;
  heading: string;
  level: 2 | 3;
}

/**
 * Converts a heading to a URL-safe anchor id.
 *
 * @param heading - Raw heading text.
 * @returns Lowercase hyphenated slug.
 */
function slugify(heading: string): string {
  // Split and join so the slug never has leading or trailing hyphens,
  // without a trim regex that could backtrack.
  return heading
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join('-');
}

/**
 * Extracts `##` and `###` headings in document order.
 *
 * Fenced code blocks are skipped. Repeated slugs within one document get a
 * numeric suffix.
 *
 * @param markdown - The document body.
 * @returns Sections in order; empty when the document has no headings.
 */
export function extractSections(markdown: string): LegalSection[] {
  const out: LegalSection[] = [];
  const seen = new Map<string, number>();
  let inFence = false;

  for (const line of markdown.split('\n')) {
    if (line.trim().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    // Match the marker, then slice the rest. Avoids a backtracking regex.
    const trimmed = line.trim();
    const match = /^(#{2,3})\s/.exec(trimmed);
    if (!match) continue;

    const heading = trimmed.slice(match[1]!.length).trim();
    const base = slugify(heading);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);

    out.push({
      id: count === 1 ? base : `${base}-${count}`,
      heading,
      level: match[1]!.length === 2 ? 2 : 3,
    });
  }
  return out;
}
