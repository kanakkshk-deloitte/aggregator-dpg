import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const loadSignalsRealmRolesMock = vi.fn();
vi.mock('@aggregator-dpg/config-loader/fs', () => ({
  loadSignalsRealmRoles: loadSignalsRealmRolesMock,
}));
const warnMock = vi.fn();
vi.mock('@/lib/logger', () => ({ logger: { warn: warnMock, info: vi.fn(), error: vi.fn() } }));

const { resolveSignalsRealmRoles, resetSignalsRealmRolesCache } =
  await import('@/lib/signals-roles');

const ENV_KEYS = ['SIGNALS_REALM_ROLES', 'AGGREGATOR_NETWORK', 'AGGREGATOR_BRAND', 'CONFIG_ROOT'];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  loadSignalsRealmRolesMock.mockReset();
  warnMock.mockReset();
  resetSignalsRealmRolesCache();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('resolveSignalsRealmRoles', () => {
  // Config is the source of truth precisely because it ships with the repo and
  // reaches a cluster without a chart change.
  it('reads the active network/brand config when no env override is set', async () => {
    loadSignalsRealmRolesMock.mockResolvedValue(['signals_participant']);
    process.env.AGGREGATOR_NETWORK = 'purple_dot';
    process.env.AGGREGATOR_BRAND = 'alimco';
    process.env.CONFIG_ROOT = '/app/config-root';

    expect(await resolveSignalsRealmRoles()).toEqual(['signals_participant']);
    expect(loadSignalsRealmRolesMock).toHaveBeenCalledWith(
      'purple_dot',
      'alimco',
      '/app/config-root',
    );
  });

  it('defaults the network and omits an empty brand', async () => {
    loadSignalsRealmRolesMock.mockResolvedValue([]);
    process.env.AGGREGATOR_BRAND = '   ';

    await resolveSignalsRealmRoles();
    expect(loadSignalsRealmRolesMock).toHaveBeenCalledWith('blue_dot', undefined, undefined);
  });

  it('lets the env override win without reading config at all', async () => {
    process.env.SIGNALS_REALM_ROLES = 'override_role';

    expect(await resolveSignalsRealmRoles()).toEqual(['override_role']);
    expect(loadSignalsRealmRolesMock).not.toHaveBeenCalled();
  });

  it('splits and trims the env override, ignoring blank entries', async () => {
    process.env.SIGNALS_REALM_ROLES = ' a , , b ';

    expect(await resolveSignalsRealmRoles()).toEqual(['a', 'b']);
  });

  // A corrupt config must not take the login page down: the whole value of this
  // list is choosing a sentence.
  it('logs and degrades to empty when the config read throws', async () => {
    loadSignalsRealmRolesMock.mockRejectedValue(new Error('bad yaml'));

    expect(await resolveSignalsRealmRoles()).toEqual([]);
    expect(warnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'signalsRealmRoles.loadFromConfig',
        status: 'failure',
        error: 'bad yaml',
      }),
    );
  });

  // configuration-discipline.md: never re-read config inside a request path.
  it('reads config once per process and serves later calls from cache', async () => {
    loadSignalsRealmRolesMock.mockResolvedValue(['signals_participant']);

    await resolveSignalsRealmRoles();
    await resolveSignalsRealmRoles();
    await resolveSignalsRealmRoles();
    expect(loadSignalsRealmRolesMock).toHaveBeenCalledTimes(1);
  });
});
