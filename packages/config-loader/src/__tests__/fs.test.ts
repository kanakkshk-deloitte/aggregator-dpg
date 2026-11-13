import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FsConfigService } from '../fs/index.js';

/**
 * Builds a minimal repo root with a packages/ directory and optional env YAML.
 */
function makeRepo(
  root: string,
  opts: {
    envYaml?: string;
    env?: string;
    packages?: Array<{
      name: string;
      configKey: string;
      configDefaults?: Record<string, unknown>;
      defaultsYaml?: string;
    }>;
  } = {},
): void {
  const packagesDir = join(root, 'packages');
  mkdirSync(packagesDir, { recursive: true });

  const envDir = join(root, 'config', 'env');
  mkdirSync(envDir, { recursive: true });

  if (opts.envYaml !== undefined) {
    const envName = opts.env ?? 'test';
    writeFileSync(join(envDir, `${envName}.yaml`), opts.envYaml, 'utf8');
  }

  for (const pkg of opts.packages ?? []) {
    const pkgDir = join(packagesDir, pkg.name);
    const distDir = join(pkgDir, 'dist');
    mkdirSync(distDir, { recursive: true });
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: `@test/${pkg.name}` }),
      'utf8',
    );

    const defaultsLine =
      pkg.configDefaults !== undefined
        ? `export const configDefaults = ${JSON.stringify(pkg.configDefaults)};`
        : '';

    writeFileSync(
      join(distDir, 'config.schema.js'),
      [
        `export const configKey = ${JSON.stringify(pkg.configKey)};`,
        `export const configSchema = { parse: () => ({}) };`,
        defaultsLine,
      ].join('\n'),
      'utf8',
    );

    if (pkg.defaultsYaml !== undefined) {
      writeFileSync(join(pkgDir, 'config.defaults.yaml'), pkg.defaultsYaml, 'utf8');
    }
  }
}

