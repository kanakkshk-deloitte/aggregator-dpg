import { describe, it, expect } from 'vitest';
import { contactId, ContactSchema, CONTACT_PHONE_REGEX } from '../contact/index.js';
import { normalisePhone } from '../phone/index.js';

/**
 * Golden vectors — computed independently by Postgres 16:
 *   SELECT encode(sha256(convert_to(lower(btrim(email)) || ':' || coalesce(phone,''),'UTF8')),'hex')
 * i.e. the SQL `contact_id_of()` in migration 0025. If one side changes, the
 * other must change in the same commit; the api integration test re-checks
 * these against a live database.
 */
const CONTACT_ID_GOLDEN_VECTORS: ReadonlyArray<{
  email: string;
  phone: string | null;
  id: string;
}> = [
  {
    email: 'asha@example.org',
    phone: '+919876543210',
    id: '4d2117c7c1fdbf7b50098f3768922c3d2a51281411ae7e7eb4cbae9d29093850',
  },
  {
    email: 'owner@example.org',
    phone: null,
    id: '732b7edb6d90df9d30e76626db73097259f92f9f5d531d784b2d8a6d15513638',
  },
  {
    email: 'ZOË@example.org',
    phone: '+919876543210',
    id: 'e8694af539d982a6c5706b69aea53af35fcaf24fc4a463050cdcad8430d0e3c3',
  },
];

describe('contactId', () => {
  it.each(CONTACT_ID_GOLDEN_VECTORS)('matches the SQL hash for $email / $phone', (v) => {
    expect(contactId(v.email, v.phone)).toBe(v.id);
  });

  it('is case- and whitespace-insensitive on the email', () => {
    expect(contactId('  Asha@Example.ORG ', '+919876543210')).toBe(
      contactId('asha@example.org', '+919876543210'),
    );
  });

  it('treats undefined and null phone identically', () => {
    expect(contactId('owner@example.org', undefined)).toBe(contactId('owner@example.org', null));
  });

  it('differs when only the phone differs', () => {
    expect(contactId('a@example.org', '+919876543210')).not.toBe(
      contactId('a@example.org', '+919876543211'),
    );
  });

  it('accepts exactly what normalisePhone produces', () => {
    for (const raw of ['9876543210', '+91 98765 43210', '0091-9876543210', '+14155550123']) {
      const n = normalisePhone(raw);
      expect(n.ok).toBe(true);
      if (n.ok) expect(CONTACT_PHONE_REGEX.test(n.value)).toBe(true);
    }
  });

  it('rejects a non-canonical phone rather than splitting one person across ids', () => {
    expect(() => contactId('a@example.org', '9876543210')).toThrow(TypeError);
    expect(() => contactId('a@example.org', '')).toThrow(TypeError);
  });

  it('rejects a blank email', () => {
    expect(() => contactId('   ', '+919876543210')).toThrow(TypeError);
  });
});

describe('ContactSchema', () => {
  it('parses a stored row', () => {
    const row = ContactSchema.parse({
      id: CONTACT_ID_GOLDEN_VECTORS[0]!.id,
      email: 'asha@example.org',
      phone: '+919876543210',
      name: null,
      createdAt: '2026-09-30T00:00:00.000Z',
      updatedAt: '2026-09-30T00:00:00.000Z',
    });
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it('rejects a malformed id', () => {
    expect(() =>
      ContactSchema.parse({
        id: 'nope',
        email: 'a@example.org',
        phone: null,
        name: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ).toThrow();
  });
});
