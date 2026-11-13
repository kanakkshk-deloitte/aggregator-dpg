/**
 * Contact-detail normalisation shared by every aggregator process.
 *
 * Phone numbers keep digits and one leading `+`. A bare 10-digit number is
 * treated as Indian (`+91`).
 *
 * @module @aggregator-dpg/shared-primitives
 */

/** Successful normalisation carrying the canonical value. */
export interface PhoneNormaliseOk {
  ok: true;
  value: string;
}

/** Failed normalisation carrying a human-readable reason. */
export interface PhoneNormaliseError {
  ok: false;
  error: { message: string };
}

/** Outcome of {@link normalisePhone}. */
export type PhoneNormaliseResult = PhoneNormaliseOk | PhoneNormaliseError;

/** Digits in a local mobile number (India), without the country code. */
export const PHONE_LOCAL_DIGITS = 10;
/** Country calling code assumed for a bare local number, without the `+`. */
export const PHONE_COUNTRY_CODE = '91';

const MIN_DIGITS = PHONE_LOCAL_DIGITS;
const MAX_DIGITS = 15;
const DEFAULT_COUNTRY_CODE = PHONE_COUNTRY_CODE;

/**
 * Normalises a phone number to a canonical `+`-prefixed form. Does not throw.
 *
 * @param raw - User-supplied phone string, in any spacing or punctuation.
 * @returns `{ ok: true, value }`, or `{ ok: false, error }` with the reason.
 */
export function normalisePhone(raw: string): PhoneNormaliseResult {
  if (!raw) return { ok: false, error: { message: 'phone is empty' } };
  // Keep an optional leading + and digits only.
  const cleaned = raw.trim().replace(/[^\d+]/g, '');

  if (cleaned.startsWith('+')) {
    const digits = cleaned.slice(1);
    if (digits.length < MIN_DIGITS || digits.length > MAX_DIGITS) {
      return {
        ok: false,
        error: {
          message: `phone must have ${MIN_DIGITS}-${MAX_DIGITS} digits after country code`,
        },
      };
    }
    return { ok: true, value: `+${digits}` };
  }

  // Bare digits — assume the default region when exactly 10 digits.
  if (cleaned.length === MIN_DIGITS) {
    return { ok: true, value: `+${DEFAULT_COUNTRY_CODE}${cleaned}` };
  }
  if (cleaned.length > MIN_DIGITS && cleaned.length <= MAX_DIGITS) {
    return { ok: true, value: `+${cleaned}` };
  }
  return {
    ok: false,
    error: {
      message: `phone has ${cleaned.length} digits; expected ${MIN_DIGITS}-${MAX_DIGITS}`,
    },
  };
}

/**
 * Trims and lower-cases an email address. Blank input becomes `null`.
 *
 * @param raw - User-supplied email, or `null`/`undefined` when not provided.
 * @returns The normalised address, or `null` when there was nothing usable.
 */
export function normaliseEmail(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed.toLowerCase();
}

// Simple email check to reject obvious garbage. Linear: no catastrophic backtracking.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

/**
 * Whether `email` looks like an email address: one `@`, no spaces, and a
 * dotted domain. A shape check only; it does not prove the mailbox exists.
 *
 * @param email - The address, already trimmed.
 * @returns `true` when the shape is acceptable.
 */
export function isEmailAddress(email: string): boolean {
  return EMAIL_RE.test(email);
}
