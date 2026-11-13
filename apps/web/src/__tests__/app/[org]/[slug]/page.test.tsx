/**
 * Server-component test: `[org]/[slug]/page.tsx` — public registration link
 * resolver.
 *
 * Invokes the async page function directly. Covers: link resolve success,
 * 404 on an unknown link, non-ok upstream response, network failure, an
 * account_only link (schema stays null, no UI-schema disk read), a malformed
 * schema for a profile link, an invalid domain id, and the UI-schema-missing
 * graceful degrade.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { notFound } = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));
const { readFile } = vi.hoisted(() => ({ readFile: vi.fn() }));
const { resolveSchemaRoot } = vi.hoisted(() => ({
  resolveSchemaRoot: vi.fn(() => '/config/schemas'),
}));
const { loadParticipantConsent } = vi.hoisted(() => ({ loadParticipantConsent: vi.fn() }));

vi.mock('next/navigation', () => ({ notFound }));
vi.mock('node:fs/promises', () => ({ readFile, default: { readFile } }));
vi.mock('@/lib/config-paths', () => ({ resolveSchemaRoot }));
vi.mock('@/lib/participant-consent.server', () => ({ loadParticipantConsent }));

import PublicRegistrationPage from '@/app/[org]/[slug]/page';

const baseResolved = {
  slug: 'winter25',
  network: 'blue_dot',
  domain: 'seeker',
  context: { title: 'Winter Drive' },
  schema_id: 'seeker_1.0',
  schema_version: '1.0',
  schema: { type: 'object', properties: { name: { type: 'string' } } },
  identity: { name: 'name', phone: 'phone', email: 'email' },
  expires_at: null,
};

describe('PublicRegistrationPage (server component)', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    notFound.mockClear();
    readFile.mockReset().mockRejectedValue(new Error('ENOENT'));
    loadParticipantConsent.mockReset().mockResolvedValue(null);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('renders PublicRegistrationView with the resolved link data on success', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(baseResolved), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;

    const el = await PublicRegistrationPage({
      params: Promise.resolve({ org: 'acme', slug: 'winter25' }),
    });

    expect(el.props.org).toBe('acme');
    expect(el.props.slug).toBe('winter25');
    expect(el.props.domain).toBe('seeker');
    expect(el.props.submissionShape).toBe('account_and_profile');
    expect(el.props.schema).toEqual(baseResolved.schema);
  });

  it('calls notFound() on a 404 resolve response', async () => {
    // notFound() signals Next by throwing, so it must propagate rather than be
    // caught and rendered as a page. The try now wraps only the fetch, so the
    // mock's throw escapes exactly as the real control-flow error would and the
    // route answers 404 instead of 200.
    globalThis.fetch = vi.fn(
      async () => new Response('not found', { status: 404 }),
    ) as unknown as typeof fetch;

    await expect(
      PublicRegistrationPage({
        params: Promise.resolve({ org: 'acme', slug: 'nope' }),
      }),
    ).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFound).toHaveBeenCalled();
  });

  it('renders an ErrorShell when the resolve response body is malformed', async () => {
    // 200 with a body that is not JSON. Parsing is guarded separately from the
    // fetch so a bad payload still shows the service page instead of throwing
    // past the route.
    globalThis.fetch = vi.fn(
      async () => new Response('<html>not json</html>', { status: 200 }),
    ) as unknown as typeof fetch;

    const el = await PublicRegistrationPage({
      params: Promise.resolve({ org: 'acme', slug: 'winter25' }),
    });
    expect(el.props.title).toBe('Cannot reach registration service');
    expect(notFound).not.toHaveBeenCalled();
  });

  it('renders an ErrorShell for a non-ok, non-404 upstream response', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('server error', { status: 500 }),
    ) as unknown as typeof fetch;

    const el = await PublicRegistrationPage({
      params: Promise.resolve({ org: 'acme', slug: 'winter25' }),
    });
    expect(el.props.title).toBe('Link unavailable');
    expect(el.props.message).toContain('500');
  });

  it('renders an ErrorShell when the fetch throws (network failure)', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('DNS failure');
    }) as unknown as typeof fetch;

    const el = await PublicRegistrationPage({
      params: Promise.resolve({ org: 'acme', slug: 'winter25' }),
    });
    expect(el.props.title).toBe('Cannot reach registration service');
    expect(el.props.message).toBe('DNS failure');
  });

  it('renders an ErrorShell when the schema is missing for a non-account_only link', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ ...baseResolved, schema: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;

    const el = await PublicRegistrationPage({
      params: Promise.resolve({ org: 'acme', slug: 'winter25' }),
    });
    expect(el.props.title).toBe('Form unavailable');
  });

  it('renders an account_only link without requiring a schema or UI-schema read', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ ...baseResolved, schema: null, submission_shape: 'account_only' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    ) as unknown as typeof fetch;

    const el = await PublicRegistrationPage({
      params: Promise.resolve({ org: 'acme', slug: 'winter25' }),
    });
    expect(el.props.submissionShape).toBe('account_only');
    expect(readFile).not.toHaveBeenCalled();
  });

  it('calls notFound() for a domain id with invalid characters', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ ...baseResolved, domain: 'bad domain!' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;

    let caught: unknown;
    try {
      await PublicRegistrationPage({
        params: Promise.resolve({ org: 'acme', slug: 'winter25' }),
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('NEXT_NOT_FOUND');
    expect(notFound).toHaveBeenCalled();
  });

  it('degrades gracefully to an empty UI schema when the ui.json file is missing', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(baseResolved), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;
    readFile.mockRejectedValue(new Error('ENOENT'));

    const el = await PublicRegistrationPage({
      params: Promise.resolve({ org: 'acme', slug: 'winter25' }),
    });
    expect(el.props.uiSchema).toEqual({});
  });

  it('parses the UI schema file when present', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(baseResolved), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;
    readFile.mockResolvedValue(JSON.stringify({ name: { 'ui:autofocus': true } }));

    const el = await PublicRegistrationPage({
      params: Promise.resolve({ org: 'acme', slug: 'winter25' }),
    });
    expect(el.props.uiSchema).toEqual({ name: { 'ui:autofocus': true } });
  });

  it('forwards the participant consent content into the view', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(baseResolved), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;
    loadParticipantConsent.mockResolvedValue({
      terms: { version: 1, title: 'T', content: 'c' },
      privacy: { version: 1, title: 'P', content: 'c' },
    });

    const el = await PublicRegistrationPage({
      params: Promise.resolve({ org: 'acme', slug: 'winter25' }),
    });
    expect(el.props.consentContent).toEqual({
      terms: { version: 1, title: 'T', content: 'c' },
      privacy: { version: 1, title: 'P', content: 'c' },
    });
  });
});
