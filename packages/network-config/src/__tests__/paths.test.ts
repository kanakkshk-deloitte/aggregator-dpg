import { describe, it, expect } from 'vitest';
import {
  resolveConfigDir,
  resolveConfigPath,
  resolveSchemaRoot,
  resolveActiveNetwork,
  resolveNetworkSourceOverride,
} from '../paths.js';

describe('resolveConfigDir', () => {
  it('uses defaults when no env vars are set', () => {
    expect(resolveConfigDir({})).toBe('/app/config/blue_dot');
  });

  it('applies a custom AGGREGATOR_NETWORK', () => {
    expect(resolveConfigDir({ AGGREGATOR_NETWORK: 'orange_dot' })).toBe('/app/config/orange_dot');
  });

  it('appends brand when AGGREGATOR_BRAND is set', () => {
    expect(resolveConfigDir({ AGGREGATOR_NETWORK: 'blue_dot', AGGREGATOR_BRAND: 'upsdm' })).toBe(
      '/app/config/blue_dot/upsdm',
    );
  });

  it('treats empty AGGREGATOR_BRAND as absent (no brand suffix)', () => {
    expect(resolveConfigDir({ AGGREGATOR_NETWORK: 'blue_dot', AGGREGATOR_BRAND: '' })).toBe(
      '/app/config/blue_dot',
    );
  });

  it('treats whitespace-only AGGREGATOR_BRAND as absent', () => {
    expect(resolveConfigDir({ AGGREGATOR_NETWORK: 'blue_dot', AGGREGATOR_BRAND: '   ' })).toBe(
      '/app/config/blue_dot',
    );
  });

  it('respects a custom CONFIG_ROOT', () => {
    expect(resolveConfigDir({ CONFIG_ROOT: '/data/config', AGGREGATOR_NETWORK: 'blue_dot' })).toBe(
      '/data/config/blue_dot',
    );
  });

  it('respects CONFIG_ROOT + AGGREGATOR_BRAND together', () => {
    expect(
      resolveConfigDir({
        CONFIG_ROOT: '/mnt/cfg',
        AGGREGATOR_NETWORK: 'blue_dot',
        AGGREGATOR_BRAND: 'upsdm',
      }),
    ).toBe('/mnt/cfg/blue_dot/upsdm');
  });
});

describe('resolveConfigPath', () => {
  it('derives path from defaults when no env vars are set', () => {
    expect(resolveConfigPath({})).toBe('/app/config/blue_dot/aggregator.config.yaml');
  });

  it('derives path for network + brand', () => {
    expect(resolveConfigPath({ AGGREGATOR_NETWORK: 'blue_dot', AGGREGATOR_BRAND: 'upsdm' })).toBe(
      '/app/config/blue_dot/upsdm/aggregator.config.yaml',
    );
  });

  it('returns explicit AGGREGATOR_CONFIG_PATH override unchanged', () => {
    expect(
      resolveConfigPath({
        AGGREGATOR_CONFIG_PATH: '/custom/path/aggregator.config.yaml',
        AGGREGATOR_NETWORK: 'blue_dot',
        AGGREGATOR_BRAND: 'upsdm',
      }),
    ).toBe('/custom/path/aggregator.config.yaml');
  });

  it('ignores whitespace-only AGGREGATOR_CONFIG_PATH (falls through to derivation)', () => {
    expect(
      resolveConfigPath({ AGGREGATOR_CONFIG_PATH: '  ', AGGREGATOR_NETWORK: 'orange_dot' }),
    ).toBe('/app/config/orange_dot/aggregator.config.yaml');
  });
});

