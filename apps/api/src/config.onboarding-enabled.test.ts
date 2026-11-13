/**
 * Unit tests for `AGGREGATOR_ONBOARDING_ENABLED` parsing (#637).
 *
 * Exercised through the exported pure functions rather than by mutating
 * process.env, because `config.ts` snapshots the environment at module load.
 * The route-level tests cover the live-env path separately.
 *
 * @module apps/api/config.onboarding-enabled.test
 */
import { describe, it, expect } from 'vitest';
import {
  parseOnboardingEnabled,
  unknownOnboardingCapabilities,
  reservedOnboardingCapabilities,
  isOnboardingCapabilityEnabled,
  enabledRegistrationModes,
} from './config.js';

describe('parseOnboardingEnabled', () => {
  it('returns null only when the var is absent from the environment (⇒ all enabled)', () => {
    // `null`, not `[]` — "unset" and "nothing enabled" must stay distinguishable,
    // and *only* a genuinely absent var may take the all-enabled branch.
    expect(parseOnboardingEnabled(undefined).capabilities).toBeNull();
    expect(parseOnboardingEnabled(undefined).warnings).toEqual([]);
  });

  it.each([
    ['empty string', ''],
    ['whitespace only', '   '],
    ['newline only', '\n'],
    ['empty double quotes', '""'],
    ['empty single quotes', "''"],
  ])('locks out loudly for a set-but-blank value (%s)', (_label, raw) => {
    // Regression guard for the fail-open defect: `stripHelmQuoting` collapses
    // every one of these to '', which used to return `null` — all modes
    // enabled, zero warnings. A Helm `| quote` over an empty string, or a
    // block scalar whose `{{- if }}` rendered nothing, produces exactly these,
    // so the most likely misconfiguration was also the silent one.
    const parsed = parseOnboardingEnabled(raw);
    expect(parsed.capabilities).toEqual([]);
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0]).toContain('set but blank');
    expect(parsed.warnings[0]).toContain('names no capability');
  });

  it('parses a comma-separated allow-list in listed order', () => {
    expect(parseOnboardingEnabled('form,voice').capabilities).toEqual(['form', 'voice']);
    expect(parseOnboardingEnabled('voice,form').capabilities).toEqual(['voice', 'form']);
  });

  it('parses a single capability', () => {
    expect(parseOnboardingEnabled('form').capabilities).toEqual(['form']);
  });

  it('trims whitespace and lowercases each entry', () => {
    expect(parseOnboardingEnabled('  FORM , Voice  ').capabilities).toEqual(['form', 'voice']);
  });

  it('accepts newline separators as well as commas', () => {
    expect(parseOnboardingEnabled('form\nvoice').capabilities).toEqual(['form', 'voice']);
    expect(parseOnboardingEnabled('form,\nvoice\n').capabilities).toEqual(['form', 'voice']);
  });

  it('drops empty entries left by stray separators', () => {
    expect(parseOnboardingEnabled('form,,voice,').capabilities).toEqual(['form', 'voice']);
  });

  it('strips Helm double-quote wrapping', () => {
    expect(parseOnboardingEnabled('"form,voice"').capabilities).toEqual(['form', 'voice']);
  });

  it('strips Helm single-quote wrapping', () => {
    expect(parseOnboardingEnabled("'form'").capabilities).toEqual(['form']);
  });

  it('accepts whitespace as a separator alongside commas', () => {
    // `form voice` is unambiguous operator intent. Splitting on `,` alone made
    // it the single bogus capability "form voice", which matches no declared
    // mode and hard-locks link creation with no parse-time warning.
    expect(parseOnboardingEnabled('form voice').capabilities).toEqual(['form', 'voice']);
    expect(parseOnboardingEnabled('form,  voice').capabilities).toEqual(['form', 'voice']);
    expect(parseOnboardingEnabled('form voice').warnings).toEqual([]);
  });

  it('de-duplicates repeated values and warns once about the repeat', () => {
    const parsed = parseOnboardingEnabled('form,FORM,voice');
    expect(parsed.capabilities).toEqual(['form', 'voice']);
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0]).toContain('duplicate');
    expect(parsed.warnings[0]).toContain('form');
  });

  it('reports an empty allow-list rather than falling back to all enabled', () => {
    // Set, but every entry was a separator. Failing open here would silently
    // re-enable the modes the operator was trying to withhold.
    const parsed = parseOnboardingEnabled(',,');
    expect(parsed.capabilities).toEqual([]);
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0]).toContain('names no capability');
  });

  it('keeps `bulk` in the allow-list — reserved does not mean ignored', () => {
    // Silently dropping it would turn `bulk` into a fail-open: the list would
    // become empty and then look "unset". It stays, so the empty-intersection
    // lockout still fires.
    expect(parseOnboardingEnabled('bulk').capabilities).toEqual(['bulk']);
    expect(parseOnboardingEnabled('form,bulk').capabilities).toEqual(['form', 'bulk']);
  });

  it('emits no warnings for a clean allow-list', () => {
    expect(parseOnboardingEnabled('form,voice').warnings).toEqual([]);
  });

  it('keeps an unrecognised value verbatim — format is not validated here', () => {
    // The declared-mode cross-check runs later, once a network config exists.
    expect(parseOnboardingEnabled('frm').capabilities).toEqual(['frm']);
    expect(parseOnboardingEnabled('frm').warnings).toEqual([]);
  });
});

