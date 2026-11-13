/**
 * Shared helpers and types for the coordinator and org registration forms.
 *
 * Holds the framework-free logic both forms use: readable validation errors,
 * API error parsing, submit, and payload shaping.
 *
 * @module apps/web/src/app/(public)/register/registration-shared
 */

import type { RJSFSchema } from '@rjsf/utils';

/** Discriminated submit lifecycle shared by both registration forms. */
export type SubmitState =
  | { status: 'idle' }
  | { status: 'submitting' }
  /**
   * Submitted successfully. `outcome` separates a new pending registration
   * from an already-approved org whose invite link was re-sent.
   */
  | {
      status: 'done';
      refId: string;
      outcome?: 'pending' | 'already_registered';
      mailSent?: boolean;
    }
  | { status: 'error'; title: string; detail: string; code: string; requestId: string };

/** Canonical API error envelope (partial — every field optional on the wire). */
export interface ApiErrorEnvelope {
  error?: {
    code?: string;
    title?: string;
    detail?: string;
    requestId?: string;
    fields?: Record<string, unknown>;
  };
}

/** Ajv-shaped validation error as surfaced by RJSF's `onError`. */
export interface AjvLikeError {
  name?: string;
  property?: string;
  message?: string;
  params?: Record<string, unknown>;
  schemaPath?: string;
}

/**
 * Title-cases a snake/kebab/dotted field key for a user-facing label.
 *
 * @param s - Raw field key (e.g. `owner.email`).
 * @returns Human-readable title (e.g. `Owner Email`).
 */
export function titleCase(s: string): string {
  return s
    .replace(/[_-]+/g, ' ')
    .replace(/\.([a-z])/gi, ' $1')
    .replace(/([A-Z])/g, ' $1')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : ''))
    .join(' ');
}

/**
 * Walks a JSON Schema along a dotted path and returns the leaf node's `title`.
 *
 * @param schema - The JSON Schema to walk.
 * @param dottedPath - Dotted property path (e.g. `owner.email`).
 * @returns The leaf `title` if present, else `undefined`.
 */
export function lookupTitle(schema: RJSFSchema, dottedPath: string): string | undefined {
  if (!dottedPath) return undefined;
  const segs = dottedPath.split('.').filter(Boolean);
  let cur: unknown = schema;
  for (const seg of segs) {
    if (cur && typeof cur === 'object' && 'properties' in cur) {
      const props = (cur as { properties?: Record<string, unknown> }).properties;
      const next = props?.[seg];
      if (!next) return undefined;
      cur = next;
    } else {
      return undefined;
    }
  }
  if (cur && typeof cur === 'object' && 'title' in cur) {
    return (cur as { title?: string }).title;
  }
  return undefined;
}

/**
 * Converts Ajv validation errors into readable lines using each field's schema `title`.
 *
 * @param errs - Raw Ajv errors from RJSF `onError`.
 * @param schema - The (pruned) schema the form validated against.
 * @returns De-duplicated, human-readable error lines (never empty).
 */
export function humaniseValidationErrors(errs: AjvLikeError[], schema: RJSFSchema): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of errs) {
    const propPath = (e.property ?? '').replace(/^\./, '');
    const missing = (e.params?.['missingProperty'] as string | undefined) ?? undefined;
    // RJSF already ends a missing field's path with the field; Ajv gives only the parent.
    const endsWithMissing = missing && (propPath === missing || propPath.endsWith(`.${missing}`));
    const fullPath =
      missing && !endsWithMissing ? [propPath, missing].filter(Boolean).join('.') : propPath;
    const titleFromSchema = lookupTitle(schema, fullPath);
    const fallbackKey = missing || fullPath.split('.').pop() || '';
    const resolvedLabel =
      (titleFromSchema && titleFromSchema.trim()) || (fallbackKey && titleCase(fallbackKey)) || '';
    const isRequired = e.name === 'required' || /required/i.test(e.message ?? '');
    const rawMessage = (e.message ?? '').trim();
    let line: string;
    if (resolvedLabel) {
      line = isRequired
        ? `${resolvedLabel} is required`
        : `${resolvedLabel}: ${rawMessage || 'is invalid'}`;
    } else if (rawMessage) {
      line = rawMessage;
    } else {
      const where = (e.schemaPath ?? '').replace(/^#?\/?/, '');
      line = where ? `Validation failed at ${where}` : 'One or more fields failed validation.';
    }
    if (!seen.has(line)) {
      seen.add(line);
      out.push(line);
    }
  }
  return out.length > 0 ? out : ['One or more fields failed validation.'];
}

/**
 * Extracts a display-ready error from the API error envelope, with fallbacks for missing fields.
 *
 * @param body - Parsed response body (may not be an envelope).
 * @param fallbackStatus - HTTP status, used to synthesise a detail line.
 * @param fallbackReqId - Request id to attribute when the body omits one.
 * @returns Normalised `{ title, detail, code, requestId }`, plus `fields` when the body has them.
 */
export function parseError(
  body: unknown,
  fallbackStatus: number,
  fallbackReqId: string,
): SubmitError {
  const env = body as ApiErrorEnvelope;
  return {
    title: env?.error?.title ?? 'Submission failed',
    detail: env?.error?.detail ?? `The server returned HTTP ${fallbackStatus}.`,
    code: env?.error?.code ?? 'UNKNOWN',
    requestId: env?.error?.requestId ?? fallbackReqId,
    ...(env?.error?.fields ? { fields: env.error.fields } : {}),
  };
}

