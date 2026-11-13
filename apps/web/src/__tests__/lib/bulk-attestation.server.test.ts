import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const loadConsentConfigMock = vi.fn();
vi.mock('@aggregator-dpg/config-loader/fs', () => ({
  loadConsentConfig: loadConsentConfigMock,
}));

const { loadBulkAttestation } = await import('@/lib/bulk-attestation.server');

const ENV_KEYS = ['AGGREGATOR_NETWORK', 'AGGREGATOR_BRAND'];

function cfgWithAttestation(overrides: Record<string, unknown> = {}) {
  return {
    audiences: {
      aggregator: {
        documents: {
          bulk_upload_attestation: {
            current_version: 2,
            versions: [
              { version: 1, title: 'Attestation v1', content: 'old copy' },
              { version: 2, title: 'Attestation v2', content: 'I attest the data is accurate' },
            ],
          },
          ...overrides,
        },
      },
    },
  };
}

describe('loadBulkAttestation', () => {
  beforeEach(() => {
    loadConsentConfigMock.mockReset();
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  it('defaults network to blue_dot and passes no brand when unset', async () => {
    loadConsentConfigMock.mockResolvedValue(cfgWithAttestation());
    await loadBulkAttestation();
    expect(loadConsentConfigMock).toHaveBeenCalledWith('blue_dot', undefined);
  });

  it('reads AGGREGATOR_NETWORK/AGGREGATOR_BRAND from env, trimmed', async () => {
    process.env.AGGREGATOR_NETWORK = '  yellow_dot  ';
    process.env.AGGREGATOR_BRAND = '  upsdm  ';
    loadConsentConfigMock.mockResolvedValue(cfgWithAttestation());
    await loadBulkAttestation();
    expect(loadConsentConfigMock).toHaveBeenCalledWith('yellow_dot', 'upsdm');
  });

  it('returns the current-version attestation content', async () => {
    loadConsentConfigMock.mockResolvedValue(cfgWithAttestation());
    const result = await loadBulkAttestation();
    expect(result).toEqual({
      version: 2,
      title: 'Attestation v2',
      content: 'I attest the data is accurate',
    });
  });

  it('falls back to the first version when current_version has no matching entry', async () => {
    loadConsentConfigMock.mockResolvedValue({
      audiences: {
        aggregator: {
          documents: {
            bulk_upload_attestation: {
              current_version: 99,
              versions: [{ version: 1, title: 'Only', content: 'only copy' }],
            },
          },
        },
      },
    });
    const result = await loadBulkAttestation();
    expect(result).toEqual({ version: 1, title: 'Only', content: 'only copy' });
  });

  it('returns null when the attestation document is absent', async () => {
    loadConsentConfigMock.mockResolvedValue({
      audiences: { aggregator: { documents: {} } },
    });
    await expect(loadBulkAttestation()).resolves.toBeNull();
  });

  it('returns null when the attestation document has no versions', async () => {
    loadConsentConfigMock.mockResolvedValue({
      audiences: {
        aggregator: {
          documents: { bulk_upload_attestation: { current_version: 1, versions: [] } },
        },
      },
    });
    await expect(loadBulkAttestation()).resolves.toBeNull();
  });

  it('returns null (never throws) when the config loader rejects', async () => {
    loadConsentConfigMock.mockRejectedValue(new Error('config not found'));
    await expect(loadBulkAttestation()).resolves.toBeNull();
  });
});
