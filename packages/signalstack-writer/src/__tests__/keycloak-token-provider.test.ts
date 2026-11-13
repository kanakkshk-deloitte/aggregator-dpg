/**
 * Unit tests for KeycloakClientCredentialsTokenProvider.
 *
 * Every test stubs the `fetchImpl` constructor parameter so no real network
 * call is made.
 *
 * @module @aggregator-dpg/signalstack-writer
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KeycloakClientCredentialsTokenProvider } from '../keycloak-token-provider.js';

function okTokenResponse(accessToken: string, expiresIn: number): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ access_token: accessToken, expires_in: expiresIn }),
    text: async () => JSON.stringify({ access_token: accessToken, expires_in: expiresIn }),
  } as unknown as Response;
}

function errResponse(status: number, body: string): Response {
  return {
    ok: false,
    status,
    text: async () => body,
  } as unknown as Response;
}

describe('KeycloakClientCredentialsTokenProvider', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let provider: KeycloakClientCredentialsTokenProvider;

  beforeEach(() => {
    fetchMock = vi.fn();
    provider = new KeycloakClientCredentialsTokenProvider({
      baseUrl: 'http://keycloak.test',
      realm: 'bluedots',
      clientId: 'aggregator-dpg',
      clientSecret: 'shh',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
  });

  it('requires baseUrl, realm, clientId, and clientSecret', () => {
    const base = {
      baseUrl: 'http://keycloak.test',
      realm: 'bluedots',
      clientId: 'aggregator-dpg',
      clientSecret: 'shh',
    };
    expect(() => new KeycloakClientCredentialsTokenProvider({ ...base, baseUrl: '' })).toThrow();
    expect(() => new KeycloakClientCredentialsTokenProvider({ ...base, realm: '' })).toThrow();
    expect(() => new KeycloakClientCredentialsTokenProvider({ ...base, clientId: '' })).toThrow();
    expect(
      () => new KeycloakClientCredentialsTokenProvider({ ...base, clientSecret: '' }),
    ).toThrow();
  });

  it('posts a client_credentials grant to the realm token endpoint', async () => {
    fetchMock.mockResolvedValueOnce(okTokenResponse('tok-1', 300));

    const result = await provider.getToken();

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value).toBe('tok-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://keycloak.test/realms/bluedots/protocol/openid-connect/token');
    expect(init.method).toBe('POST');
    const body = init.body as string;
    expect(body).toContain('grant_type=client_credentials');
    expect(body).toContain('client_id=aggregator-dpg');
    expect(body).toContain('client_secret=shh');
  });

  it('caches the token and does not re-fetch until near expiry', async () => {
    fetchMock.mockResolvedValueOnce(okTokenResponse('tok-1', 300));

    const first = await provider.getToken();
    const second = await provider.getToken();

    expect(first.success && first.value).toBe('tok-1');
    expect(second.success && second.value).toBe('tok-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('re-fetches after _resetCache', async () => {
    fetchMock.mockResolvedValueOnce(okTokenResponse('tok-1', 300));
    fetchMock.mockResolvedValueOnce(okTokenResponse('tok-2', 300));

    const first = await provider.getToken();
    provider._resetCache();
    const second = await provider.getToken();

    expect(first.success && first.value).toBe('tok-1');
    expect(second.success && second.value).toBe('tok-2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('maps a 5xx grant failure to IDENTITY_PROVIDER_UNAVAILABLE (Keycloak unreachable, not a bad credential)', async () => {
    fetchMock.mockResolvedValueOnce(errResponse(503, 'upstream down'));

    const result = await provider.getToken();

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('IDENTITY_PROVIDER_UNAVAILABLE');
  });

  it('maps a 4xx grant failure to SIGNALSTACK_AUTH_FAILED (bad client id/secret)', async () => {
    fetchMock.mockResolvedValueOnce(errResponse(401, 'invalid_client'));

    const result = await provider.getToken();

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_AUTH_FAILED');
  });

  it('maps a malformed 2xx body to SIGNALSTACK_BAD_RESPONSE', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ nope: true }),
      text: async () => '{"nope":true}',
    } as unknown as Response);

    const result = await provider.getToken();

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_BAD_RESPONSE');
  });

  it('maps a thrown transport error to SIGNALSTACK_TRANSPORT_FAILED', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const result = await provider.getToken();

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_TRANSPORT_FAILED');
  });

  /**
   * The reason object the platform itself produces when `AbortSignal.timeout()`
   * fires — a `DOMException` named `TimeoutError` with no `cause`, NOT an
   * `AbortError`. Taken from a real signal rather than hand-rolled so the test
   * cannot drift from Node's actual behaviour.
   */
  async function realTimeoutReason(): Promise<unknown> {
    const signal = AbortSignal.timeout(1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(signal.aborted).toBe(true);
    return signal.reason;
  }

  it("maps the reason AbortSignal.timeout() actually throws ('TimeoutError') to SIGNALSTACK_TIMEOUT", async () => {
    const reason = await realTimeoutReason();
    // Guard the premise: if Node ever renames this, the classifier must follow.
    expect((reason as Error).name).toBe('TimeoutError');
    fetchMock.mockRejectedValueOnce(reason);

    const result = await provider.getToken();

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_TIMEOUT');
    expect(result.error.message).toContain('timed out');
  });

  it('maps a manual AbortController abort to SIGNALSTACK_TIMEOUT', async () => {
    // The shape http.ts's own per-attempt AbortController produces.
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';
    fetchMock.mockRejectedValueOnce(abortError);

    const result = await provider.getToken();

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_TIMEOUT');
  });

  it('maps a timeout nested under `cause` to SIGNALSTACK_TIMEOUT', async () => {
    // undici wraps the abort reason on some paths.
    const wrapped = Object.assign(new TypeError('fetch failed'), {
      cause: await realTimeoutReason(),
    });
    fetchMock.mockRejectedValueOnce(wrapped);

    const result = await provider.getToken();

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_TIMEOUT');
  });

  it('mints only once for concurrent cold-cache callers (single flight)', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fetchMock.mockImplementation(async () => {
      await gate;
      return okTokenResponse('shared-token', 300);
    });

    const inFlight = [provider.getToken(), provider.getToken(), provider.getToken()];
    release();
    const results = await Promise.all(inFlight);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const r of results) {
      expect(r.success).toBe(true);
      if (r.success) expect(r.value).toBe('shared-token');
    }
  });

  it('does not cache a failed single-flight mint — the next call retries', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const first = await provider.getToken();
    expect(first.success).toBe(false);

    fetchMock.mockResolvedValueOnce(okTokenResponse('recovered', 300));
    const second = await provider.getToken();

    expect(second.success).toBe(true);
    if (second.success) expect(second.value).toBe('recovered');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('invalidate() forces a fresh mint even inside the cached window', async () => {
    fetchMock.mockResolvedValueOnce(okTokenResponse('first', 300));
    expect(await provider.getToken()).toMatchObject({ success: true, value: 'first' });
    // Still well inside expiry: without invalidate() this would be cached.
    expect(await provider.getToken()).toMatchObject({ success: true, value: 'first' });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    provider.invalidate();
    fetchMock.mockResolvedValueOnce(okTokenResponse('rotated', 300));

    expect(await provider.getToken()).toMatchObject({ success: true, value: 'rotated' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
