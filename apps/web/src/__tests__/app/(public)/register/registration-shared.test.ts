/**
 * Unit tests for the pure registration helpers shared by the coordinator and
 * org registration forms: `titleCase`, `lookupTitle`, `humaniseValidationErrors`,
 * `parseError`, `stripFormChrome`, `submitRegistration`, and `stampConsent`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { RJSFSchema } from '@rjsf/utils';
import {
  titleCase,
  lookupTitle,
  humaniseValidationErrors,
  parseError,
  stripFormChrome,
  submitRegistration,
  stampConsent,
  stripConsentBlock,
  withResolvedCoordinates,
  withOrgCoordinates,
} from '@/app/(public)/register/registration-shared';

describe('titleCase', () => {
  it('title-cases a snake_case key', () => {
    expect(titleCase('owner_email')).toBe('Owner Email');
  });

  it('title-cases a kebab-case key', () => {
    expect(titleCase('owner-email')).toBe('Owner Email');
  });

  it('title-cases a dotted path', () => {
    expect(titleCase('owner.email')).toBe('Owner Email');
  });

  it('splits camelCase words', () => {
    expect(titleCase('ownerEmail')).toBe('Owner Email');
  });

  it('returns empty string for empty input', () => {
    expect(titleCase('')).toBe('');
  });
});

describe('lookupTitle', () => {
  const schema: RJSFSchema = {
    type: 'object',
    properties: {
      owner: {
        type: 'object',
        properties: {
          email: { type: 'string', title: 'Owner Email' },
        },
      },
      name: { type: 'string' },
    },
  };

  it('returns undefined for an empty path', () => {
    expect(lookupTitle(schema, '')).toBeUndefined();
  });

  it('resolves a nested title via a dotted path', () => {
    expect(lookupTitle(schema, 'owner.email')).toBe('Owner Email');
  });

  it('returns undefined when the leaf has no title', () => {
    expect(lookupTitle(schema, 'name')).toBeUndefined();
  });

  it('returns undefined when an intermediate segment is missing', () => {
    expect(lookupTitle(schema, 'missing.email')).toBeUndefined();
  });

  it('returns undefined when the path walks past a non-object node', () => {
    expect(lookupTitle(schema, 'name.extra')).toBeUndefined();
  });
});

describe('humaniseValidationErrors', () => {
  const schema: RJSFSchema = {
    type: 'object',
    properties: {
      owner: {
        type: 'object',
        properties: {
          email: { type: 'string', title: 'Owner Email' },
        },
      },
    },
  };

  it('humanises a required-field error using the schema title', () => {
    const out = humaniseValidationErrors(
      [{ name: 'required', property: 'owner', params: { missingProperty: 'email' } }],
      schema,
    );
    expect(out).toEqual(['Owner Email is required']);
  });

  it('uses the schema title when RJSF already ends the path with the missing field', () => {
    const out = humaniseValidationErrors(
      [{ name: 'required', property: '.owner.email', params: { missingProperty: 'email' } }],
      schema,
    );
    expect(out).toEqual(['Owner Email is required']);
  });

  it('falls back to a title-cased key when no schema title exists', () => {
    const out = humaniseValidationErrors(
      [{ name: 'required', property: '', params: { missingProperty: 'phone_number' } }],
      schema,
    );
    expect(out).toEqual(['Phone Number is required']);
  });

  it('formats a non-required error with the raw message', () => {
    const out = humaniseValidationErrors(
      [{ property: '.owner.email', message: 'must match format "email"' }],
      schema,
    );
    expect(out).toEqual(['Owner Email: must match format "email"']);
  });

  it('falls back to the raw message when no label can be resolved', () => {
    const out = humaniseValidationErrors([{ property: '', message: 'Something went wrong' }], {
      type: 'object',
    });
    expect(out).toEqual(['Something went wrong']);
  });

  it('falls back to the schema path when neither label nor message exist', () => {
    const out = humaniseValidationErrors([{ property: '', schemaPath: '#/required' }], {
      type: 'object',
    });
    expect(out).toEqual(['Validation failed at required']);
  });

  it('returns a generic line when nothing is resolvable at all', () => {
    const out = humaniseValidationErrors([{}], { type: 'object' });
    expect(out).toEqual(['One or more fields failed validation.']);
  });

  it('returns the generic fallback line for an empty error list', () => {
    expect(humaniseValidationErrors([], schema)).toEqual(['One or more fields failed validation.']);
  });

  it('de-duplicates identical resolved lines', () => {
    const out = humaniseValidationErrors(
      [
        { name: 'required', property: 'owner', params: { missingProperty: 'email' } },
        { name: 'required', property: 'owner', params: { missingProperty: 'email' } },
      ],
      schema,
    );
    expect(out).toEqual(['Owner Email is required']);
  });
});

describe('parseError', () => {
  it('extracts title/detail/code/requestId from a well-formed envelope', () => {
    const out = parseError(
      {
        error: {
          title: 'Bad input',
          detail: 'Name is required',
          code: 'VALIDATION',
          requestId: 'req-1',
        },
      },
      400,
      'fallback-req',
    );
    expect(out).toEqual({
      title: 'Bad input',
      detail: 'Name is required',
      code: 'VALIDATION',
      requestId: 'req-1',
    });
  });

  it('falls back to defaults when the body is not an envelope', () => {
    const out = parseError(null, 500, 'req-xyz');
    expect(out).toEqual({
      title: 'Submission failed',
      detail: 'The server returned HTTP 500.',
      code: 'UNKNOWN',
      requestId: 'req-xyz',
    });
  });

  it('falls back to the given requestId when the envelope omits one', () => {
    const out = parseError({ error: {} }, 502, 'req-fallback');
    expect(out.requestId).toBe('req-fallback');
  });
});

describe('stripFormChrome', () => {
  it('removes title and description, keeping everything else', () => {
    const schema: RJSFSchema = {
      title: 'Aggregator Registration',
      description: 'API contract note',
      type: 'object',
      properties: { name: { type: 'string' } },
    };
    const out = stripFormChrome(schema);
    expect(out.title).toBeUndefined();
    expect(out.description).toBeUndefined();
    expect(out.properties).toEqual({ name: { type: 'string' } });
  });

  it('does not mutate the original schema object', () => {
    const schema: RJSFSchema = { title: 'X', type: 'object' };
    stripFormChrome(schema);
    expect(schema.title).toBe('X');
  });
});

describe('submitRegistration', () => {
  let originalFetch: typeof fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns ok:true with the parsed body on a 2xx response', async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ aggregator_id: 'agg-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;

    const result = await submitRegistration('/api/aggregator/register', { name: 'Acme' });
    expect(result).toEqual({ ok: true, body: { aggregator_id: 'agg-1' } });
  });

  it('returns a parsed error envelope on a non-2xx response', async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { title: 'Nope', detail: 'Bad', code: 'X' } }), {
          status: 400,
          headers: { 'content-type': 'application/json', 'x-request-id': 'req-9' },
        }),
    ) as unknown as typeof fetch;

    const result = await submitRegistration('/api/aggregator/register', {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({ title: 'Nope', detail: 'Bad', code: 'X', requestId: 'req-9' });
    }
  });

  it('falls back to an empty body when the error response is not JSON', async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () => new Response('not json', { status: 500 }),
    ) as unknown as typeof fetch;

    const result = await submitRegistration('/api/aggregator/register', {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UNKNOWN');
      expect(result.error.detail).toBe('The server returned HTTP 500.');
    }
  });

  it('returns a network-error result when fetch throws', async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      throw new Error('fetch failed: DNS lookup');
    }) as unknown as typeof fetch;

    const result = await submitRegistration('/api/aggregator/register', {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        title: 'Network error',
        detail: 'fetch failed: DNS lookup',
        code: 'NETWORK_ERROR',
        requestId: '',
      });
    }
  });

  it('returns a generic network-error detail when the thrown value is not an Error', async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      throw 'boom';
    }) as unknown as typeof fetch;

    const result = await submitRegistration('/api/aggregator/register', {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.detail).toBe('Could not reach the server.');
    }
  });
});

describe('stampConsent', () => {
  it('stamps given_at and valid_till one year apart', () => {
    const consent = stampConsent(undefined);
    const givenAt = new Date(consent['given_at'] as string);
    const validTill = new Date(consent['valid_till'] as string);
    expect(validTill.getFullYear()).toBe(givenAt.getFullYear() + 1);
  });

  it('merges over existing consent fields without dropping them', () => {
    const consent = stampConsent({ accepted_terms: true });
    expect(consent['accepted_terms']).toBe(true);
    expect(consent['given_at']).toBeDefined();
    expect(consent['valid_till']).toBeDefined();
  });
});

describe('stripConsentBlock', () => {
  const schema = {
    type: 'object',
    required: ['name', 'contact', 'consent'],
    properties: {
      name: { type: 'string' },
      contact: { type: 'object' },
      consent: { type: 'object', required: ['value'], properties: { value: { type: 'boolean' } } },
    },
  } as const;

  it('removes the consent property and its required entry', () => {
    const out = stripConsentBlock(schema as never);
    expect(out.properties).not.toHaveProperty('consent');
    expect(out.required).toEqual(['name', 'contact']);
  });

  it('leaves every other field untouched', () => {
    const out = stripConsentBlock(schema as never);
    expect(out.properties).toHaveProperty('name');
    expect(out.type).toBe('object');
  });

  it('does not mutate the schema it was given', () => {
    stripConsentBlock(schema as never);
    expect(schema.properties).toHaveProperty('consent');
    expect(schema.required).toContain('consent');
  });

  it('is a no-op on a schema with no consent block', () => {
    const bare = { type: 'object', required: ['name'], properties: { name: { type: 'string' } } };
    expect(stripConsentBlock(bare as never)).toEqual(bare);
  });
});

describe('withResolvedCoordinates', () => {
  const payload = () => ({
    name: 'Asha',
    locations: [
      { geo: { type: 'Point', coordinates: [0, 0] }, address: { streetAddress: 'JP Nagar' } },
    ],
  });

  it('writes the coordinate as GeoJSON [longitude, latitude]', () => {
    // The single assertion this whole helper exists to get right. The widget
    // reports lat/lng; GeoJSON stores lng/lat. Swapped, Bengaluru (12.9N,
    // 77.6E) becomes a point off Somalia — a plausible-looking wrong answer
    // that no type check catches, since both are numbers.
    const out = withResolvedCoordinates(payload(), { lat: 12.9352, lng: 77.6245 });
    const locations = out['locations'] as Array<{ geo: { coordinates: number[] } }>;
    expect(locations[0]?.geo.coordinates).toEqual([77.6245, 12.9352]);
  });

  it('keeps the rest of the location entry intact', () => {
    const out = withResolvedCoordinates(payload(), { lat: 12.9352, lng: 77.6245 });
    const locations = out['locations'] as Array<{ address: { streetAddress: string } }>;
    expect(locations[0]?.address).toEqual({ streetAddress: 'JP Nagar' });
    expect(out['name']).toBe('Asha');
  });

  it('leaves the [0,0] placeholder alone when nothing was resolved', () => {
    // Typed an address without picking a suggestion. `locations.items.required`
    // includes `geo`, so the entry cannot drop it — the placeholder stands.
    const original = payload();
    expect(withResolvedCoordinates(original, null)).toBe(original);
  });

  it('returns the payload untouched when it carries no locations', () => {
    const orgBody = { display_name: 'Acme' };
    expect(withResolvedCoordinates(orgBody, { lat: 1, lng: 2 })).toBe(orgBody);
    expect(withResolvedCoordinates({ locations: [] }, { lat: 1, lng: 2 })).toEqual({
      locations: [],
    });
  });
});

describe('withOrgCoordinates', () => {
  const place = { lat: 12.9741854, lng: 77.6124135 };

  it('writes [longitude, latitude], not [lat, lng]', () => {
    // The one assertion that matters. Both members are numbers, so a swap
    // type-checks cleanly and puts Bengaluru (12.97N, 77.61E) in the sea off
    // Somalia. The coordinator path has the same pin; this is its twin.
    const out = withOrgCoordinates({ display_name: 'ABC Limited' }, place);
    expect(out['coordinates']).toEqual([77.6124135, 12.9741854]);
    const [lng, lat] = out['coordinates'] as [number, number];
    expect(lng).toBeGreaterThan(lat);
  });

  it('returns the payload untouched when nothing was resolved', () => {
    // Typing an address without picking a suggestion is the common case: send
    // no point rather than a guessed one.
    const body = { display_name: 'ABC Limited' };
    const out = withOrgCoordinates(body, null);
    expect(out).toEqual(body);
    expect(out).not.toHaveProperty('coordinates');
  });

  it('keeps the rest of the body intact', () => {
    const out = withOrgCoordinates(
      { display_name: 'ABC Limited', address: { streetAddress: 'MG Road' }, owner: { name: 'A' } },
      place,
    );
    expect(out['display_name']).toBe('ABC Limited');
    expect(out['address']).toEqual({ streetAddress: 'MG Road' });
    expect(out['owner']).toEqual({ name: 'A' });
  });

  it('does not mutate the input', () => {
    const body = { display_name: 'ABC Limited' };
    withOrgCoordinates(body, place);
    expect(body).not.toHaveProperty('coordinates');
  });
});
