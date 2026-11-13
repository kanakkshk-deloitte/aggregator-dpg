/**
 * Unit tests for the registration-schema Ajv validator loader.
 *
 * Loads the real `config/schemas/aggregator/registration.v1.json` (no
 * filesystem mocking, matching the sibling `profile-validator.test.ts`
 * approach) but mocks `./network-config.js` so each test controls whether
 * the live network's domain ids are available to patch
 * `properties.type.enum` — covering the patch-applied, empty-ids,
 * network-config-unavailable (fallback), and caching paths.
 *
 * @module @aggregator-dpg/api
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockGetNetworkConfig } = vi.hoisted(() => ({
  mockGetNetworkConfig: vi.fn(),
}));

vi.mock('./network-config.js', () => ({
  getNetworkConfig: mockGetNetworkConfig,
}));

describe('getRegistrationValidator', () => {
  beforeEach(async () => {
    mockGetNetworkConfig.mockReset();
    const { _resetValidator } = await import('./registration-validator.js');
    _resetValidator();
  });

  it('patches properties.type.enum with the live network domain ids', async () => {
    mockGetNetworkConfig.mockResolvedValue({ domainIds: ['student', 'mentor'] });
    const { getRegistrationValidator } = await import('./registration-validator.js');
    const validate = await getRegistrationValidator();
    // A `type` of 'seeker' (the static schema default) should now be
    // rejected since the network only declares student/mentor.
    const rejects = validate({ type: 'seeker' });
    expect(rejects).toBe(false);
    const accepts = validate({ type: 'student' });
    // May still fail on other required fields, but not on `type`'s enum.
    if (!accepts) {
      const typeErrors = (validate.errors ?? []).filter((e) => e.instancePath === '/type');
      expect(typeErrors).toHaveLength(0);
    }
  });

  it('keeps the static schema enum when the network reports no domain ids', async () => {
    mockGetNetworkConfig.mockResolvedValue({ domainIds: [] });
    const { getRegistrationValidator } = await import('./registration-validator.js');
    const validate = await getRegistrationValidator();
    const errorsForSeeker = validate({ type: 'seeker' });
    // 'seeker' is in the static enum, so this should not fail on `/type`.
    if (!errorsForSeeker) {
      const typeErrors = (validate.errors ?? []).filter((e) => e.instancePath === '/type');
      expect(typeErrors).toHaveLength(0);
    }
  });

  it('falls back to the static schema when network-config is unavailable', async () => {
    mockGetNetworkConfig.mockRejectedValue(new Error('network-config load failed'));
    const { getRegistrationValidator } = await import('./registration-validator.js');
    const validate = await getRegistrationValidator();
    expect(typeof validate).toBe('function');
    // Registration stays open on cold boot: an otherwise-empty payload still
    // gets a validator back, just against the static default enum.
    const ok = validate({ type: 'seeker' });
    if (!ok) {
      const typeErrors = (validate.errors ?? []).filter((e) => e.instancePath === '/type');
      expect(typeErrors).toHaveLength(0);
    }
  });

  it('caches the compiled validator across calls (network-config read once)', async () => {
    mockGetNetworkConfig.mockResolvedValue({ domainIds: ['seeker'] });
    const { getRegistrationValidator } = await import('./registration-validator.js');
    const a = await getRegistrationValidator();
    const b = await getRegistrationValidator();
    expect(a).toBe(b);
    expect(mockGetNetworkConfig).toHaveBeenCalledTimes(1);
  });

  it('_resetValidator forces a fresh compile + network-config read', async () => {
    mockGetNetworkConfig.mockResolvedValue({ domainIds: ['seeker'] });
    const { getRegistrationValidator, _resetValidator } =
      await import('./registration-validator.js');
    const a = await getRegistrationValidator();
    _resetValidator();
    const b = await getRegistrationValidator();
    expect(a).not.toBe(b);
    expect(mockGetNetworkConfig).toHaveBeenCalledTimes(2);
  });
});

describe('getRegistrationValidator schema-not-found failure', () => {
  beforeEach(() => {
    vi.resetModules();
    mockGetNetworkConfig.mockReset();
    vi.doMock('node:fs', () => ({
      // schema-ref probes with existsSync; the validator still reads the file
      // with readFileSync once a candidate resolves.
      existsSync: () => false,
      readFileSync: () => {
        throw new Error('ENOENT');
      },
    }));
  });

  it('throws a descriptive error listing every candidate path tried', async () => {
    const { getRegistrationValidator: getFresh } = await import('./registration-validator.js');
    await expect(getFresh()).rejects.toThrow(/registration schema not found; tried:/);
    vi.doUnmock('node:fs');
  });
});
