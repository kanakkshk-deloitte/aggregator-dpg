/**
 * Unit tests for AggregatorConsentConfigSchema, parseAggregatorConsentConfig,
 * and loadConsentConfig.
 *
 * Uses real temp directories (node:fs + node:os) to exercise the filesystem
 * loader without touching the repository's actual config tree.
 *
 * @module @aggregator-dpg/config-loader/__tests__/consent
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigError } from '@aggregator-dpg/shared-primitives/errors';
import { parseAggregatorConsentConfig, type AggregatorConsentConfig } from '../consent.schema.js';
import { loadConsentConfig } from '../fs/consent-loader.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeDocVersion(version = 1) {
  return {
    version,
    title: 'Terms of Service',
    content: `## Terms v${version}`,
    effective_from: '2026-07-01',
  };
}

function makeAudience(termVersion = 1, privacyVersion = 1) {
  return {
    documents: {
      terms: {
        current_version: termVersion,
        versions: [makeDocVersion(termVersion)],
      },
      privacy: {
        current_version: privacyVersion,
        versions: [
          {
            version: privacyVersion,
            title: 'Privacy Policy',
            content: `## Privacy v${privacyVersion}`,
            effective_from: '2026-07-01',
          },
        ],
      },
    },
  };
}

function makeValidConfig(): AggregatorConsentConfig {
  return {
    audiences: {
      org: makeAudience(),
      aggregator: makeAudience(),
    },
  };
}

// ---------------------------------------------------------------------------
// Temp-dir utilities for loadConsentConfig tests
// ---------------------------------------------------------------------------

/**
 * Writes a default-valid consent.json into `<repoRoot>/config/<...prefix>/schemas/aggregator/`.
 * Pass no prefixes for the default fallback, or one or more path segments for
 * a network/brand-scoped file.
 */
function writeConsentFile(repoRoot: string, ...prefix: string[]) {
  const dir = join(repoRoot, 'config', ...prefix, 'schemas', 'aggregator');
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, 'consent.json');
  writeFileSync(filePath, JSON.stringify(makeValidConfig()), 'utf8');
  return filePath;
}

/**
 * Writes the supplied consent content into `<repoRoot>/config/<...prefix>/schemas/aggregator/consent.json`.
 */
function writeConsentFileContent(
  repoRoot: string,
  content: AggregatorConsentConfig,
  ...prefix: string[]
) {
  const dir = join(repoRoot, 'config', ...prefix, 'schemas', 'aggregator');
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, 'consent.json');
  writeFileSync(filePath, JSON.stringify(content), 'utf8');
  return filePath;
}

// ---------------------------------------------------------------------------
// Tests: parseAggregatorConsentConfig
// ---------------------------------------------------------------------------

describe('parseAggregatorConsentConfig', () => {
  it('accepts a valid config', () => {
    const config = parseAggregatorConsentConfig(makeValidConfig());
    expect(config.audiences.org.documents.terms.current_version).toBe(1);
    expect(config.audiences.aggregator.documents.privacy.current_version).toBe(1);
  });

  it('throws ConfigError when current_version is not in versions', () => {
    const raw = makeValidConfig();
    raw.audiences.org.documents.terms.current_version = 99;
    expect(() => parseAggregatorConsentConfig(raw)).toThrowError(ConfigError);
    expect(() => parseAggregatorConsentConfig(raw)).toThrowError(/current_version 99/);
  });

  it('throws ConfigError when version integers are duplicated', () => {
    const raw = makeValidConfig();
    raw.audiences.org.documents.terms.versions = [
      makeDocVersion(1),
      makeDocVersion(1), // duplicate
    ];
    expect(() => parseAggregatorConsentConfig(raw)).toThrowError(ConfigError);
    expect(() => parseAggregatorConsentConfig(raw)).toThrowError(/Duplicate version/);
  });

  it('throws ConfigError when the aggregator audience is missing', () => {
    const raw = {
      audiences: {
        org: makeAudience(),
        // aggregator omitted intentionally
      },
    };
    expect(() => parseAggregatorConsentConfig(raw)).toThrowError(ConfigError);
  });

  it('throws ConfigError when a privacy document is missing', () => {
    const raw = makeValidConfig();
    // Remove privacy from org audience
    const orgDocs = raw.audiences.org.documents as Partial<typeof raw.audiences.org.documents>;
    delete orgDocs.privacy;
    expect(() => parseAggregatorConsentConfig(raw)).toThrowError(ConfigError);
  });
});

// ---------------------------------------------------------------------------
// Tests: loadConsentConfig
// ---------------------------------------------------------------------------

