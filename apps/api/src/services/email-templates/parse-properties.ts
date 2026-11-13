/**
 * Minimal Java-properties-style parser for the externalised email copy.
 *
 * Belongs to `@aggregator-dpg/api`. Matches the Signals-DPG parser: `key=value`
 * per line, `#`/`!` comments, split at the first `=`, no escapes and no line
 * continuation. Values may contain further `=` characters.
 *
 * Malformed lines are collected and reported, not dropped silently.
 *
 * @module @aggregator-dpg/api
 */

/**
 * Result of parsing one properties file.
 */
export interface ParsedProperties {
  /** Key → value, later duplicates overwriting earlier ones. */
  entries: Map<string, string>;
  /** 1-based line numbers that were neither blank/comment nor `key=value`. */
  malformedLines: number[];
}

/**
 * Parses properties-file text into key/value entries.
 *
 * @param text - Raw file contents.
 * @returns The parsed entries plus the line numbers of anything unparseable.
 */
export function parseProperties(text: string): ParsedProperties {
  const entries = new Map<string, string>();
  const malformedLines: number[] = [];

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? '';
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith('!')) continue;

    const eq = line.indexOf('=');
    // A leading `=` has no key, and no `=` at all is not an assignment.
    if (eq <= 0) {
      malformedLines.push(i + 1);
      continue;
    }

    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === '') {
      malformedLines.push(i + 1);
      continue;
    }
    entries.set(key, value);
  }

  return { entries, malformedLines };
}
