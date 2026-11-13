import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError } from '@aggregator-dpg/shared-primitives/errors';
import { loadSignalsRealmRoles } from '../fs/signals-roles-loader.js';

let root: string;

/** Writes an aggregator.config.yaml for a network (and optional brand). */
async function writeConfig(network: string, body: string, brand?: string): Promise<void> {
  const dir = brand ? join(root, 'config', network, brand) : join(root, 'config', network);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'aggregator.config.yaml'), body, 'utf8');
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'signals-roles-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('loadSignalsRealmRoles', () => {
  it('reads a YAML sequence from the network config', async () => {
    await writeConfig(
      'blue_dot',
      'aggregator:\n  signals:\n    realm_roles: [signals_participant, signals_admin]\n',
    );
    expect(await loadSignalsRealmRoles('blue_dot', undefined, root)).toEqual([
      'signals_participant',
      'signals_admin',
    ]);
  });

  // The same value is expressible through the SIGNALS_REALM_ROLES override, so
  // an operator copying one shape into the other must not silently get nothing.
  it('accepts a comma-separated string as well as a sequence', async () => {
    await writeConfig(
      'blue_dot',
      'aggregator:\n  signals:\n    realm_roles: "signals_participant, signals_admin"\n',
    );
    expect(await loadSignalsRealmRoles('blue_dot', undefined, root)).toEqual([
      'signals_participant',
      'signals_admin',
    ]);
  });

  it('prefers the brand file over the network file', async () => {
    await writeConfig('blue_dot', 'aggregator:\n  signals:\n    realm_roles: [network_role]\n');
    await writeConfig(
      'blue_dot',
      'aggregator:\n  signals:\n    realm_roles: [brand_role]\n',
      'upsdm',
    );
    expect(await loadSignalsRealmRoles('blue_dot', 'upsdm', root)).toEqual(['brand_role']);
  });

  // A brand folder is a complete copy of its network folder, but a brand file
  // that omits the key should still fall through rather than report nothing.
  it('falls back to the network file when the brand omits the key', async () => {
    await writeConfig('blue_dot', 'aggregator:\n  signals:\n    realm_roles: [network_role]\n');
    await writeConfig('blue_dot', 'aggregator:\n  name: Branded\n', 'upsdm');
    expect(await loadSignalsRealmRoles('blue_dot', 'upsdm', root)).toEqual(['network_role']);
  });

  it('returns empty when the key is absent — unconfigured is not an error', async () => {
    await writeConfig('blue_dot', 'aggregator:\n  name: Blue Dots Aggregator\n');
    expect(await loadSignalsRealmRoles('blue_dot', undefined, root)).toEqual([]);
  });

  it('returns empty when no config file exists for the network', async () => {
    expect(await loadSignalsRealmRoles('no_such_dot', undefined, root)).toEqual([]);
  });

  it('drops blank entries rather than emitting empty role names', async () => {
    await writeConfig(
      'blue_dot',
      'aggregator:\n  signals:\n    realm_roles: "signals_participant, , "\n',
    );
    expect(await loadSignalsRealmRoles('blue_dot', undefined, root)).toEqual([
      'signals_participant',
    ]);
  });

  // A corrupt file is a real fault and must be distinguishable from "absent":
  // the caller logs the former and degrades, rather than treating both as empty.
  it('throws a typed ConfigError when the file cannot be parsed', async () => {
    await writeConfig('blue_dot', 'aggregator:\n  signals:\n    realm_roles: [unclosed\n');
    await expect(loadSignalsRealmRoles('blue_dot', undefined, root)).rejects.toBeInstanceOf(
      ConfigError,
    );
    await expect(loadSignalsRealmRoles('blue_dot', undefined, root)).rejects.toMatchObject({
      code: 'SIGNALS_ROLES_CONFIG_READ_ERROR',
    });
  });
});
