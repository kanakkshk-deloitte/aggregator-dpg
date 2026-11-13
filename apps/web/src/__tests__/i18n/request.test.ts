import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const cookiesGetMock = vi.fn();
const headersGetMock = vi.fn();
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: cookiesGetMock }),
  headers: async () => ({ get: headersGetMock }),
}));

// `next-intl/server`'s real entry resolves to a "react-client" build under
// jsdom (this suite's test environment) and deliberately throws — it only
// works inside an actual RSC render. `getRequestConfig` itself is just an
// identity function (`(fn) => fn`) on the real server build, so stubbing
// that identity here lets us unit-test the plain async callback in
// `request.ts` without needing a real Server Component render.
vi.mock('next-intl/server', () => ({
  getRequestConfig: <T>(fn: T): T => fn,
}));

const requestConfig = (await import('@/i18n/request')).default as unknown as () => Promise<{
  locale: string;
  messages: Record<string, unknown>;
}>;

describe('i18n request config', () => {
  beforeEach(() => {
    cookiesGetMock.mockReset();
    headersGetMock.mockReset();
    delete process.env.ENABLED_LANGUAGES;
  });

  afterEach(() => {
    delete process.env.ENABLED_LANGUAGES;
  });

  it('resolves the cookie locale and loads its message catalog', async () => {
    cookiesGetMock.mockReturnValue({ value: 'kn' });
    headersGetMock.mockReturnValue(null);
    const { locale, messages } = await requestConfig();
    expect(locale).toBe('kn');
    expect(messages).toHaveProperty('language');
  });

  it('falls back to Accept-Language, then default, loading the matching catalog', async () => {
    cookiesGetMock.mockReturnValue(undefined);
    headersGetMock.mockReturnValue('hi-IN,hi;q=0.9');
    const { locale, messages } = await requestConfig();
    expect(locale).toBe('hi');
    expect(messages).toHaveProperty('language');
  });

  it('defaults to en when neither cookie nor header resolve', async () => {
    cookiesGetMock.mockReturnValue(undefined);
    headersGetMock.mockReturnValue(null);
    const { locale, messages } = await requestConfig();
    expect(locale).toBe('en');
    expect(messages).toHaveProperty('language');
  });
});
