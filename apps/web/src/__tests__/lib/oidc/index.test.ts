import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// `function`, not an arrow — getOidcAdapter() calls `new KeycloakAdapter(...)`,
// and vitest 4 no longer tolerates a non-constructible mock implementation.
const KeycloakAdapterMock = vi.fn(function (opts: unknown) {
  return { opts };
});
vi.mock('@/lib/oidc/keycloak', () => ({
  KeycloakAdapter: KeycloakAdapterMock,
  oidcGenerators: { state: vi.fn() },
}));

const ENV_KEYS = ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_SCOPE'];

describe('getOidcAdapter', () => {
  beforeEach(() => {
    vi.resetModules();
    KeycloakAdapterMock.mockClear();
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  it('throws when OIDC_ISSUER or OIDC_CLIENT_ID are missing', async () => {
    const { getOidcAdapter } = await import('@/lib/oidc');
    expect(() => getOidcAdapter()).toThrow(/OIDC_ISSUER and OIDC_CLIENT_ID must be set/);
  });

  it('builds a KeycloakAdapter from required env only', async () => {
    process.env.OIDC_ISSUER = 'http://kc/realms/aggregator';
    process.env.OIDC_CLIENT_ID = 'aggregator-portal';
    const { getOidcAdapter } = await import('@/lib/oidc');
    getOidcAdapter();
    expect(KeycloakAdapterMock).toHaveBeenCalledWith({
      issuerUrl: 'http://kc/realms/aggregator',
      clientId: 'aggregator-portal',
    });
  });

  it('includes optional client secret + scope when set', async () => {
    process.env.OIDC_ISSUER = 'http://kc/realms/aggregator';
    process.env.OIDC_CLIENT_ID = 'aggregator-portal';
    process.env.OIDC_CLIENT_SECRET = 'sekret';
    process.env.OIDC_SCOPE = 'openid profile';
    const { getOidcAdapter } = await import('@/lib/oidc');
    getOidcAdapter();
    expect(KeycloakAdapterMock).toHaveBeenCalledWith({
      issuerUrl: 'http://kc/realms/aggregator',
      clientId: 'aggregator-portal',
      clientSecret: 'sekret',
      defaultScope: 'openid profile',
    });
  });

  it('returns the same singleton across calls', async () => {
    process.env.OIDC_ISSUER = 'http://kc/realms/aggregator';
    process.env.OIDC_CLIENT_ID = 'aggregator-portal';
    const { getOidcAdapter } = await import('@/lib/oidc');
    const first = getOidcAdapter();
    const second = getOidcAdapter();
    expect(first).toBe(second);
    expect(KeycloakAdapterMock).toHaveBeenCalledTimes(1);
  });

  it('_setOidcAdapter injects a fake and getOidcAdapter returns it without validating env', async () => {
    const { getOidcAdapter, _setOidcAdapter } = await import('@/lib/oidc');
    const fake = { fake: true };
    _setOidcAdapter(fake as never);
    expect(getOidcAdapter()).toBe(fake as never);
    _setOidcAdapter(null);
  });
});