describe('resolveSchemaRoot', () => {
  it('derives schema root from defaults when no env vars are set', () => {
    expect(resolveSchemaRoot({})).toBe('/app/config/blue_dot/schemas');
  });

  it('derives schema root for network + brand', () => {
    expect(resolveSchemaRoot({ AGGREGATOR_NETWORK: 'blue_dot', AGGREGATOR_BRAND: 'upsdm' })).toBe(
      '/app/config/blue_dot/upsdm/schemas',
    );
  });

  it('returns explicit SCHEMA_ROOT_DIR override unchanged', () => {
    expect(
      resolveSchemaRoot({
        SCHEMA_ROOT_DIR: '/opt/schemas',
        AGGREGATOR_NETWORK: 'blue_dot',
        AGGREGATOR_BRAND: 'upsdm',
      }),
    ).toBe('/opt/schemas');
  });

  it('ignores whitespace-only SCHEMA_ROOT_DIR (falls through to derivation)', () => {
    expect(resolveSchemaRoot({ SCHEMA_ROOT_DIR: '  ', AGGREGATOR_NETWORK: 'orange_dot' })).toBe(
      '/app/config/orange_dot/schemas',
    );
  });

  it('respects a custom CONFIG_ROOT', () => {
    expect(resolveSchemaRoot({ CONFIG_ROOT: '/data/config', AGGREGATOR_NETWORK: 'blue_dot' })).toBe(
      '/data/config/blue_dot/schemas',
    );
  });
});

describe('resolveActiveNetwork', () => {
  it('returns default network blue_dot when no env vars are set', () => {
    const result = resolveActiveNetwork({});
    expect(result.network).toBe('blue_dot');
    expect(result.brand).toBeUndefined();
  });

  it('returns the configured AGGREGATOR_NETWORK', () => {
    const result = resolveActiveNetwork({ AGGREGATOR_NETWORK: 'orange_dot' });
    expect(result.network).toBe('orange_dot');
    expect(result.brand).toBeUndefined();
  });

  it('returns brand when AGGREGATOR_BRAND is set', () => {
    const result = resolveActiveNetwork({
      AGGREGATOR_NETWORK: 'blue_dot',
      AGGREGATOR_BRAND: 'upsdm',
    });
    expect(result.network).toBe('blue_dot');
    expect(result.brand).toBe('upsdm');
  });

  it('trims whitespace from network and brand', () => {
    const result = resolveActiveNetwork({
      AGGREGATOR_NETWORK: '  blue_dot  ',
      AGGREGATOR_BRAND: '  onetac  ',
    });
    expect(result.network).toBe('blue_dot');
    expect(result.brand).toBe('onetac');
  });

  it('treats empty AGGREGATOR_BRAND as absent (undefined)', () => {
    const result = resolveActiveNetwork({ AGGREGATOR_NETWORK: 'blue_dot', AGGREGATOR_BRAND: '' });
    expect(result.brand).toBeUndefined();
  });

  it('treats whitespace-only AGGREGATOR_BRAND as absent (undefined)', () => {
    const result = resolveActiveNetwork({
      AGGREGATOR_NETWORK: 'blue_dot',
      AGGREGATOR_BRAND: '   ',
    });
    expect(result.brand).toBeUndefined();
  });

  it('network default matches the single-sourced default in resolveConfigDir', () => {
    // Both helpers should use the same default so a deployment with no env vars
    // records consent for the same network/brand the web layer would display.
    const { network } = resolveActiveNetwork({});
    const dir = resolveConfigDir({});
    expect(dir).toContain(network);
  });
});

describe('resolveNetworkSourceOverride', () => {
  it('returns the trimmed URL when AGGREGATOR_NETWORK_SOURCE is set', () => {
    const url = resolveNetworkSourceOverride({
      AGGREGATOR_NETWORK_SOURCE: ' https://schemas.example.org/blue_dot/network.json ',
    });
    expect(url).toBe('https://schemas.example.org/blue_dot/network.json');
  });

  it('returns undefined when unset', () => {
    expect(resolveNetworkSourceOverride({})).toBeUndefined();
  });

  it('treats empty and whitespace-only values as absent', () => {
    expect(resolveNetworkSourceOverride({ AGGREGATOR_NETWORK_SOURCE: '' })).toBeUndefined();
    expect(resolveNetworkSourceOverride({ AGGREGATOR_NETWORK_SOURCE: '   ' })).toBeUndefined();
  });
});
