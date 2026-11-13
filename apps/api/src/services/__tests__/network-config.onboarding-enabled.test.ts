/**
 * Covers the `AGGREGATOR_ONBOARDING_ENABLED` ↔ declared-modes cross-check.
 *
 * The env var is parsed with no network config in hand, so a value is only
 * checked for *shape* there — `frm` parses clean and then withholds every
 * mode with nothing said. `getNetworkConfig`'s success path is the first point
 * where both halves are known, so the diagnostics live there. Kept in its own
 * file (own logger mock) so the sibling network-config tests are untouched.
 *
 * @module @aggregator-dpg/api
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const { mockLoad, mockLoggerWarn, mockLoggerError } = vi.hoisted(() => ({
  mockLoad: vi.fn(),
  mockLoggerWarn: vi.fn(),
  mockLoggerError: vi.fn(),
}));

vi.mock('@aggregator-dpg/network-config/loader', () => ({
  FileNetworkConfigLoader: class {
    load = mockLoad;
  },
}));

vi.mock('@aggregator-dpg/network-config/paths', () => ({
  resolveConfigPath: () => '/app/config/aggregator.config.yaml',
}));

vi.mock('../../logger.js', () => ({
  logger: { error: mockLoggerError, info: vi.fn(), warn: mockLoggerWarn, debug: vi.fn() },
}));

const OPERATION = 'config.onboardingEnabled.modeCheck';
const ORIGINAL = process.env.AGGREGATOR_ONBOARDING_ENABLED;

const sampleConfig = {
  network: { id: 'blue_dot' },
  domainIds: ['seeker', 'provider'],
  aggregator: {
    brand: { short_name: 'Blue Dots' },
    registration_modes: { voice: {}, form: {} },
  },
};

/** Loads the module fresh and resolves the config with the given env value. */
async function loadWith(envValue: string | undefined): Promise<unknown> {
  if (envValue === undefined) delete process.env.AGGREGATOR_ONBOARDING_ENABLED;
  else process.env.AGGREGATOR_ONBOARDING_ENABLED = envValue;
  mockLoad.mockResolvedValue({ success: true, value: sampleConfig });
  const { getNetworkConfig } = await import('../network-config.js');
  return getNetworkConfig();
}

const warnCalls = () =>
  mockLoggerWarn.mock.calls.filter((c) => (c[0] as { operation?: string }).operation === OPERATION);
const errorCalls = () =>
  mockLoggerError.mock.calls.filter(
    (c) => (c[0] as { operation?: string }).operation === OPERATION,
  );

describe('getNetworkConfig AGGREGATOR_ONBOARDING_ENABLED cross-check', () => {
  beforeEach(() => {
    vi.resetModules();
    mockLoad.mockReset();
    mockLoggerWarn.mockReset();
    mockLoggerError.mockReset();
  });

  afterAll(() => {
    if (ORIGINAL === undefined) delete process.env.AGGREGATOR_ONBOARDING_ENABLED;
    else process.env.AGGREGATOR_ONBOARDING_ENABLED = ORIGINAL;
  });

  it('says nothing when the var is unset', async () => {
    await loadWith(undefined);
    expect(warnCalls()).toHaveLength(0);
    expect(errorCalls()).toHaveLength(0);
  });

  it('says nothing when every value matches a declared mode', async () => {
    await loadWith('form,voice');
    expect(warnCalls()).toHaveLength(0);
    expect(errorCalls()).toHaveLength(0);
  });

  it('warns once, naming a value that matches no declared mode', async () => {
    await loadWith('form,frm');
    const calls = warnCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toMatchObject({
      // `status` stays inside the documented success/failure/skipped enum
      // (.claude/rules/logging-observability.md); the finding rides alongside.
      status: 'skipped',
      finding: 'unknown_capability',
      capability: 'frm',
    });
    expect(calls[0]![1]).toContain('frm');
    // The correctly spelled value must not be flagged.
    expect(JSON.stringify(calls[0])).not.toContain('"capability":"form"');
    // `form` still enables something, so this is not the empty-set case.
    expect(errorCalls()).toHaveLength(0);
  });

  it('warns about `bulk` as reserved, not as an unrecognised value', async () => {
    await loadWith('form,bulk');
    const calls = warnCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toMatchObject({
      status: 'skipped',
      finding: 'reserved_capability',
      capability: 'bulk',
    });
    // `bulk` is documented as accepted, so the "matches no registration mode
    // declared by this network" text would read as a bug report about a value
    // this repo endorsed.
    expect(calls[0]![1]).toContain('reserved');
    expect(calls[0]![1]).not.toContain('matches no registration mode');
    // `form` still enables something, so this is not the lockout case.
    expect(errorCalls()).toHaveLength(0);
  });

  it('still locks out — loudly — when `bulk` is the only value', async () => {
    // Reserved must not mean "ignored". Dropping it would leave an empty
    // allow-list that then looked unset, i.e. a fail-open on a value the docs
    // present as legitimate.
    await loadWith('bulk');
    expect(warnCalls()).toHaveLength(1);
    const errors = errorCalls();
    expect(errors).toHaveLength(1);
    expect(errors[0]![1]).toContain('bulk');
  });

  it('logs an ERROR when nothing in the allow-list enables a declared mode', async () => {
    await loadWith('frm');
    const errors = errorCalls();
    expect(errors).toHaveLength(1);
    // `configured`, not `enabled`: the enabled set is empty by construction in
    // this branch, and `fields.enabled` on the create-link 400 means the
    // enabled subset — the same key must not mean the opposite here.
    expect(errors[0]![0]).toMatchObject({ status: 'failure', configured: ['frm'] });
    expect(errors[0]![0]).not.toHaveProperty('enabled');
    // Loudly diagnosable: the message must name both what was configured and
    // what the network actually declares.
    expect(errors[0]![1]).toContain('frm');
    expect(errors[0]![1]).toContain('voice');
    expect(errors[0]![1]).toContain('form');
  });

  it('logs an ERROR when the var is set but names nothing', async () => {
    await loadWith(',,');
    expect(errorCalls()).toHaveLength(1);
  });

  it.each(['', '   ', '""'])(
    'logs an ERROR for a set-but-blank value rather than enabling everything (%j)',
    async (blank) => {
      // The blocking regression: these used to parse as "unset" — every mode
      // enabled, not one line of output.
      await loadWith(blank);
      expect(errorCalls()).toHaveLength(1);
    },
  );

  it('never rejects the load over a bad allow-list', async () => {
    // Log-only, exactly like the SIGNALS_UI_URLS check: an optional narrowing
    // knob must not be able to take the api down.
    await expect(loadWith('frm')).resolves.toBe(sampleConfig);
  });

  it('does not filter or rewrite the resolved config', async () => {
    await loadWith('form');
    const { getNetworkConfig } = await import('../network-config.js');
    const cfg = await getNetworkConfig();
    // The config singleton every other consumer reads — including the public
    // resolve path — keeps both declared modes. Filtering happens per response.
    expect(Object.keys(cfg.aggregator.registration_modes ?? {})).toEqual(['voice', 'form']);
  });
});
