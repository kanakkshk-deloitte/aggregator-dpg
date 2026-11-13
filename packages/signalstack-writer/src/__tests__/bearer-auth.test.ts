/**
 * Unit tests for HttpSignalStackWriter's Phase C bearer-credential path —
 * the `tokenProvider` alternative to the legacy static `apiKey`.
 *
 * @module @aggregator-dpg/signalstack-writer
 */

import { describe, it, expect, vi } from 'vitest';
import { HttpSignalStackWriter } from '../http.js';
import { SignalStackTokenProviderFake } from '../testing.js';
import { buildOnboardInput } from '../testing.js';

function okJsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const ONBOARD_RESPONSE = {
  user_id: 'user-abc',
  onboarded_at: '2026-01-01T00:00:00Z',
  items: [
    {
      item_id: 'item-xyz',
      item_network: 'blue_dot',
      item_domain: 'seeker',
      item_type: 'profile_1.0',
    },
  ],
};

describe('HttpSignalStackWriter bearer credential', () => {
  it('rejects construction with neither apiKey nor tokenProvider', () => {
    expect(() => new HttpSignalStackWriter({ baseUrl: 'http://signalstack.test' })).toThrow();
  });

  it('rejects construction with both apiKey and tokenProvider', () => {
    expect(
      () =>
        new HttpSignalStackWriter({
          baseUrl: 'http://signalstack.test',
          apiKey: 'key',
          tokenProvider: new SignalStackTokenProviderFake(),
        }),
    ).toThrow();
  });

  it('sends Authorization: Bearer <token> instead of x-api-key when a tokenProvider is configured', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(okJsonResponse(ONBOARD_RESPONSE));
    const tokenProvider = new SignalStackTokenProviderFake('tok-abc');
    const writer = new HttpSignalStackWriter({
      baseUrl: 'http://signalstack.test',
      tokenProvider,
      fetchImpl: fetchMock as unknown as typeof fetch,
      maxRetries: 0,
    });

    const result = await writer.onboard(buildOnboardInput());

    expect(result.success).toBe(true);
    expect(tokenProvider.callCount).toBe(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer tok-abc');
    expect(headers['x-api-key']).toBeUndefined();
  });

  it('propagates a token-provider failure without calling fetch', async () => {
    const fetchMock = vi.fn();
    const tokenProvider = new SignalStackTokenProviderFake();
    tokenProvider.failNext();
    const writer = new HttpSignalStackWriter({
      baseUrl: 'http://signalstack.test',
      tokenProvider,
      fetchImpl: fetchMock as unknown as typeof fetch,
      maxRetries: 0,
    });

    const result = await writer.onboard(buildOnboardInput());

    expect(result.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reuses the same token across retry attempts on a transient 5xx (no re-fetch of the token)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => 'IDENTITY_PROVIDER_UNAVAILABLE',
      } as unknown as Response)
      .mockResolvedValueOnce(okJsonResponse(ONBOARD_RESPONSE));
    const tokenProvider = new SignalStackTokenProviderFake('tok-stable');
    const writer = new HttpSignalStackWriter({
      baseUrl: 'http://signalstack.test',
      tokenProvider,
      fetchImpl: fetchMock as unknown as typeof fetch,
      maxRetries: 1,
      retryBaseMs: 0,
    });

    const result = await writer.onboard(buildOnboardInput());

    expect(result.success).toBe(true);
    // buildHeaders() (and therefore getToken()) runs once per public-method
    // call, before entering requestWithRetry's loop — so both HTTP attempts
    // reuse the one token fetched up front.
    expect(tokenProvider.callCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, secondInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect((secondInit.headers as Record<string, string>).authorization).toBe('Bearer tok-stable');
  });

  it('re-mints once and retries with the fresh token on a 401 (key rotation)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'invalid_token',
      } as unknown as Response)
      .mockResolvedValueOnce(okJsonResponse(ONBOARD_RESPONSE));
    const tokenProvider = new SignalStackTokenProviderFake('tok-stale');
    // The fake holds no cache, so model the rotation by swapping the token
    // when the writer asks for a re-mint.
    const realInvalidate = tokenProvider.invalidate.bind(tokenProvider);
    tokenProvider.invalidate = () => {
      realInvalidate();
      tokenProvider.setToken('tok-fresh');
    };
    const writer = new HttpSignalStackWriter({
      baseUrl: 'http://signalstack.test',
      tokenProvider,
      // maxRetries: 0 proves the re-mint attempt is OUTSIDE the retry budget.
      fetchImpl: fetchMock as unknown as typeof fetch,
      maxRetries: 0,
    });

    const result = await writer.onboard(buildOnboardInput());

    expect(result.success).toBe(true);
    expect(tokenProvider.invalidateCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, firstInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const [, secondInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect((firstInit.headers as Record<string, string>).authorization).toBe('Bearer tok-stale');
    expect((secondInit.headers as Record<string, string>).authorization).toBe('Bearer tok-fresh');
  });

  it('re-mints at most once — a persistent 401 fails fast instead of looping', async () => {
    const unauthorised = {
      ok: false,
      status: 401,
      text: async () => 'invalid_token',
    } as unknown as Response;
    const fetchMock = vi.fn().mockResolvedValue(unauthorised);
    const tokenProvider = new SignalStackTokenProviderFake('tok-bad');
    const writer = new HttpSignalStackWriter({
      baseUrl: 'http://signalstack.test',
      tokenProvider,
      fetchImpl: fetchMock as unknown as typeof fetch,
      maxRetries: 0,
    });

    const result = await writer.onboard(buildOnboardInput());

    expect(result.success).toBe(false);
    expect(tokenProvider.invalidateCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns the original 401 when the re-mint itself fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'invalid_token',
    } as unknown as Response);
    const tokenProvider = new SignalStackTokenProviderFake('tok-stale');
    const realInvalidate = tokenProvider.invalidate.bind(tokenProvider);
    tokenProvider.invalidate = () => {
      realInvalidate();
      tokenProvider.failNext();
    };
    const writer = new HttpSignalStackWriter({
      baseUrl: 'http://signalstack.test',
      tokenProvider,
      fetchImpl: fetchMock as unknown as typeof fetch,
      maxRetries: 0,
    });

    const result = await writer.onboard(buildOnboardInput());

    expect(result.success).toBe(false);
    if (result.success) return;
    // Mapped from the 401 response, not from the token-grant failure.
    expect(result.error.code).toBe('SIGNALSTACK_FORBIDDEN');
    // No second HTTP attempt: the fresh token was never obtained.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not attempt a re-mint on the x-api-key path', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'invalid_token',
    } as unknown as Response);
    const writer = new HttpSignalStackWriter({
      baseUrl: 'http://signalstack.test',
      apiKey: 'legacy-key',
      fetchImpl: fetchMock as unknown as typeof fetch,
      maxRetries: 0,
    });

    const result = await writer.onboard(buildOnboardInput());

    expect(result.success).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still sends x-api-key (not Authorization) when configured with apiKey', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(okJsonResponse(ONBOARD_RESPONSE));
    const writer = new HttpSignalStackWriter({
      baseUrl: 'http://signalstack.test',
      apiKey: 'legacy-key',
      fetchImpl: fetchMock as unknown as typeof fetch,
      maxRetries: 0,
    });

    await writer.onboard(buildOnboardInput());

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('legacy-key');
    expect(headers.authorization).toBeUndefined();
  });
});
