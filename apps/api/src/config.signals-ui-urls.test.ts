/**
 * Unit tests for SIGNALS_UI_URLS parsing.
 *
 * Exercised through the exported pure function rather than by mutating
 * process.env, because `config.ts` snapshots the environment at module load.
 */
import { describe, it, expect } from 'vitest';
import { parseSignalsUiUrls, signalsUiUrls, unknownSignalsUiUrlDomains } from './config.js';

describe('parseSignalsUiUrls', () => {
  it('parses comma-separated domain=url pairs', () => {
    expect(
      parseSignalsUiUrls(
        'seeker=https://signals-seeker.example/auth/login,provider=https://signals-provider.example/auth/login',
      ).urls,
    ).toEqual({
      seeker: 'https://signals-seeker.example/auth/login',
      provider: 'https://signals-provider.example/auth/login',
    });
  });

  it('returns an empty map for unset or empty input', () => {
    expect(parseSignalsUiUrls(undefined).urls).toEqual({});
    expect(parseSignalsUiUrls('').urls).toEqual({});
    expect(parseSignalsUiUrls('   ').urls).toEqual({});
  });

  it('splits on the first = only so query strings survive', () => {
    expect(parseSignalsUiUrls('seeker=https://s.example/auth/login?a=1&b=2').urls).toEqual({
      seeker: 'https://s.example/auth/login?a=1&b=2',
    });
  });

  it('tolerates Helm quote wrapping, newlines and stray whitespace', () => {
    expect(
      parseSignalsUiUrls(
        '"seeker=https://s.example/auth/login\n provider=https://p.example/auth/login "',
      ).urls,
    ).toEqual({
      seeker: 'https://s.example/auth/login',
      provider: 'https://p.example/auth/login',
    });
  });

  it('skips a malformed entry and warns, keeping the valid ones', () => {
    const result = parseSignalsUiUrls(
      'seeker=https://s.example/auth/login,provider=not-a-url,=https://x.example,Bad=https://y.example',
    );
    expect(result.urls).toEqual({ seeker: 'https://s.example/auth/login' });
    expect(result.warnings).toHaveLength(3);
    expect(result.warnings.join(' ')).toContain('provider');
  });

  it('rejects non-http(s) schemes', () => {
    expect(parseSignalsUiUrls('seeker=javascript:alert(1)').urls).toEqual({});
  });

  it('last entry wins on a duplicate domain key', () => {
    expect(
      parseSignalsUiUrls('seeker=https://a.example/auth/login,seeker=https://b.example/auth/login')
        .urls,
    ).toEqual({
      seeker: 'https://b.example/auth/login',
    });
  });

  it('warns on a duplicate domain key so the discarded URL is not silent', () => {
    const result = parseSignalsUiUrls(
      'seeker=https://a.example/auth/login,seeker=https://b.example/auth/login',
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('duplicate');
    expect(result.warnings[0]).toContain('seeker');
  });

  it('warns specifically about a bare entry with no "=" separator', () => {
    const result = parseSignalsUiUrls('seeker=https://s.example/auth/login,justtext');
    expect(result.urls).toEqual({ seeker: 'https://s.example/auth/login' });
    expect(result.warnings).toHaveLength(1);
    // Distinct from the invalid-key message: a bare word is a missing `=`,
    // not a badly spelled domain, and the log must say which.
    expect(result.warnings[0]).toContain('no "=" separator');
    expect(result.warnings[0]).toContain('justtext');
  });

  it('unwraps single-quote Helm wrapping as well as double', () => {
    expect(parseSignalsUiUrls("'seeker=https://s.example/auth/login'").urls).toEqual({
      seeker: 'https://s.example/auth/login',
    });
  });

  it('rejects a digit-leading domain key', () => {
    const result = parseSignalsUiUrls('1seeker=https://s.example/auth/login');
    expect(result.urls).toEqual({});
    expect(result.warnings[0]).toContain('invalid domain key');
  });

  it('rejects a hyphen-containing domain key (ids are snake_case)', () => {
    const result = parseSignalsUiUrls('job-seeker=https://s.example/auth/login');
    expect(result.urls).toEqual({});
    expect(result.warnings[0]).toContain('invalid domain key');
  });

  it('accepts underscores and digits after the first character', () => {
    expect(parseSignalsUiUrls('job_seeker2=https://s.example/auth/login').urls).toEqual({
      job_seeker2: 'https://s.example/auth/login',
    });
  });
});

describe('signalsUiUrls export', () => {
  it('is frozen, so the validated-URL invariant cannot be edited from outside', () => {
    expect(Object.isFrozen(signalsUiUrls)).toBe(true);
    // Non-strict-mode assignment on a frozen object is a silent no-op; assert
    // on the observable outcome rather than on a thrown error.
    expect(() => {
      (signalsUiUrls as Record<string, string>)['seeker'] = 'javascript:alert(1)';
    }).toThrow();
    expect(signalsUiUrls['seeker']).toBeUndefined();
  });
});

describe('unknownSignalsUiUrlDomains', () => {
  it('names a key that matches no declared domain', () => {
    // The failure this guards: `seekr` is a well-formed key, so the parser
    // accepts it, and the `seeker` hand-off then never appears.
    expect(
      unknownSignalsUiUrlDomains({ seekr: 'https://s.example/auth/login' }, ['seeker', 'provider']),
    ).toEqual(['seekr']);
  });

  it('returns nothing when every key matches a declared domain', () => {
    expect(
      unknownSignalsUiUrlDomains(
        { seeker: 'https://s.example/auth/login', provider: 'https://p.example/auth/login' },
        ['seeker', 'provider'],
      ),
    ).toEqual([]);
  });

  it('reports only the unknown keys, keeping the known ones out of the result', () => {
    expect(
      unknownSignalsUiUrlDomains(
        { seeker: 'https://s.example/auth/login', mentor: 'https://m.example/auth/login' },
        ['seeker', 'provider'],
      ),
    ).toEqual(['mentor']);
  });

  it('is empty for an empty map or an empty domain list', () => {
    expect(unknownSignalsUiUrlDomains({}, ['seeker'])).toEqual([]);
    expect(unknownSignalsUiUrlDomains({ seeker: 'https://s.example/auth/login' }, [])).toEqual([
      'seeker',
    ]);
  });
});
