import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const setMock = vi.fn();
vi.mock('next/headers', () => ({ cookies: () => ({ set: setMock }) }));

const { setLocale } = await import('@/i18n/locale-cookie');

describe('setLocale', () => {
  beforeEach(() => {
    setMock.mockReset();
    delete process.env.ENABLED_LANGUAGES;
  });

  afterEach(() => {
    delete process.env.ENABLED_LANGUAGES;
  });

  it('persists an enabled locale to the NEXT_LOCALE cookie', async () => {
    await setLocale('kn');
    expect(setMock).toHaveBeenCalledWith(
      'NEXT_LOCALE',
      'kn',
      expect.objectContaining({ path: '/', sameSite: 'lax' }),
    );
  });

  it('falls back to the default locale for an unsupported/disabled code', async () => {
    await setLocale('fr');
    expect(setMock).toHaveBeenCalledWith('NEXT_LOCALE', 'en', expect.any(Object));
  });

  it('rejects a locale not in the enabled set even if globally supported', async () => {
    process.env.ENABLED_LANGUAGES = 'en,hi';
    await setLocale('kn');
    expect(setMock).toHaveBeenCalledWith('NEXT_LOCALE', 'en', expect.any(Object));
  });
});
