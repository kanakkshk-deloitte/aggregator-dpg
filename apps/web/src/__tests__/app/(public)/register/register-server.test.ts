/**
 * Unit tests for the shared registration server helpers (#619):
 * `loadConsentContent`, `loadOrgSchema`.
 *
 * The page tests mock this module, so its function bodies are exercised
 * directly here — deps (config-loader, fs, schema-path resolver, logger) are
 * mocked so no real I/O happens.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { loadConsentConfig } = vi.hoisted(() => ({ loadConsentConfig: vi.fn() }));
const { readFile } = vi.hoisted(() => ({ readFile: vi.fn() }));
const { resolveAggregatorSchemaPath } = vi.hoisted(() => ({
  resolveAggregatorSchemaPath: vi.fn((file: string) => `/config/aggregator/${file}`),
}));
const { loggerWarn } = vi.hoisted(() => ({ loggerWarn: vi.fn() }));

vi.mock('@aggregator-dpg/config-loader/fs', () => ({ loadConsentConfig }));
vi.mock('node:fs/promises', () => ({ readFile, default: { readFile } }));
vi.mock('@/lib/aggregator-schema.server', () => ({ resolveAggregatorSchemaPath }));
vi.mock('@/lib/logger', () => ({ logger: { warn: loggerWarn, error: vi.fn(), info: vi.fn() } }));

import { loadConsentContent, loadOrgSchema } from '@/app/(public)/register/register-server';

function consentCfg() {
  const doc = (title: string, content: string) => ({
    current_version: 1,
    versions: [{ version: 1, title, content, effective_from: '2024-01-01' }],
  });
  return {
    audiences: {
      aggregator: { documents: { terms: doc('AT', 'a-terms'), privacy: doc('AP', 'a-priv') } },
      org: { documents: { terms: doc('OT', 'o-terms'), privacy: doc('OP', 'o-priv') } },
    },
  };
}

describe('loadConsentContent', () => {
  beforeEach(() => {
    loadConsentConfig.mockReset();
    loggerWarn.mockReset();
  });

  it('returns current-version aggregator + org docs on success', async () => {
    loadConsentConfig.mockResolvedValue(consentCfg());
    const out = await loadConsentContent();
    expect(out).toEqual({
      aggregator: {
        terms: { version: 1, title: 'AT', content: 'a-terms' },
        privacy: { version: 1, title: 'AP', content: 'a-priv' },
      },
      org: {
        terms: { version: 1, title: 'OT', content: 'o-terms' },
        privacy: { version: 1, title: 'OP', content: 'o-priv' },
      },
    });
  });

  it('returns null + warns when the config load throws', async () => {
    loadConsentConfig.mockRejectedValue(new Error('missing file'));
    expect(await loadConsentContent()).toBeNull();
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'loadConsentContent', status: 'failure' }),
    );
  });

  it('returns null when current_version has no matching version entry', async () => {
    loadConsentConfig.mockResolvedValue({
      audiences: {
        aggregator: {
          documents: {
            terms: { current_version: 9, versions: [{ version: 1, title: 'T', content: 'c' }] },
            privacy: { current_version: 1, versions: [{ version: 1, title: 'P', content: 'p' }] },
          },
        },
        org: { documents: { terms: { current_version: 1, versions: [] }, privacy: {} } },
      },
    });
    expect(await loadConsentContent()).toBeNull();
    expect(loggerWarn).toHaveBeenCalled();
  });
});

describe('loadOrgSchema', () => {
  beforeEach(() => {
    readFile.mockReset();
  });

  it('returns the parsed schema + ui schema when both files read', async () => {
    readFile.mockImplementation((p: string) =>
      p.includes('.ui.json')
        ? Promise.resolve('{"ui:order":["name"]}')
        : Promise.resolve('{"title":"Org","properties":{}}'),
    );
    const out = await loadOrgSchema();
    expect(out).toEqual({
      schema: { title: 'Org', properties: {} },
      uiSchema: { 'ui:order': ['name'] },
    });
  });

  it('returns null when a schema file is missing', async () => {
    readFile.mockRejectedValue(new Error('ENOENT'));
    expect(await loadOrgSchema()).toBeNull();
  });
});