describe('unknownOnboardingCapabilities', () => {
  it('returns nothing when the allow-list is unset (it restricts nothing)', () => {
    expect(unknownOnboardingCapabilities(null, ['form', 'voice'])).toEqual([]);
  });

  it('names a typo that matches no declared mode', () => {
    expect(unknownOnboardingCapabilities(['frm'], ['form', 'voice'])).toEqual(['frm']);
  });

  it('does not flag `bulk` as unknown — it is reserved, not a typo', () => {
    // The docs present `bulk` as an accepted value, so "matches no
    // registration mode declared by this network" would read as a bug report
    // about a value this repo endorsed. It gets its own message instead.
    expect(unknownOnboardingCapabilities(['form', 'bulk'], ['form', 'voice'])).toEqual([]);
    expect(unknownOnboardingCapabilities(['frm', 'bulk'], ['form', 'voice'])).toEqual(['frm']);
  });

  it('returns nothing when every value matches a declared mode', () => {
    expect(unknownOnboardingCapabilities(['form', 'voice'], ['form', 'voice'])).toEqual([]);
  });

  it('flags everything when the network declares no modes at all', () => {
    expect(unknownOnboardingCapabilities(['form'], [])).toEqual(['form']);
  });
});

describe('reservedOnboardingCapabilities', () => {
  it('returns nothing when the allow-list is unset', () => {
    expect(reservedOnboardingCapabilities(null)).toEqual([]);
  });

  it('names a reserved value that gates nothing yet', () => {
    expect(reservedOnboardingCapabilities(['form', 'bulk'])).toEqual(['bulk']);
  });

  it('does not claim a real mode or a typo is reserved', () => {
    expect(reservedOnboardingCapabilities(['form', 'voice', 'frm'])).toEqual([]);
  });
});

describe('isOnboardingCapabilityEnabled', () => {
  // Mutates process.env deliberately: this is the live-env accessor, and the
  // point of reading env at call time is that it can change between requests.
  const original = process.env.AGGREGATOR_ONBOARDING_ENABLED;
  const set = (v: string | undefined): void => {
    if (v === undefined) delete process.env.AGGREGATOR_ONBOARDING_ENABLED;
    else process.env.AGGREGATOR_ONBOARDING_ENABLED = v;
  };

  it('enables everything when unset', () => {
    set(undefined);
    expect(isOnboardingCapabilityEnabled('form')).toBe(true);
    expect(isOnboardingCapabilityEnabled('voice')).toBe(true);
    // Even a mode nobody has invented yet: unset means "no restriction".
    expect(isOnboardingCapabilityEnabled('kiosk')).toBe(true);
    set(original);
  });

  it('enables only the listed capabilities when set', () => {
    set('form');
    expect(isOnboardingCapabilityEnabled('form')).toBe(true);
    expect(isOnboardingCapabilityEnabled('voice')).toBe(false);
    set(original);
  });

  it('treats form,voice as identical to unset', () => {
    set('form,voice');
    expect(isOnboardingCapabilityEnabled('form')).toBe(true);
    expect(isOnboardingCapabilityEnabled('voice')).toBe(true);
    set(original);
  });

  it('enables nothing when the value names no capability', () => {
    set(',,');
    expect(isOnboardingCapabilityEnabled('form')).toBe(false);
    expect(isOnboardingCapabilityEnabled('voice')).toBe(false);
    set(original);
  });

  it('enables nothing when the value is present but blank', () => {
    // The live-env half of the fail-open regression guard: an empty env var is
    // a misconfiguration, not the default.
    for (const blank of ['', '   ', '""']) {
      set(blank);
      expect(isOnboardingCapabilityEnabled('form')).toBe(false);
      expect(isOnboardingCapabilityEnabled('voice')).toBe(false);
    }
    set(original);
  });
});

describe('enabledRegistrationModes', () => {
  const original = process.env.AGGREGATOR_ONBOARDING_ENABLED;
  const set = (v: string | undefined): void => {
    if (v === undefined) delete process.env.AGGREGATOR_ONBOARDING_ENABLED;
    else process.env.AGGREGATOR_ONBOARDING_ENABLED = v;
  };

  it('returns the declared list unchanged when unset', () => {
    set(undefined);
    expect(enabledRegistrationModes(['voice', 'form'])).toEqual(['voice', 'form']);
    set(original);
  });

  it('narrows to the allow-list, preserving declared order', () => {
    set('form');
    expect(enabledRegistrationModes(['voice', 'form'])).toEqual(['form']);
    set(original);
  });

  it('is empty when the allow-list names only a reserved capability', () => {
    // `bulk` gates nothing, so it enables no declared mode. Fail-closed: the
    // caller must lock out, not treat this as "unset".
    set('bulk');
    expect(enabledRegistrationModes(['voice', 'form'])).toEqual([]);
    set(original);
  });

  it('is empty for a blank value', () => {
    set('   ');
    expect(enabledRegistrationModes(['voice', 'form'])).toEqual([]);
    set(original);
  });
});
