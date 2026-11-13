/**
 * Person-name rules shared by the aggregator web forms and API
 * (`@aggregator-dpg/shared-primitives`).
 *
 * Owner and coordinator names become the first and last name of a Keycloak
 * user, and Keycloak's person-name validator refuses some characters. The
 * forms check names with the same rule so a person is told before submitting,
 * not after the account cannot be created. Browser-safe: no Node imports.
 *
 * @module @aggregator-dpg/shared-primitives/person-name
 */

/**
 * Characters Keycloak's default person-name validator refuses, as one regular
 * expression character class (control characters included).
 */
const REFUSED = /[<>&"$%!#?§;*~/\\|^=[\]{}()\u0000-\u001F\u007F]/gu;

/**
 * The characters in a name that Keycloak would refuse, each once, in order of
 * first appearance. An empty list means the name is accepted.
 *
 * @param name - The name as typed.
 * @returns The refused characters; control characters are shown as `\uXXXX`.
 */
export function refusedNameCharacters(name: string): string[] {
  const seen = new Set<string>();
  for (const match of name.matchAll(REFUSED)) {
    const ch = match[0];
    const code = ch.codePointAt(0) ?? 0;
    seen.add(code < 0x20 || code === 0x7f ? `\\u${code.toString(16).padStart(4, '0')}` : ch);
  }
  return [...seen];
}
