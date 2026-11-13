import { describe, it, expect } from 'vitest';
import { resolveSubmissionShape, isModeDeclared, signalsCtaEnabled } from './index.js';
import type { ResolvedNetworkConfig } from '@aggregator-dpg/network-config/interface';

const cfg = {
  aggregator: {
    registration_modes: {
      voice: {
        label_i18n_key: 'registration_mode.voice.label',
        submission_shape: 'account_only',
        public_hint_i18n_key: 'registration_mode.voice.hint',
      },
      form: {
        label_i18n_key: 'registration_mode.form.label',
        submission_shape: 'account_and_profile',
        public_hint_i18n_key: null,
      },
    },
  },
} as unknown as ResolvedNetworkConfig;

describe('resolveSubmissionShape', () => {
  it('returns the configured shape for a declared mode', () => {
    expect(resolveSubmissionShape('voice', cfg)).toBe('account_only');
    expect(resolveSubmissionShape('form', cfg)).toBe('account_and_profile');
  });

  it('returns account_and_profile (graceful default) for an unknown mode', () => {
    expect(resolveSubmissionShape('sms_campaign', cfg)).toBe('account_and_profile');
  });
});

describe('isModeDeclared', () => {
  it('true for declared keys', () => {
    expect(isModeDeclared('voice', cfg)).toBe(true);
    expect(isModeDeclared('form', cfg)).toBe(true);
  });
  it('false for unknown keys', () => {
    expect(isModeDeclared('kiosk', cfg)).toBe(false);
  });
});

describe('signalsCtaEnabled', () => {
  it('defaults to true for an account_and_profile mode with no explicit flag', () => {
    expect(signalsCtaEnabled('form', cfg)).toBe(true);
  });

  it('defaults to false for an account_only mode with no explicit flag', () => {
    expect(signalsCtaEnabled('voice', cfg)).toBe(false);
  });

  it('honours an explicit flag in either direction', () => {
    const explicit = {
      aggregator: {
        registration_modes: {
          voice: { submission_shape: 'account_only', signals_cta: true },
          form: { submission_shape: 'account_and_profile', signals_cta: false },
        },
      },
    } as unknown as ResolvedNetworkConfig;
    expect(signalsCtaEnabled('voice', explicit)).toBe(true);
    expect(signalsCtaEnabled('form', explicit)).toBe(false);
  });

  it('falls back to the resolved shape for an undeclared mode', () => {
    // An undeclared mode already renders the full profile form via
    // resolveSubmissionShape's account_and_profile fallback, so it gets the
    // same hand-off that `form` would.
    expect(signalsCtaEnabled('kiosk', cfg)).toBe(true);
  });
});
