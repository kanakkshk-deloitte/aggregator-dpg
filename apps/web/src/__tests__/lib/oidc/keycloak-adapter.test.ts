import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `KeycloakAdapter` wraps `openid-client`. We fake the library's surface
 * (`Issuer.discover`, the constructed `Client`, and PKCE `generators`) so
 * these tests exercise the adapter's own logic — state/claims mapping,
 * error normalisation, refresh-token expiry decoding, discovery caching —
 * without any real network/Keycloak dependency.
 */

const {
  mockAuthorizationUrl,
  mockCallback,
  mockRefresh,
  mockEndSessionUrl,
  mockDiscover,
  mockClientCtor,
  generatorsMock,
} = vi.hoisted(() => ({
  mockAuthorizationUrl: vi.fn(),
  mockCallback: vi.fn(),
  mockRefresh: vi.fn(),
  mockEndSessionUrl: vi.fn(),
  mockDiscover: vi.fn(),
  mockClientCtor: vi.fn(),
  generatorsMock: {
    state: vi.fn(() => 'gen-state'),
    nonce: vi.fn(() => 'gen-nonce'),
    codeVerifier: vi.fn(() => 'gen-verifier'),
    codeChallenge: vi.fn(() => 'gen-challenge'),
  },
}));

vi.mock('openid-client', () => {
  const httpOptionsSymbol = Symbol('http_options');
  class MockClient {
    issuer = { metadata: { issuer: 'http://kc.fake/realms/aggregator' } };
    [key: symbol]: unknown;
    constructor(metadata: unknown) {
      mockClientCtor(metadata);
    }
    authorizationUrl(...args: unknown[]) {
      return mockAuthorizationUrl(...args);
    }
    callback(...args: unknown[]) {
      return mockCallback(...args);
    }
    refresh(...args: unknown[]) {
      return mockRefresh(...args);
    }
    endSessionUrl(...args: unknown[]) {
      return mockEndSessionUrl(...args);
    }
  }

  const Issuer = vi.fn() as unknown as { discover: typeof mockDiscover } & Record<symbol, unknown>;
  Issuer.discover = mockDiscover;

  return {
    Issuer,
    generators: generatorsMock,
    custom: {
      http_options: httpOptionsSymbol,
      setHttpOptionsDefaults: vi.fn(),
    },
    __MockClient: MockClient,
  };
});

// `vi.mock` above is hoisted, so this static import already resolves to the
// mocked module — it gives us a handle on `__MockClient` for `Issuer.discover`.
import * as openidClientMock from 'openid-client';

function mockClientClass(): unknown {
  return (openidClientMock as unknown as { __MockClient: unknown }).__MockClient;
}

async function importAdapter() {
  mockDiscover.mockResolvedValue({ Client: mockClientClass() });
  const { KeycloakAdapter, oidcGenerators } = await import('@/lib/oidc/keycloak');
  return { KeycloakAdapter, oidcGenerators };
}

