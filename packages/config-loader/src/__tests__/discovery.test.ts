import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverPackages } from '../discovery.js';
import { ConfigError } from '@aggregator-dpg/shared-primitives/errors';

/**
 * Creates a package that ships only src/config.schema.ts (no dist build),
 * exercising the dev-mode (tsx) import fallback in importConfigModule.
 */
function makeSrcOnlyPackage(root: string, dirName: string, configKeyValue: string): void {
  const pkgDir = join(root, dirName);
  const srcDir = join(pkgDir, 'src');
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: `@test/${dirName}` }), 'utf8');
  writeFileSync(
    join(srcDir, 'config.schema.ts'),
    `export const configKey = ${JSON.stringify(configKeyValue)};\nexport const configSchema = { parse: () => ({}) };\n`,
    'utf8',
  );
}

/**
 * Creates a minimal package with a dist/config.schema.js in a temp directory.
 * Writes raw JS so no build step is needed in tests.
 */
function makePackage(
  root: string,
  dirName: string,
  opts: {
    configKey?: string;
    omitConfigKey?: boolean;
    omitSchema?: boolean;
    configDefaults?: Record<string, unknown>;
  },
): void {
  const pkgDir = join(root, dirName);
  const distDir = join(pkgDir, 'dist');
  mkdirSync(distDir, { recursive: true });

  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: `@test/${dirName}` }), 'utf8');

  // Write a plain-JS module — no Zod needed; discovery only checks presence
  const keyLine = opts.omitConfigKey
    ? ''
    : `export const configKey = ${JSON.stringify(opts.configKey ?? dirName)};`;
  const schemaLine = opts.omitSchema ? '' : `export const configSchema = { parse: () => ({}) };`;
  const defaultsLine =
    opts.configDefaults !== undefined
      ? `export const configDefaults = ${JSON.stringify(opts.configDefaults)};`
      : '';

  writeFileSync(
    join(distDir, 'config.schema.js'),
    `${keyLine}\n${schemaLine}\n${defaultsLine}\n`,
    'utf8',
  );
}