describe('loadConsentConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `consent-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    // Create the default fallback so repo-root discovery succeeds
    writeConsentFile(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads and validates the network-specific consent file', async () => {
    writeConsentFile(tmpDir, 'blue_dot');
    const config = await loadConsentConfig('blue_dot', undefined, tmpDir);
    expect(config.audiences.org.documents.terms.current_version).toBe(1);
    expect(config.audiences.aggregator.documents.privacy.current_version).toBe(1);
  });

  it('renders the __SUPPORT_EMAIL__ placeholder to CONSENT_SUPPORT_EMAIL', async () => {
    const withPlaceholder = makeValidConfig();
    withPlaceholder.audiences.org.documents.terms.versions[0].content =
      'Grievances: __SUPPORT_EMAIL__';
    writeConsentFileContent(tmpDir, withPlaceholder, 'blue_dot');

    const prev = process.env.CONSENT_SUPPORT_EMAIL;
    process.env.CONSENT_SUPPORT_EMAIL = 'ops@example.test';
    try {
      const config = await loadConsentConfig('blue_dot', undefined, tmpDir);
      const content = config.audiences.org.documents.terms.versions[0].content;
      expect(content).toContain('ops@example.test');
      expect(content).not.toContain('__SUPPORT_EMAIL__');
    } finally {
      if (prev === undefined) delete process.env.CONSENT_SUPPORT_EMAIL;
      else process.env.CONSENT_SUPPORT_EMAIL = prev;
    }
  });

  it('defaults the support email to hello@bluedotseconomy.org when unset', async () => {
    const withPlaceholder = makeValidConfig();
    withPlaceholder.audiences.org.documents.terms.versions[0].content =
      'Grievances: __SUPPORT_EMAIL__';
    writeConsentFileContent(tmpDir, withPlaceholder, 'blue_dot');

    const prev = process.env.CONSENT_SUPPORT_EMAIL;
    delete process.env.CONSENT_SUPPORT_EMAIL;
    try {
      const config = await loadConsentConfig('blue_dot', undefined, tmpDir);
      expect(config.audiences.org.documents.terms.versions[0].content).toContain(
        'hello@bluedotseconomy.org',
      );
    } finally {
      if (prev !== undefined) process.env.CONSENT_SUPPORT_EMAIL = prev;
    }
  });

  it('falls back to the default consent file when network file is absent', async () => {
    // No network-specific file written; only default exists from beforeEach
    const config = await loadConsentConfig('nonexistent_network', undefined, tmpDir);
    expect(config.audiences.org.documents.terms.current_version).toBe(1);
  });

  it('merges brand override on top of the network consent', async () => {
    // Write network file with version 1
    writeConsentFile(tmpDir, 'orange_dot');

    // Write brand file with a different content for org.terms
    const brandConfig = makeValidConfig();
    brandConfig.audiences.org.documents.terms.versions[0].content = '## OneTAC Terms v1';
    writeConsentFileContent(tmpDir, brandConfig, 'orange_dot', 'onetac');

    const config = await loadConsentConfig('orange_dot', 'onetac', tmpDir);
    // Brand org terms content should win
    expect(config.audiences.org.documents.terms.versions[0].content).toBe('## OneTAC Terms v1');
    // Aggregator docs unchanged — came from network file
    expect(config.audiences.aggregator.documents.terms.versions[0].content).toBe(`## Terms v1`);
  });

  it('throws ConfigError when no consent file is found at all', async () => {
    // Remove the default file written in beforeEach
    rmSync(join(tmpDir, 'config'), { recursive: true, force: true });

    await expect(loadConsentConfig('missing_network', undefined, tmpDir)).rejects.toThrowError(
      ConfigError,
    );
  });

  it('merges a partial brand override (single audience only) onto the full network config', async () => {
    // Network file has both audiences with version 1 content
    writeConsentFile(tmpDir, 'blue_dot');

    // Brand file supplies ONLY the aggregator audience — org audience is absent.
    // This must merge cleanly rather than throwing a validation error on the
    // brand file itself (FIX-3: brand files are partial overrides, not full configs).
    const partialBrandContent = {
      audiences: {
        aggregator: {
          documents: {
            terms: {
              current_version: 1,
              versions: [
                {
                  version: 1,
                  title: 'UPSDM Terms of Service',
                  content: '## UPSDM-specific terms v1',
                  effective_from: '2026-07-01',
                },
              ],
            },
            privacy: {
              current_version: 1,
              versions: [
                {
                  version: 1,
                  title: 'UPSDM Privacy Policy',
                  content: '## UPSDM-specific privacy v1',
                  effective_from: '2026-07-01',
                },
              ],
            },
          },
        },
      },
    };

    const dir = join(tmpDir, 'config', 'blue_dot', 'upsdm', 'schemas', 'aggregator');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'consent.json'), JSON.stringify(partialBrandContent), 'utf8');

    const config = await loadConsentConfig('blue_dot', 'upsdm', tmpDir);

    // Brand aggregator content overrides the network
    expect(config.audiences.aggregator.documents.terms.title).toBeUndefined(); // title is on versions
    expect(config.audiences.aggregator.documents.terms.versions[0]?.title).toBe(
      'UPSDM Terms of Service',
    );
    expect(config.audiences.aggregator.documents.terms.versions[0]?.content).toBe(
      '## UPSDM-specific terms v1',
    );

    // Org audience came from the network file and is untouched
    expect(config.audiences.org.documents.terms.current_version).toBe(1);
    expect(config.audiences.org.documents.terms.versions[0]?.content).toBe('## Terms v1');
  });
});
