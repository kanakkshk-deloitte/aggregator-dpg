/**
 * Contact identity primitives shared by every aggregator process.
 *
 * A contact is one person's name, email and phone, stored once in the
 * `contact` table and referenced by `contact_id` from coordinators and org
 * owners. The id is a deterministic hash of the canonical email + phone.
 *
 * The SQL function `contact_id_of(email, phone)` uses the same formula. Tests
 * check that both match. Change both together.
 *
 * The id is derived from PII and can be brute-forced. Never log it, send it to
 * telemetry, or put it in a URL.
 *
 * @module @aggregator-dpg/shared-primitives
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { normaliseEmail } from '../phone/index.js';

/**
 * Canonical contact phone: `+` then 10–15 digits, as produced by `normalisePhone`.
 * Matches the SQL `contact_phone_chk`.
 */
export const CONTACT_PHONE_REGEX = /^\+\d{10,15}$/;

/** Hex sha-256 id shape. Mirrors the SQL `contact_id_hex_chk`. */
export const CONTACT_ID_REGEX = /^[0-9a-f]{64}$/;

/** A stored contact row. */
export const ContactSchema = z.object({
  id: z.string().regex(CONTACT_ID_REGEX),
  email: z.string().min(1),
  phone: z.string().regex(CONTACT_PHONE_REGEX).nullable(),
  name: z.string().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

/** A stored contact row. */
export type Contact = z.infer<typeof ContactSchema>;

/**
 * Computes the deterministic contact id for an email + phone pair.
 *
 * The email is normalised here. The phone is not: it must already be
 * canonical (from `normalisePhone`), or `null`. A non-canonical phone is
 * rejected so one person does not get two ids.
 *
 * @param email - The contact's email address.
 * @param phone - The contact's canonical phone, or `null`/`undefined` when absent.
 * @returns The 64-char lowercase hex sha-256 of `lower(email):phone`.
 * @throws {TypeError} When the email is blank or the phone is not canonical.
 */
export function contactId(email: string, phone: string | null | undefined): string {
  const canonicalEmail = normaliseEmail(email);
  if (!canonicalEmail) throw new TypeError('contactId: email is required');
  if (phone !== null && phone !== undefined && !CONTACT_PHONE_REGEX.test(phone)) {
    throw new TypeError('contactId: phone must be canonical (+ followed by 10-15 digits)');
  }
  return createHash('sha256')
    .update(`${canonicalEmail}:${phone ?? ''}`, 'utf8')
    .digest('hex');
}