describe('KeycloakAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDiscover.mockReset();
  });

  it('discovers the issuer with a public-client config when no secret is set', async () => {
    const { KeycloakAdapter } = await importAdapter();
    const adapter = new KeycloakAdapter({
      issuerUrl: 'http://kc.fake/realms/aggregator',
      clientId: 'aggregator-portal',
    });
    await adapter.buildAuthorizationUrl({
      state: 's',
      nonce: 'n',
      codeChallenge: 'cc',
      redirectUri: 'http://app/cb',
    });
    expect(mockDiscover).toHaveBeenCalledWith('http://kc.fake/realms/aggregator');
    expect(mockClientCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        client_id: 'aggregator-portal',
        token_endpoint_auth_method: 'none',
        response_types: ['code'],
      }),
    );
  });

  it('passes a client secret through when configured', async () => {
    const { KeycloakAdapter } = await importAdapter();
    const adapter = new KeycloakAdapter({
      issuerUrl: 'http://kc.fake/realms/aggregator',
      clientId: 'aggregator-bff',
      clientSecret: 'shh',
    });
    await adapter.buildAuthorizationUrl({
      state: 's',
      nonce: 'n',
      codeChallenge: 'cc',
      redirectUri: 'http://app/cb',
    });
    expect(mockClientCtor).toHaveBeenCalledWith(
      expect.objectContaining({ client_id: 'aggregator-bff', client_secret: 'shh' }),
    );
  });

  it('caches the discovered client across concurrent calls (single discover)', async () => {
    const { KeycloakAdapter } = await importAdapter();
    mockAuthorizationUrl.mockReturnValue('http://kc.fake/authorize?x=1');
    const adapter = new KeycloakAdapter({
      issuerUrl: 'http://kc.fake/realms/aggregator',
      clientId: 'aggregator-portal',
    });
    await Promise.all([
      adapter.buildAuthorizationUrl({
        state: 's1',
        nonce: 'n1',
        codeChallenge: 'cc1',
        redirectUri: 'http://app/cb',
      }),
      adapter.buildAuthorizationUrl({
        state: 's2',
        nonce: 'n2',
        codeChallenge: 'cc2',
        redirectUri: 'http://app/cb',
      }),
    ]);
    expect(mockDiscover).toHaveBeenCalledTimes(1);
  });

  it('evicts the cached client promise on discovery failure so the next call retries', async () => {
    const { KeycloakAdapter } = await importAdapter();
    mockDiscover.mockReset();
    mockDiscover.mockRejectedValueOnce(new Error('kc down'));
    const adapter = new KeycloakAdapter({
      issuerUrl: 'http://kc.fake/realms/aggregator',
      clientId: 'aggregator-portal',
    });
    await expect(
      adapter.buildAuthorizationUrl({
        state: 's',
        nonce: 'n',
        codeChallenge: 'cc',
        redirectUri: 'http://app/cb',
      }),
    ).rejects.toMatchObject({ message: 'kc down' });

    mockDiscover.mockResolvedValueOnce({ Client: mockClientClass() });
    mockAuthorizationUrl.mockReturnValue('http://kc.fake/authorize?ok=1');
    const url = await adapter.buildAuthorizationUrl({
      state: 's',
      nonce: 'n',
      codeChallenge: 'cc',
      redirectUri: 'http://app/cb',
    });
    expect(url).toBe('http://kc.fake/authorize?ok=1');
    expect(mockDiscover).toHaveBeenCalledTimes(2);
  });

  it('builds the authorization URL with scope/state/nonce/PKCE params', async () => {
    const { KeycloakAdapter } = await importAdapter();
    mockAuthorizationUrl.mockReturnValue('http://kc.fake/authorize?x=1');
    const adapter = new KeycloakAdapter({
      issuerUrl: 'http://kc.fake/realms/aggregator',
      clientId: 'aggregator-portal',
    });
    const url = await adapter.buildAuthorizationUrl({
      state: 'st',
      nonce: 'no',
      codeChallenge: 'cc',
      redirectUri: 'http://app/cb',
    });
    expect(url).toBe('http://kc.fake/authorize?x=1');
    expect(mockAuthorizationUrl).toHaveBeenCalledWith({
      scope: 'openid profile email',
      state: 'st',
      nonce: 'no',
      code_challenge: 'cc',
      code_challenge_method: 'S256',
      redirect_uri: 'http://app/cb',
    });
  });

  it('honours a custom default scope and an explicit per-call scope override', async () => {
    const { KeycloakAdapter } = await importAdapter();
    mockAuthorizationUrl.mockReturnValue('http://kc.fake/authorize');
    const adapter = new KeycloakAdapter({
      issuerUrl: 'http://kc.fake/realms/aggregator',
      clientId: 'aggregator-portal',
      defaultScope: 'openid custom',
    });
    await adapter.buildAuthorizationUrl({
      state: 's',
      nonce: 'n',
      codeChallenge: 'cc',
      redirectUri: 'http://app/cb',
    });
    expect(mockAuthorizationUrl).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'openid custom' }),
    );

    await adapter.buildAuthorizationUrl({
      state: 's',
      nonce: 'n',
      codeChallenge: 'cc',
      redirectUri: 'http://app/cb',
      scope: 'openid override',
    });
    expect(mockAuthorizationUrl).toHaveBeenLastCalledWith(
      expect.objectContaining({ scope: 'openid override' }),
    );
  });

  it('rejects exchangeCode when state does not match, without touching the client', async () => {
    const { KeycloakAdapter } = await importAdapter();
    const adapter = new KeycloakAdapter({
      issuerUrl: 'http://kc.fake/realms/aggregator',
      clientId: 'aggregator-portal',
    });
    const result = await adapter.exchangeCode({
      code: 'c',
      codeVerifier: 'v',
      redirectUri: 'http://app/cb',
      state: 'a',
      expectedState: 'b',
      expectedNonce: 'n',
    });
    expect(result).toEqual({
      ok: false,
      error: { code: 'STATE_MISMATCH', message: 'state parameter does not match' },
    });
    expect(mockDiscover).not.toHaveBeenCalled();
  });

  it('exchanges a code for tokens and maps full claims', async () => {
    const { KeycloakAdapter } = await importAdapter();
    const refreshToken = fakeJwt({ exp: 1_700_000_000 });
    mockCallback.mockResolvedValue({
      access_token: 'AT',
      refresh_token: refreshToken,
      id_token: 'IDT',
      expires_at: 1_700_000_500,
      scope: 'openid profile',
      claims: () => ({
        sub: 'user-1',
        email: 'user@example.com',
        email_verified: true,
        phone_number: '+919876543210',
        phone_number_verified: false,
        name: 'Test User',
        preferred_username: 'tuser',
      }),
    });
    const adapter = new KeycloakAdapter({
      issuerUrl: 'http://kc.fake/realms/aggregator',
      clientId: 'aggregator-portal',
    });
    const result = await adapter.exchangeCode({
      code: 'auth-code',
      codeVerifier: 'verifier',
      redirectUri: 'http://app/cb',
      state: 's',
      expectedState: 's',
      expectedNonce: 'n',
      callbackParams: { iss: 'http://kc.fake/realms/aggregator', session_state: 'ss-1' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.tokens).toEqual({
      accessToken: 'AT',
      refreshToken,
      idToken: 'IDT',
      accessTokenExp: 1_700_000_500_000,
      refreshTokenExp: 1_700_000_000_000,
      scope: 'openid profile',
    });
    expect(result.value.claims).toEqual({
      sub: 'user-1',
      email: 'user@example.com',
      emailVerified: true,
      phoneNumber: '+919876543210',
      phoneNumberVerified: false,
      name: 'Test User',
      preferredUsername: 'tuser',
    });
    expect(mockCallback).toHaveBeenCalledWith(
      'http://app/cb',
      {
        iss: 'http://kc.fake/realms/aggregator',
        session_state: 'ss-1',
        code: 'auth-code',
        state: 's',
      },
      { code_verifier: 'verifier', state: 's', nonce: 'n' },
    );
  });

  it('maps a minimal claim set and falls back accessTokenExp when expires_at is absent', async () => {
    const { KeycloakAdapter } = await importAdapter();
    const before = Date.now();
    mockCallback.mockResolvedValue({
      access_token: 'AT',
      refresh_token: 'not-a-jwt',
      id_token: 'IDT',
      claims: () => ({ sub: 'user-2' }),
    });
    const adapter = new KeycloakAdapter({
      issuerUrl: 'http://kc.fake/realms/aggregator',
      clientId: 'aggregator-portal',
    });
    const result = await adapter.exchangeCode({
      code: 'c',
      codeVerifier: 'v',
      redirectUri: 'http://app/cb',
      state: 's',
      expectedState: 's',
      expectedNonce: 'n',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.claims).toEqual({ sub: 'user-2' });
    expect(result.value.tokens.scope).toBeUndefined();
    expect(result.value.tokens.accessTokenExp).toBeGreaterThanOrEqual(before + 5 * 60_000 - 1000);
    // malformed (non-3-part) refresh token falls back to a ~30 min expiry
    expect(result.value.tokens.refreshTokenExp).toBeGreaterThanOrEqual(before + 30 * 60_000 - 1000);
  });

  it('returns TOKEN_EXCHANGE_FAILED when the token set is missing a required field', async () => {
    const { KeycloakAdapter } = await importAdapter();
    mockCallback.mockResolvedValue({
      access_token: '',
      refresh_token: 'rt',
      id_token: 'idt',
      claims: () => ({ sub: 'x' }),
    });
    const adapter = new KeycloakAdapter({
      issuerUrl: 'http://kc.fake/realms/aggregator',
      clientId: 'aggregator-portal',
    });
    const result = await adapter.exchangeCode({
      code: 'c',
      codeVerifier: 'v',
      redirectUri: 'http://app/cb',
      state: 's',
      expectedState: 's',
      expectedNonce: 'n',
    });
    expect(result).toEqual({
      ok: false,
      error: { code: 'TOKEN_EXCHANGE_FAILED', message: 'incomplete token set from issuer' },
    });
  });

  it('normalises an openid-client OPError into a TOKEN_EXCHANGE_FAILED result', async () => {
    const { KeycloakAdapter } = await importAdapter();
    mockCallback.mockRejectedValue(
      Object.assign(new Error('callback rejected'), {
        name: 'OPError',
        error: 'invalid_grant',
        error_description: 'code expired',
        response: { statusCode: 400 },
      }),
    );
    const adapter = new KeycloakAdapter({
      issuerUrl: 'http://kc.fake/realms/aggregator',
      clientId: 'aggregator-portal',
    });
    const result = await adapter.exchangeCode({
      code: 'c',
      codeVerifier: 'v',
      redirectUri: 'http://app/cb',
      state: 's',
      expectedState: 's',
      expectedNonce: 'n',
    });
    expect(result).toEqual({
      ok: false,
      error: { code: 'TOKEN_EXCHANGE_FAILED', message: 'invalid_grant: code expired' },
    });
  });

  it('falls back to the raw error message when the OPError has no OAuth2 error fields', async () => {
    const { KeycloakAdapter } = await importAdapter();
    mockCallback.mockRejectedValue(new Error('network blip'));
    const adapter = new KeycloakAdapter({
      issuerUrl: 'http://kc.fake/realms/aggregator',
      clientId: 'aggregator-portal',
    });
    const result = await adapter.exchangeCode({
      code: 'c',
      codeVerifier: 'v',
      redirectUri: 'http://app/cb',
      state: 's',
      expectedState: 's',
      expectedNonce: 'n',
    });
    expect(result).toEqual({
      ok: false,
      error: { code: 'TOKEN_EXCHANGE_FAILED', message: 'network blip' },
    });
  });

  it('refreshes tokens successfully', async () => {
    const { KeycloakAdapter } = await importAdapter();
    const refreshToken = fakeJwt({ exp: 1_800_000_000 });
    mockRefresh.mockResolvedValue({
      access_token: 'NEW_AT',
      refresh_token: refreshToken,
      id_token: 'NEW_IDT',
      expires_at: 1_800_000_300,
    });
    const adapter = new KeycloakAdapter({
      issuerUrl: 'http://kc.fake/realms/aggregator',
      clientId: 'aggregator-portal',
    });
    const result = await adapter.refresh('old-rt');
    expect(result).toEqual({
      ok: true,
      value: {
        accessToken: 'NEW_AT',
        refreshToken,
        idToken: 'NEW_IDT',
        accessTokenExp: 1_800_000_300_000,
        refreshTokenExp: 1_800_000_000_000,
      },
    });
    expect(mockRefresh).toHaveBeenCalledWith('old-rt');
  });

  it('falls back accessTokenExp on refresh when expires_at is absent, and refreshTokenExp when the refresh token payload is not valid JSON', async () => {
    const { KeycloakAdapter } = await importAdapter();
    const before = Date.now();
    const malformedPayloadToken = 'aGVhZGVy.bm90LWpzb24.c2ln'; // 3 parts, middle segment isn't JSON
    mockRefresh.mockResolvedValue({
      access_token: 'NEW_AT',
      refresh_token: malformedPayloadToken,
      id_token: 'NEW_IDT',
    });
    const adapter = new KeycloakAdapter({
      issuerUrl: 'http://kc.fake/realms/aggregator',
      clientId: 'aggregator-portal',
    });
    const result = await adapter.refresh('old-rt');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.accessTokenExp).toBeGreaterThanOrEqual(before + 5 * 60_000 - 1000);
    expect(result.value.refreshTokenExp).toBeGreaterThanOrEqual(before + 30 * 60_000 - 1000);
  });

  it('returns REFRESH_FAILED when the refreshed token set is incomplete', async () => {
    const { KeycloakAdapter } = await importAdapter();
    mockRefresh.mockResolvedValue({ access_token: 'AT', refresh_token: '', id_token: 'IDT' });
    const adapter = new KeycloakAdapter({
      issuerUrl: 'http://kc.fake/realms/aggregator',
      clientId: 'aggregator-portal',
    });
    const result = await adapter.refresh('rt');
    expect(result).toEqual({
      ok: false,
      error: { code: 'REFRESH_FAILED', message: 'incomplete token set on refresh' },
    });
  });

  it('returns REFRESH_FAILED with the error message when refresh throws an Error', async () => {
    const { KeycloakAdapter } = await importAdapter();
    mockRefresh.mockRejectedValue(new Error('refresh token expired'));
    const adapter = new KeycloakAdapter({
      issuerUrl: 'http://kc.fake/realms/aggregator',
      clientId: 'aggregator-portal',
    });
    const result = await adapter.refresh('rt');
    expect(result).toEqual({
      ok: false,
      error: { code: 'REFRESH_FAILED', message: 'refresh token expired' },
    });
  });

  it('returns a generic REFRESH_FAILED message when a non-Error is thrown', async () => {
    const { KeycloakAdapter } = await importAdapter();
    mockRefresh.mockRejectedValue('kaboom');
    const adapter = new KeycloakAdapter({
      issuerUrl: 'http://kc.fake/realms/aggregator',
      clientId: 'aggregator-portal',
    });
    const result = await adapter.refresh('rt');
    expect(result).toEqual({
      ok: false,
      error: { code: 'REFRESH_FAILED', message: 'unknown error' },
    });
  });

  it('builds the RP-initiated logout URL', async () => {
    const { KeycloakAdapter } = await importAdapter();
    mockEndSessionUrl.mockReturnValue('http://kc.fake/logout?x=1');
    const adapter = new KeycloakAdapter({
      issuerUrl: 'http://kc.fake/realms/aggregator',
      clientId: 'aggregator-portal',
    });
    const url = await adapter.buildLogoutUrl({
      idToken: 'idt',
      postLogoutRedirectUri: 'http://app/',
    });
    expect(url).toBe('http://kc.fake/logout?x=1');
    expect(mockEndSessionUrl).toHaveBeenCalledWith({
      id_token_hint: 'idt',
      post_logout_redirect_uri: 'http://app/',
    });
  });

  it('exposes the discovered issuer metadata via the test helper', async () => {
    const { KeycloakAdapter } = await importAdapter();
    const adapter = new KeycloakAdapter({
      issuerUrl: 'http://kc.fake/realms/aggregator',
      clientId: 'aggregator-portal',
    });
    const metadata = await adapter._issuerMetadata();
    expect(metadata).toEqual({ issuer: 'http://kc.fake/realms/aggregator' });
  });

  describe('oidcGenerators', () => {
    it('delegates each helper to the underlying openid-client generator', async () => {
      const { oidcGenerators } = await importAdapter();
      expect(oidcGenerators.state()).toBe('gen-state');
      expect(oidcGenerators.nonce()).toBe('gen-nonce');
      expect(oidcGenerators.codeVerifier()).toBe('gen-verifier');
      expect(oidcGenerators.codeChallenge('verifier-x')).toBe('gen-challenge');
      expect(generatorsMock.codeChallenge).toHaveBeenCalledWith('verifier-x');
    });
  });
});

/** Builds a JWT-shaped (but unsigned) string carrying the given payload. */
function fakeJwt(payload: Record<string, unknown>): string {
  const b64url = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64url({ alg: 'none' })}.${b64url(payload)}.sig`;
}