describe('FsConfigService', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `fs-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads env YAML into the store', async () => {
    makeRepo(tmpDir, { envYaml: 'db:\n  host: prod-db\n', env: 'test' });
    const svc = new FsConfigService(tmpDir);
    await svc.load('test');
    expect(svc.get('db.host')).toBe('prod-db');
  });

  it('seeds per-package defaults before env YAML', async () => {
    makeRepo(tmpDir, {
      packages: [
        {
          name: 'pkg-a',
          configKey: 'pkgA',
          configDefaults: { timeout: 5000, url: 'http://default' },
        },
      ],
      envYaml: 'pkgA:\n  url: http://override\n',
      env: 'test',
    });
    const svc = new FsConfigService(tmpDir);
    await svc.load('test');
    // Env YAML overrides url but default timeout survives
    expect(svc.get('pkgA.url')).toBe('http://override');
    expect(svc.get('pkgA.timeout')).toBe(5000);
  });

  it('loads package config.defaults.yaml before env YAML', async () => {
    makeRepo(tmpDir, {
      packages: [
        {
          name: 'pkg-a',
          configKey: 'pkgA',
          defaultsYaml: 'pkgA:\n  timeout: 5000\n  url: http://default\n',
        },
      ],
      envYaml: 'pkgA:\n  url: http://override\n',
      env: 'test',
    });
    const svc = new FsConfigService(tmpDir);
    await svc.load('test');
    expect(svc.get('pkgA.timeout')).toBe(5000);
    expect(svc.get('pkgA.url')).toBe('http://override');
  });

  it('merges config.defaults.yaml over exported configDefaults', async () => {
    makeRepo(tmpDir, {
      packages: [
        {
          name: 'pkg-a',
          configKey: 'pkgA',
          configDefaults: { timeout: 1000, nested: { retries: 1, enabled: true } },
          defaultsYaml: 'pkgA:\n  timeout: 5000\n  nested:\n    retries: 3\n',
        },
      ],
    });
    const svc = new FsConfigService(tmpDir);
    await svc.load('test');
    expect(svc.get('pkgA.timeout')).toBe(5000);
    expect(svc.get('pkgA.nested.retries')).toBe(3);
    expect(svc.get('pkgA.nested.enabled')).toBe(true);
  });

  it('uses only defaults when no env YAML exists', async () => {
    makeRepo(tmpDir, {
      packages: [{ name: 'pkg-a', configKey: 'pkgA', configDefaults: { port: 8080 } }],
    });
    const svc = new FsConfigService(tmpDir);
    await svc.load('test');
    expect(svc.get('pkgA.port')).toBe(8080);
  });

  it('deep-merges nested defaults with nested env overrides', async () => {
    makeRepo(tmpDir, {
      packages: [
        {
          name: 'pkg-a',
          configKey: 'pkgA',
          configDefaults: { db: { host: 'localhost', port: 5432 } },
        },
      ],
      envYaml: 'pkgA:\n  db:\n    port: 5433\n',
      env: 'test',
    });
    const svc = new FsConfigService(tmpDir);
    await svc.load('test');
    expect(svc.get('pkgA.db.host')).toBe('localhost');
    expect(svc.get('pkgA.db.port')).toBe(5433);
  });

  it('get returns undefined for missing path', async () => {
    makeRepo(tmpDir);
    const svc = new FsConfigService(tmpDir);
    await svc.load('test');
    expect(svc.get('nonexistent')).toBeUndefined();
  });

  it('get returns undefined when an intermediate path segment is not an object', async () => {
    makeRepo(tmpDir, { envYaml: 'db: localhost\n', env: 'test' });
    const svc = new FsConfigService(tmpDir);
    await svc.load('test');
    expect(svc.get('db.host')).toBeUndefined();
  });

  it('require throws CONFIG_KEY_MISSING for absent path', async () => {
    makeRepo(tmpDir);
    const svc = new FsConfigService(tmpDir);
    await svc.load('test');
    expect(() => svc.require('missing')).toThrow('missing');
  });

  it('reload restores previous store on failure', async () => {
    makeRepo(tmpDir, { envYaml: 'key: value\n', env: 'test' });
    const svc = new FsConfigService(tmpDir);
    await svc.load('test');
    expect(svc.get('key')).toBe('value');

    // Remove the env file to force reload failure
    rmSync(join(tmpDir, 'config', 'env', 'test.yaml'));
    // Create an invalid YAML to cause a parse error
    writeFileSync(join(tmpDir, 'config', 'env', 'test.yaml'), ': invalid: yaml: [', 'utf8');

    await expect(svc.reload()).rejects.toThrow();
    // Store preserved from before reload
    expect(svc.get('key')).toBe('value');
  });

  it('reload notifies onChange listeners on success', async () => {
    makeRepo(tmpDir, { envYaml: 'x: 1\n', env: 'test' });
    const svc = new FsConfigService(tmpDir);
    await svc.load('test');

    let notified = false;
    svc.onChange(() => {
      notified = true;
    });
    await svc.reload();
    expect(notified).toBe(true);
  });

  it('getRegistry returns discovered packages after load', async () => {
    makeRepo(tmpDir, {
      packages: [{ name: 'pkg-a', configKey: 'pkgA' }],
    });
    const svc = new FsConfigService(tmpDir);
    await svc.load('test');
    expect(svc.getRegistry().has('pkgA')).toBe(true);
  });

  it('treats an empty env YAML file as an empty override (no throw)', async () => {
    makeRepo(tmpDir, { envYaml: '', env: 'test' });
    const svc = new FsConfigService(tmpDir);
    await svc.load('test');
    expect(svc.get('anything')).toBeUndefined();
  });

  it('throws CONFIG_PARSE_ERROR when env YAML is not a mapping', async () => {
    makeRepo(tmpDir, { envYaml: '- a\n- b\n', env: 'test' });
    const svc = new FsConfigService(tmpDir);
    await expect(svc.load('test')).rejects.toMatchObject({ code: 'CONFIG_PARSE_ERROR' });
  });

  it('throws CONFIG_PARSE_ERROR when a package config.defaults.yaml slice is not a mapping', async () => {
    makeRepo(tmpDir, {
      packages: [
        {
          name: 'pkg-a',
          configKey: 'pkgA',
          defaultsYaml: 'pkgA: "not-an-object"\n',
        },
      ],
    });
    const svc = new FsConfigService(tmpDir);
    await expect(svc.load('test')).rejects.toMatchObject({
      code: 'CONFIG_PARSE_ERROR',
      details: expect.objectContaining({ configKey: 'pkgA' }),
    });
  });

  it('slice returns the typed config slice for a registered key', async () => {
    makeRepo(tmpDir, {
      packages: [{ name: 'pkg-a', configKey: 'pkgA', configDefaults: { host: 'localhost' } }],
    });
    const svc = new FsConfigService(tmpDir);
    await svc.load('test');
    expect(svc.slice<{ host: string }>('pkgA')).toEqual({ host: 'localhost' });
  });

  it('slice throws CONFIG_KEY_MISSING for an unregistered key', async () => {
    makeRepo(tmpDir);
    const svc = new FsConfigService(tmpDir);
    await svc.load('test');
    expect(() => svc.slice('missing')).toThrow('missing');
  });

  it('require returns the value when the path exists', async () => {
    makeRepo(tmpDir, { envYaml: 'db:\n  host: prod-db\n', env: 'test' });
    const svc = new FsConfigService(tmpDir);
    await svc.load('test');
    expect(svc.require<string>('db.host')).toBe('prod-db');
  });

  it('reload throws CONFIG_NOT_LOADED when called before the initial load()', async () => {
    makeRepo(tmpDir);
    const svc = new FsConfigService(tmpDir);
    await expect(svc.reload()).rejects.toMatchObject({ code: 'CONFIG_NOT_LOADED' });
  });

  it('onChange unsubscribe stops further notifications', async () => {
    makeRepo(tmpDir, { envYaml: 'x: 1\n', env: 'test' });
    const svc = new FsConfigService(tmpDir);
    await svc.load('test');

    let notified = false;
    const unsubscribe = svc.onChange(() => {
      notified = true;
    });
    unsubscribe();
    await svc.reload();
    expect(notified).toBe(false);
  });

  describe('watch()', () => {
    let originalConfigWatch: string | undefined;

    beforeEach(() => {
      originalConfigWatch = process.env['CONFIG_WATCH'];
      delete process.env['CONFIG_WATCH'];
    });

    afterEach(() => {
      if (originalConfigWatch !== undefined) {
        process.env['CONFIG_WATCH'] = originalConfigWatch;
      } else {
        delete process.env['CONFIG_WATCH'];
      }
    });

    it('returns a no-op when CONFIG_WATCH is not set', async () => {
      makeRepo(tmpDir);
      const svc = new FsConfigService(tmpDir);
      await svc.load('test');
      const unsubscribe = svc.watch();
      expect(typeof unsubscribe).toBe('function');
      expect(() => unsubscribe()).not.toThrow();
    });

    it('returns a no-op when CONFIG_WATCH is not "1"', async () => {
      process.env['CONFIG_WATCH'] = '0';
      makeRepo(tmpDir);
      const svc = new FsConfigService(tmpDir);
      await svc.load('test');
      const unsubscribe = svc.watch();
      expect(() => unsubscribe()).not.toThrow();
    });

    it('returns a no-op and warns when env is production, even with CONFIG_WATCH=1', async () => {
      process.env['CONFIG_WATCH'] = '1';
      makeRepo(tmpDir);
      const svc = new FsConfigService(tmpDir);
      await svc.load('production');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const unsubscribe = svc.watch();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('production'));
      expect(() => unsubscribe()).not.toThrow();
      warnSpy.mockRestore();
    });

    it('starts a real watcher and logs when CONFIG_WATCH=1 outside production', async () => {
      process.env['CONFIG_WATCH'] = '1';
      makeRepo(tmpDir);
      const svc = new FsConfigService(tmpDir);
      await svc.load('test');
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
      const unsubscribe = svc.watch();
      try {
        expect(typeof unsubscribe).toBe('function');
        expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Watching'));
      } finally {
        unsubscribe();
        infoSpy.mockRestore();
      }
    });
  });
});
