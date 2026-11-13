/**
 * Two-letter initials for avatars (`apps/web`).
 *
 * @module apps/web/src/lib/initials
 */

/**
 * Up to two initials from a name or an email: the first letters of the first
 * two words, or the first two letters of a single word.
 *
 * @param text - A name, or an email when there is no name.
 * @returns The initials in upper case.
 */
export function initialsOf(text: string): string {
  const words = text
    .trim()
    .split(/[\s@._-]+/)
    .filter(Boolean);
  const letters = words.length > 1 ? words[0]![0]! + words[1]![0]! : (words[0] ?? '').slice(0, 2);
  return letters.toUpperCase();
}