/**
 * Returns a copy of an RJSF schema without `title` and `description`.
 *
 * The page renders its own heading, and the schema description is not form copy.
 *
 * @param schema - The loaded JSON Schema.
 * @returns A shallow clone without `title`/`description`.
 */
export function stripFormChrome(schema: RJSFSchema): RJSFSchema {
  const clone: RJSFSchema = { ...schema };
  delete (clone as { title?: string }).title;
  delete (clone as { description?: string }).description;
  return clone;
}

/** A failed submission, ready to display. `fields` is the API's `error.fields`, when present. */
export interface SubmitError {
  title: string;
  detail: string;
  code: string;
  requestId: string;
  fields?: Record<string, unknown>;
}

/** Result of {@link submitRegistration}: parsed success body or display error. */
export type SubmitResult =
  { ok: true; body: Record<string, unknown> } | { ok: false; error: SubmitError };

/**
 * POSTs a registration payload to a BFF endpoint and normalises the outcome.
 *
 * @param endpoint - BFF route, e.g. `/api/aggregator/register`.
 * @param payload - JSON body to send.
 * @returns A discriminated success/error result (never throws).
 */
export async function submitRegistration(
  endpoint: string,
  payload: unknown,
): Promise<SubmitResult> {
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const reqId = res.headers.get('x-request-id') ?? '';
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, error: parseError(body, res.status, reqId) };
    }
    return { ok: true, body: (await res.json()) as Record<string, unknown> };
  } catch (err) {
    return {
      ok: false,
      error: {
        title: 'Network error',
        detail: err instanceof Error ? err.message : 'Could not reach the server.',
        code: 'NETWORK_ERROR',
        requestId: '',
      },
    };
  }
}

/**
 * Builds a consent object with `given_at` now and `valid_till` one year out,
 * merged over any existing consent fields on the form data.
 *
 * @param existing - The current `consent` sub-object from form data.
 * @returns Consent object with fresh timestamps stamped at call time.
 */
export function stampConsent(
  existing: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const now = new Date();
  const oneYear = new Date(now);
  oneYear.setFullYear(oneYear.getFullYear() + 1);
  return {
    ...(existing ?? {}),
    given_at: now.toISOString(),
    valid_till: oneYear.toISOString(),
  };
}

/**
 * Returns a copy of an RJSF schema with the `consent` block removed.
 *
 * Consent is collected by {@link ConsentGate} after the form is valid, so the
 * form must not render or require it. The API still requires `consent`; the
 * gate adds it at submit time.
 *
 * @param schema - The loaded JSON Schema.
 * @returns A copy without the consent property or its `required` entry.
 */
export function stripConsentBlock(schema: RJSFSchema): RJSFSchema {
  const properties = { ...((schema.properties ?? {}) as Record<string, unknown>) };
  if (!('consent' in properties)) return schema;
  delete properties['consent'];
  const clone: RJSFSchema = { ...schema, properties: properties as RJSFSchema['properties'] };
  if (Array.isArray(schema.required)) {
    clone.required = schema.required.filter((k) => k !== 'consent');
  }
  return clone;
}

/** Coordinate part of a resolved place. The widget's `ResolvedPlace` satisfies it. */
export interface ResolvedCoordinate {
  lat: number;
  lng: number;
}

/**
 * Attaches the resolved coordinate to an organisation submit body.
 *
 * The org body has no location array, so `coordinates` sits at the top level.
 * Kept as a function so tests can check the `[longitude, latitude]` order.
 *
 * @param payload - The submit body.
 * @param place - The coordinate the widget resolved, or null if none.
 * @returns A copy carrying `coordinates`, or the original when none resolved.
 */
export function withOrgCoordinates(
  payload: Record<string, unknown>,
  place: ResolvedCoordinate | null,
): Record<string, unknown> {
  if (!place) return payload;
  return {
    ...payload,
    // GeoJSON order is [longitude, latitude].
    coordinates: [place.lng, place.lat],
  };
}

/**
 * Stitches a resolved coordinate into the coordinator payload's first location.
 *
 * The address widget reports its coordinate outside `formData`, so it is merged
 * in at submit. When the user did not pick a suggestion, the payload is
 * returned unchanged and keeps its `[0,0]` placeholder (`geo` is required).
 *
 * @param payload - The submit body, carrying the form's `locations` array.
 * @param place - The coordinate the widget resolved, or null if none.
 * @returns A copy with `locations[0].geo.coordinates` set, or the original.
 */
export function withResolvedCoordinates(
  payload: Record<string, unknown>,
  place: ResolvedCoordinate | null,
): Record<string, unknown> {
  if (!place) return payload;
  const locations = payload['locations'];
  if (!Array.isArray(locations) || locations.length === 0) return payload;
  const [first, ...rest] = locations as Record<string, unknown>[];
  return {
    ...payload,
    locations: [
      {
        ...first,
        // GeoJSON order is [longitude, latitude].
        geo: { type: 'Point', coordinates: [place.lng, place.lat] },
      },
      ...rest,
    ],
  };
}
