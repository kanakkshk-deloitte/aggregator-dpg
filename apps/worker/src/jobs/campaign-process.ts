/**
 * `campaign-process` job processor in `@aggregator-dpg/worker`.
 *
 * Builds the real collaborators (job DB client, Signals, S3, mailer, voice
 * provider) and calls `runCampaignJob`. Throws if Signals is not configured.
 */
import type { CampaignProcessJob } from '@aggregator-dpg/queue';
import { getMailer } from '@aggregator-dpg/mailer';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { getSignalStackWriter } from '../services/signalstack.js';
import { getVoiceProvider } from '../services/voice-provider.js';
import { getCampaignAuditWriter } from '../services/campaign-audit.js';
import { putObject, signExportDownloadUrl } from '../object-storage.js';
import * as jobClient from '../services/campaign-job-client.js';
import { runCampaignJob } from '../services/campaign-process/index.js';

/** Where this run sits in BullMQ's retry sequence. */
export interface CampaignAttempt {
  /** 1-based attempt number for this run. */
  attempt: number;
  /** Total attempts BullMQ will make before giving up. */
  maxAttempts: number;
}

/**
 * Default retry position: a single, final attempt.
 */
const SINGLE_ATTEMPT: CampaignAttempt = { attempt: 1, maxAttempts: 1 };

/**
 * Runs one campaign-process job.
 *
 * @param data - The enqueued payload — just the `campaign_job.id`.
 * @param attempt - Retry position, so the last attempt can mark the job failed.
 */
export async function processCampaignJob(
  data: CampaignProcessJob,
  attempt: CampaignAttempt = SINGLE_ATTEMPT,
): Promise<void> {
  const log = logger.child({ operation: 'campaign.process', job_id: data.jobId });
  const ss = getSignalStackWriter();
  if (!ss) {
    log.error({ status: 'failure', step: 'config', reason: 'signalstack_not_configured' });
    throw new Error('signalstack client not configured');
  }

  await runCampaignJob(data.jobId, {
    client: jobClient,
    export: {
      fetchDecryptedProfiles: (q) => ss.fetchDecryptedProfiles(q),
      putObject,
      signDownloadUrl: signExportDownloadUrl,
      sendMail: (input) => getMailer().send(input),
    },
    voice: {
      fetchDecryptedProfiles: (q) => ss.fetchDecryptedProfiles(q),
      // A getter, because getVoiceProvider() throws when RAYA_API_KEY is
      // unset. Export and email jobs never read it.
      get provider() {
        return getVoiceProvider();
      },
    },
    email: {
      fetchDecryptedProfiles: (q) => ss.fetchDecryptedProfiles(q),
      sendMail: (input) => getMailer().send(input),
    },
    config: {
      decryptChunk: config.CAMPAIGN_DECRYPT_CHUNK,
      fieldSet: config.CAMPAIGN_EXPORT_FIELDS,
      recipientMode: config.CAMPAIGN_EXPORT_RECIPIENT,
      emailSendConcurrency: config.EMAIL_SEND_CONCURRENCY,
      ...(config.EXPORT_NETWORK_ADMIN_EMAIL
        ? { networkAdminEmail: config.EXPORT_NETWORK_ADMIN_EMAIL }
        : {}),
    },
    log,
    attempt,
    audit: getCampaignAuditWriter(),
  });
}