describe('discoverPackages', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `discovery-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty map when packagesDir does not exist', async () => {
    const result = await discoverPackages(join(tmpDir, 'nonexistent'));
    expect(result.size).toBe(0);
  });

  it('skips a package directory that has no package.json', async () => {
    const dir = join(tmpDir, 'no-package-json');
    mkdirSync(dir);
    const result = await discoverPackages(tmpDir);
    expect(result.size).toBe(0);
  });

  it('returns empty map when no packages have config.schema', async () => {
    const dir = join(tmpDir, 'no-schema');
    mkdirSync(dir);
    writeFileSync(join(dir, 'package.json'), '{"name":"@test/no-schema"}');
    const result = await discoverPackages(tmpDir);
    expect(result.size).toBe(0);
  });

  it('discovers a valid package', async () => {
    makePackage(tmpDir, 'pkg-a', { configKey: 'pkgA' });
    const result = await discoverPackages(tmpDir);
    expect(result.has('pkgA')).toBe(true);
    expect(result.get('pkgA')?.packageName).toBe('@test/pkg-a');
  });

  it('discovers multiple valid packages', async () => {
    makePackage(tmpDir, 'pkg-a', { configKey: 'pkgA' });
    makePackage(tmpDir, 'pkg-b', { configKey: 'pkgB' });
    const result = await discoverPackages(tmpDir);
    expect(result.size).toBe(2);
    expect(result.has('pkgA')).toBe(true);
    expect(result.has('pkgB')).toBe(true);
  });

  it('throws CONFIG_DUPLICATE_KEY when two packages share a configKey', async () => {
    makePackage(tmpDir, 'pkg-a', { configKey: 'shared' });
    makePackage(tmpDir, 'pkg-b', { configKey: 'shared' });
    await expect(discoverPackages(tmpDir)).rejects.toThrow(ConfigError);
    await expect(discoverPackages(tmpDir)).rejects.toMatchObject({ code: 'CONFIG_DUPLICATE_KEY' });
  });

  it('throws CONFIG_MISSING_KEY when configKey export is absent', async () => {
    makePackage(tmpDir, 'pkg-a', { omitConfigKey: true });
    await expect(discoverPackages(tmpDir)).rejects.toThrow(ConfigError);
    await expect(discoverPackages(tmpDir)).rejects.toMatchObject({ code: 'CONFIG_MISSING_KEY' });
  });

  it('throws CONFIG_MISSING_SCHEMA when configSchema export is absent', async () => {
    makePackage(tmpDir, 'pkg-a', { configKey: 'pkgA', omitSchema: true });
    await expect(discoverPackages(tmpDir)).rejects.toThrow(ConfigError);
    await expect(discoverPackages(tmpDir)).rejects.toMatchObject({ code: 'CONFIG_MISSING_SCHEMA' });
  });

  it('skips non-directory entries in packagesDir', async () => {
    writeFileSync(join(tmpDir, 'not-a-dir.txt'), 'content');
    makePackage(tmpDir, 'valid-pkg', { configKey: 'valid' });
    const result = await discoverPackages(tmpDir);
    expect(result.size).toBe(1);
  });

  it('collects configDefaults when exported', async () => {
    makePackage(tmpDir, 'pkg-a', {
      configKey: 'pkgA',
      configDefaults: { timeout: 5000, nested: { retries: 3 } },
    });
    const result = await discoverPackages(tmpDir);
    expect(result.get('pkgA')?.configDefaults).toEqual({ timeout: 5000, nested: { retries: 3 } });
  });

  it('stores undefined configDefaults when export is absent', async () => {
    makePackage(tmpDir, 'pkg-a', { configKey: 'pkgA' });
    const result = await discoverPackages(tmpDir);
    expect(result.get('pkgA')?.configDefaults).toBeUndefined();
  });

  it('ignores non-object configDefaults (array)', async () => {
    makePackage(tmpDir, 'pkg-a', { configKey: 'pkgA' });
    // Manually write an array as configDefaults
    const distPath = join(tmpDir, 'pkg-a', 'dist', 'config.schema.js');
    writeFileSync(
      distPath,
      `export const configKey = 'pkgA';\nexport const configSchema = { parse: () => ({}) };\nexport const configDefaults = [1, 2, 3];\n`,
      'utf8',
    );
    const result = await discoverPackages(tmpDir);
    expect(result.get('pkgA')?.configDefaults).toBeUndefined();
  });

  it('falls back to src/config.schema.ts when no dist build exists', async () => {
    makeSrcOnlyPackage(tmpDir, 'pkg-src', 'pkgSrc');
    const result = await discoverPackages(tmpDir);
    expect(result.has('pkgSrc')).toBe(true);
    expect(result.get('pkgSrc')?.packageName).toBe('@test/pkg-src');
  });

  it('falls back to the directory name when package.json is malformed JSON', async () => {
    makePackage(tmpDir, 'pkg-a', { configKey: 'pkgA' });
    writeFileSync(join(tmpDir, 'pkg-a', 'package.json'), '{ not valid json', 'utf8');
    const result = await discoverPackages(tmpDir);
    expect(result.get('pkgA')?.packageName).toBe('pkg-a');
  });

  it('falls back to the directory name when package.json has no "name" field', async () => {
    makePackage(tmpDir, 'pkg-a', { configKey: 'pkgA' });
    writeFileSync(
      join(tmpDir, 'pkg-a', 'package.json'),
      JSON.stringify({ version: '1.0.0' }),
      'utf8',
    );
    const result = await discoverPackages(tmpDir);
    expect(result.get('pkgA')?.packageName).toBe('pkg-a');
  });

  it('skips entries whose stat() throws (e.g. a broken symlink)', async () => {
    symlinkSync(join(tmpDir, 'nonexistent-target'), join(tmpDir, 'broken-link'));
    makePackage(tmpDir, 'valid-pkg', { configKey: 'valid' });
    const result = await discoverPackages(tmpDir);
    expect(result.size).toBe(1);
    expect(result.has('valid')).toBe(true);
  });
});
