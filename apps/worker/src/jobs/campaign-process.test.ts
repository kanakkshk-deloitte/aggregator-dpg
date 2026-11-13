/**
 * Unit tests for the campaign-process job wiring — builds the real
 * collaborators and delegates to `runCampaignJob`.
 *
 * @module @aggregator-dpg/worker
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const runCampaignJobMock = vi.fn();
const getWriterMock = vi.fn();
const sendMock = vi.fn();

vi.mock('../services/campaign-process/index.js', () => ({ runCampaignJob: runCampaignJobMock }));
vi.mock('../services/signalstack.js', () => ({ getSignalStackWriter: getWriterMock }));
vi.mock('@aggregator-dpg/mailer', () => ({ getMailer: () => ({ send: sendMock }) }));
vi.mock('../object-storage.js', () => ({
  putObject: vi.fn(),
  signExportDownloadUrl: vi.fn(),
}));
vi.mock('../logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));
vi.mock('../config.js', () => ({
  config: {
    CAMPAIGN_DECRYPT_CHUNK: 500,
    CAMPAIGN_EXPORT_FIELDS: 'contact',
    CAMPAIGN_EXPORT_RECIPIENT: 'network_admin',
    EXPORT_NETWORK_ADMIN_EMAIL: 'admin@network.example',
  },
}));

const { processCampaignJob } = await import('./campaign-process.js');

describe('processCampaignJob', () => {
  afterEach(() => vi.clearAllMocks());

  it('throws when the signalstack client is not configured', async () => {
    getWriterMock.mockReturnValue(null);
    await expect(processCampaignJob({ jobId: 'job-1' })).rejects.toThrow(/signalstack/i);
    expect(runCampaignJobMock).not.toHaveBeenCalled();
  });

  it('delegates to runCampaignJob with the client, collaborators, and config', async () => {
    getWriterMock.mockReturnValue({ fetchDecryptedProfiles: vi.fn() });
    runCampaignJobMock.mockResolvedValue(undefined);

    await processCampaignJob({ jobId: 'job-1' });

    expect(runCampaignJobMock).toHaveBeenCalledTimes(1);
    const [jobId, deps] = runCampaignJobMock.mock.calls[0]!;
    expect(jobId).toBe('job-1');
    expect(deps.config.decryptChunk).toBe(500);
    expect(deps.config.fieldSet).toBe('contact');
    expect(deps.config.recipientMode).toBe('network_admin');
    expect(deps.config.networkAdminEmail).toBe('admin@network.example');
    expect(typeof deps.export.fetchDecryptedProfiles).toBe('function');
    expect(typeof deps.client.getJobForProcessing).toBe('function');
    expect(typeof deps.voice.fetchDecryptedProfiles).toBe('function');
    // `provider` is a getter that defers to getVoiceProvider() — asserting the
    // descriptor exists (without invoking it) avoids tripping the
    // RAYA_API_KEY ConfigError this mocked config doesn't carry.
    expect(Object.getOwnPropertyDescriptor(deps.voice, 'provider')?.get).toBeInstanceOf(Function);
  });
});
