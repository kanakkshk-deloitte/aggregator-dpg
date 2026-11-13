import { describe, it, expect, afterEach } from 'vitest';
import { parseProperties } from './parse-properties.js';
import { substitute, toPlainText, tokensUsed } from './substitute.js';
import {
  getMessage,
  assertMessagesComplete,
  emailMessageOverridePaths,
  _setEmailMessages,
} from './messages.js';
import { EMAIL_CASE_IDS, caseKeys, caseTokenTypes, requiredMessageKeys } from './email-cases.js';

afterEach(() => {
  _setEmailMessages(null);
});

describe('parseProperties', () => {
  it('splits at the FIRST = so values may contain more', () => {
    const out = parseProperties('a.cta=Open https://x.test/p?grant=abc&y=1');
    expect(out.entries.get('a.cta')).toBe('Open https://x.test/p?grant=abc&y=1');
    expect(out.malformedLines).toEqual([]);
  });

  it('ignores blanks and both comment markers', () => {
    const out = parseProperties('# hash\n! bang\n\n  \na.b=v');
    expect([...out.entries.keys()]).toEqual(['a.b']);
    expect(out.malformedLines).toEqual([]);
  });

  it('reports malformed lines by 1-based number rather than dropping them', () => {
    const out = parseProperties('a.b=v\nno-equals-here\n=leading');
    expect(out.entries.size).toBe(1);
    expect(out.malformedLines).toEqual([2, 3]);
  });

  it('lets a later duplicate win', () => {
    const out = parseProperties('a.b=first\na.b=second');
    expect(out.entries.get('a.b')).toBe('second');
  });
});

describe('substitute', () => {
  it('escapes text tokens', () => {
    const out = substitute('Hi {{name}}', { name: '<script>x</script>' }, { name: 'text' });
    expect(out).toBe('Hi &lt;script&gt;x&lt;/script&gt;');
  });

  it('inserts html tokens raw', () => {
    const out = substitute('{{block}} tail', { block: '<b>ok</b>' }, { block: 'html' });
    expect(out).toBe('<b>ok</b> tail');
  });

  it('treats an UNDECLARED token as text — safe default', () => {
    // Forgetting to declare a token must not open a raw-HTML hole.
    const out = substitute('{{x}}', { x: '<i>y</i>' });
    expect(out).toBe('&lt;i&gt;y&lt;/i&gt;');
  });

  it('leaves an unprovided token literal instead of blanking it', () => {
    expect(substitute('a {{missing}} b', {})).toBe('a {{missing}} b');
  });

  it('collects the tokens a fragment uses', () => {
    expect(tokensUsed('{{a}} and {{b}} and {{a}}').sort()).toEqual(['a', 'b']);
  });
});

describe('toPlainText', () => {
  it('strips the allowed tag vocabulary and decodes entities', () => {
    expect(toPlainText('<b>Bold</b> &amp; <a href="#">link</a>')).toBe('Bold & link');
  });

  it('decodes &amp; last so &amp;lt; does not become <', () => {
    expect(toPlainText('&amp;lt;')).toBe('&lt;');
  });

  it('turns <br> into a newline', () => {
    expect(toPlainText('a<br/>b')).toBe('a\nb');
  });
});

describe('email case registry', () => {
  it('every declared key exists in the bundled defaults', () => {
    // The bundled layer must be complete — a hole is a build defect.
    expect(() => assertMessagesComplete()).not.toThrow();
  });

  it('every default copy fragment only uses tokens its case declares', () => {
    const problems: string[] = [];
    for (const caseId of EMAIL_CASE_IDS) {
      const declared = new Set(Object.keys(caseTokenTypes(caseId)));
      for (const key of caseKeys(caseId)) {
        for (const token of tokensUsed(getMessage(`${caseId}.${key}`))) {
          if (!declared.has(token)) problems.push(`${caseId}.${key}: {{${token}}}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('derives every key from the layout, so a layout key cannot go undefined', () => {
    // caseKeys() walks the layout (including oneOf alternatives and derived
    // tokens); assertMessagesComplete() then checks each against the defaults.
    expect(requiredMessageKeys().length).toBeGreaterThan(EMAIL_CASE_IDS.length);
    for (const caseId of EMAIL_CASE_IDS) {
      expect(caseKeys(caseId)).toContain('subject');
    }
  });

  it('rejects an unknown case rather than silently escaping everything', () => {
    expect(() => caseTokenTypes('nope')).toThrow(/unknown email case/);
  });
});

describe('message lookup', () => {
  it('falls back to the key itself when absent — visibly wrong beats blank', () => {
    _setEmailMessages(new Map());
    expect(getMessage('applicant_approved.subject')).toBe('applicant_approved.subject');
  });

  it('assertMessagesComplete rejects an override that drops a declared token', () => {
    // Keys present, token missing: the CTA button survives (its href comes
    // from the layout) but body copy that carried the link loses it silently.
    const full = new Map<string, string>();
    for (const caseId of EMAIL_CASE_IDS) {
      for (const key of caseKeys(caseId)) full.set(`${caseId}.${key}`, 'x');
    }
    full.set('owner_grant_refreshed.intro', 'Link for {{notADeclaredToken}}');
    _setEmailMessages(full);
    expect(() => assertMessagesComplete()).toThrow(/undeclared token/);
  });

  it('assertMessagesComplete fails loudly on a hole', () => {
    _setEmailMessages(new Map([['applicant_approved.subject', 'x']]));
    expect(() => assertMessagesComplete()).toThrow(/missing \d+ key/);
  });
});

describe('override path precedence', () => {
  it('orders network, then brand, then the instance escape hatch', () => {
    const paths = emailMessageOverridePaths({
      CONFIG_ROOT: '/cfg',
      AGGREGATOR_NETWORK: 'blue_dot',
      AGGREGATOR_BRAND: 'up-gzb',
      EMAIL_MESSAGES_PATH: '/etc/aggregator/messages.properties',
    } as NodeJS.ProcessEnv);
    // Exact equality, not `toContain`: an earlier version built these from
    // `resolveConfigDir`, which already descends into the network, so the
    // segment was doubled (`/cfg/blue_dot/blue_dot/...`) and a substring
    // assertion passed anyway.
    expect(paths).toEqual([
      '/cfg/blue_dot/emails/messages.properties',
      '/cfg/blue_dot/up-gzb/emails/messages.properties',
      '/etc/aggregator/messages.properties',
    ]);
  });

  it('omits the brand layer when no brand is set', () => {
    const paths = emailMessageOverridePaths({
      CONFIG_ROOT: '/cfg',
      AGGREGATOR_NETWORK: 'purple_dot',
    } as NodeJS.ProcessEnv);
    expect(paths).toEqual(['/cfg/purple_dot/emails/messages.properties']);
  });

  it('never repeats the network segment', () => {
    for (const env of [
      { CONFIG_ROOT: '/cfg', AGGREGATOR_NETWORK: 'blue_dot' },
      { CONFIG_ROOT: '/cfg', AGGREGATOR_NETWORK: 'blue_dot', AGGREGATOR_BRAND: 'up-gzb' },
    ] as NodeJS.ProcessEnv[]) {
      for (const p of emailMessageOverridePaths(env)) {
        expect(p.split('/').filter((seg) => seg === 'blue_dot')).toHaveLength(1);
      }
    }
  });

  it('reads the aggregator-level default from the config root', () => {
    // Loaded from config/emails/messages.properties via CONFIG_ROOT, which the
    // vitest config points at the repo's own config/.
    expect(() => assertMessagesComplete()).not.toThrow();
    expect(getMessage('applicant_approved.subject')).toContain('approved');
  });
});
