import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { getTranslations } = vi.hoisted(() => ({ getTranslations: vi.fn() }));
vi.mock('next-intl/server', () => ({ getTranslations }));

const { loadConsentConfig } = vi.hoisted(() => ({ loadConsentConfig: vi.fn() }));
vi.mock('@aggregator-dpg/config-loader/fs', () => ({ loadConsentConfig }));

const labels: Record<string, string> = {
  audience_aggregator: 'For aggregators',
  audience_org: 'For organisations',
};

function t(key: string): string {
  return labels[key] ?? key;
}

const { loadLegalGroups } = await import('@/components/legal/load-legal-groups.server');

const aggregatorOrgConfig = {
  audiences: {
    aggregator: {
      documents: {
        terms: {
          current_version: 1,
          versions: [
            {
              version: 1,
              title: 'Terms of Service',
              content: '## Terms of Service',
              effective_from: '2026-07-01',
            },
          ],
        },
        privacy: {
          current_version: 1,
          versions: [
            {
              version: 1,
              title: 'Privacy Policy',
              content: '## Privacy Policy',
              effective_from: '2026-07-01',
            },
          ],
        },
      },
    },
    org: {
      documents: {
        terms: {
          current_version: 1,
          versions: [
            {
              version: 1,
              title: 'Terms of Service',
              content: '## Terms of Service',
              effective_from: '2026-07-01',
            },
          ],
        },
        privacy: {
          current_version: 1,
          versions: [
            {
              version: 1,
              title: 'Privacy Policy',
              content: '## Privacy Policy',
              effective_from: '2026-07-01',
            },
          ],
        },
      },
    },
  },
};

describe('loadLegalGroups', () => {
  beforeEach(() => {
    getTranslations.mockReset().mockResolvedValue(t);
    loadConsentConfig.mockReset();
  });

  afterEach(() => {
    delete process.env.AGGREGATOR_NETWORK;
    delete process.env.AGGREGATOR_BRAND;
  });

  it('returns the two operator audience groups, in aggregator then org order', async () => {
    loadConsentConfig.mockResolvedValue(aggregatorOrgConfig);

    const groups = await loadLegalGroups();

    expect(groups.map((g) => g.audience)).toEqual(['aggregator', 'org']);
    expect(groups[0]!.label).toBe('For aggregators');
    expect(groups[1]!.label).toBe('For organisations');
  });

  it('publishes no participant group — participants never register through this portal', async () => {
    // Their documents are shown inline by the public QR form's consent gate,
    // and their standing copy lives in the Signals portal. Publishing them here
    // put an audience that never visits at the top of an operator's page.
    loadConsentConfig.mockResolvedValue(aggregatorOrgConfig);

    const groups = await loadLegalGroups();

    expect(groups.map((g) => g.audience)).not.toContain('participant');
  });

  it('returns an empty array when the config fails to load', async () => {
    loadConsentConfig.mockRejectedValue(new Error('config missing'));

    const groups = await loadLegalGroups();

    expect(groups).toEqual([]);
  });

  it('carries the effective_from date through for aggregator/org documents', async () => {
    loadConsentConfig.mockResolvedValue(aggregatorOrgConfig);

    const groups = await loadLegalGroups();

    expect(groups[0]!.content.privacy.effective_from).toBe('2026-07-01');
  });

  it('reads network/brand from AGGREGATOR_NETWORK / AGGREGATOR_BRAND env vars', async () => {
    process.env.AGGREGATOR_NETWORK = 'orange_dot';
    process.env.AGGREGATOR_BRAND = 'onetac';
    loadConsentConfig.mockResolvedValue(aggregatorOrgConfig);

    await loadLegalGroups();

    expect(loadConsentConfig).toHaveBeenCalledWith('orange_dot', 'onetac');
  });
});
