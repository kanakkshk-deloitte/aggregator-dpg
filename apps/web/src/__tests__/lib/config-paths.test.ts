import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveSchemaRoot } from '@/lib/config-paths';

const ENV_KEYS = ['SCHEMA_ROOT_DIR', 'CONFIG_ROOT', 'AGGREGATOR_NETWORK', 'AGGREGATOR_BRAND'];

describe('resolveSchemaRoot', () => {
  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  it('honours an explicit SCHEMA_ROOT_DIR', () => {
    process.env.SCHEMA_ROOT_DIR = '/custom/schemas';
    expect(resolveSchemaRoot()).toBe('/custom/schemas');
  });

  it('trims whitespace on SCHEMA_ROOT_DIR', () => {
    process.env.SCHEMA_ROOT_DIR = '  /custom/schemas  ';
    expect(resolveSchemaRoot()).toBe('/custom/schemas');
  });

  it('treats an empty/whitespace SCHEMA_ROOT_DIR as unset', () => {
    process.env.SCHEMA_ROOT_DIR = '   ';
    process.env.CONFIG_ROOT = '/app/config';
    process.env.AGGREGATOR_NETWORK = 'blue_dot';
    expect(resolveSchemaRoot()).toBe(path.join('/app/config', 'blue_dot', 'schemas'));
  });

  it('derives from CONFIG_ROOT + AGGREGATOR_NETWORK when brand is unset', () => {
    process.env.CONFIG_ROOT = '/app/config';
    process.env.AGGREGATOR_NETWORK = 'blue_dot';
    expect(resolveSchemaRoot()).toBe(path.join('/app/config', 'blue_dot', 'schemas'));
  });

  it('appends AGGREGATOR_BRAND when set', () => {
    process.env.CONFIG_ROOT = '/app/config';
    process.env.AGGREGATOR_NETWORK = 'blue_dot';
    process.env.AGGREGATOR_BRAND = 'upsdm';
    expect(resolveSchemaRoot()).toBe(path.join('/app/config', 'blue_dot', 'upsdm', 'schemas'));
  });

  it('treats an empty/whitespace AGGREGATOR_BRAND as absent', () => {
    process.env.CONFIG_ROOT = '/app/config';
    process.env.AGGREGATOR_NETWORK = 'blue_dot';
    process.env.AGGREGATOR_BRAND = '   ';
    expect(resolveSchemaRoot()).toBe(path.join('/app/config', 'blue_dot', 'schemas'));
  });

  it('falls back to defaults when CONFIG_ROOT/AGGREGATOR_NETWORK are unset', () => {
    expect(resolveSchemaRoot()).toBe(path.join('/app/config', 'blue_dot', 'schemas'));
  });
});

// ─── Cross-package parity ────────────────────────────────────────────────────
// `aggregatorSchemaRelPaths` exists twice on purpose: apps/web deliberately does
// NOT depend on @aggregator-dpg/network-config, so the logic is mirrored rather
// than imported. Two hand-synced copies of routing logic drift silently, and a
// drift here means the API validates one schema file while the UI renders
// another. This test makes that drift loud without adding the dependency — it
// reads the sibling source off disk and compares the function bodies.
describe('aggregatorSchemaRelPaths parity with @aggregator-dpg/network-config', () => {
  /** Extracts a function body by name and strips comments + whitespace. */
  function normalisedBody(source: string, fnName: string): string {
    const start = source.indexOf(`export function ${fnName}(`);
    expect(start).toBeGreaterThan(-1);
    const open = source.indexOf('{', source.indexOf(')', start));
    let depth = 0;
    let end = open;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      if (source[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    return source
      .slice(open + 1, end)
      .replace(/\/\/[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  it('has a byte-equivalent body in both copies', () => {
    const webSrc = readFileSync(path.resolve(process.cwd(), 'src/lib/config-paths.ts'), 'utf8');
    const pkgSrc = readFileSync(
      path.resolve(process.cwd(), '../../packages/network-config/src/paths.ts'),
      'utf8',
    );
    const webBody = normalisedBody(webSrc, 'aggregatorSchemaRelPaths');
    // The package copy reads from an injected `env` bag; the web copy reads
    // `process.env` directly. Normalise that one deliberate difference away.
    const pkgBody = normalisedBody(pkgSrc, 'aggregatorSchemaRelPaths').replace(
      /\benv\./g,
      'process.env.',
    );
    expect(webBody).toBe(pkgBody);
  });
});
